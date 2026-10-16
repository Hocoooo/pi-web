import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { normalizeContext, type Message, type Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/google-generative-ai";
import { convertMessages } from "@earendil-works/pi-ai/api/google-shared";
import { providerHeadersToRecord } from "@earendil-works/pi-ai/utils/headers";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed } from "./file-access";
import type { AgentSessionLike } from "./pi-types";
import { createVideoInputBinding, type VideoSubmission } from "./video-input-binding";
import {
  assertVideoModel, MAX_VIDEO_FILE_BYTES, MAX_VIDEO_REQUEST_BYTES, parseVideoReferences, parseVideoAttachment,
  VIDEO_GOOGLE_BASE_URL, VIDEO_REQUEST_ENVELOPE_BYTES, type VideoReference, type VideoAttachment,
} from "./video-attachments";

type GoogleContent = ReturnType<typeof convertMessages>[number];
// The native adapter's onPayload receives SDK params, before wire conversion.
type GoogleParams = { model: string; contents: GoogleContent[]; config?: { httpOptions?: unknown; [key: string]: unknown } };
type VideoOwner = { role: string; piWebVideos?: VideoAttachment[]; toolName?: string; isError?: boolean; details?: { piWebVideos?: VideoAttachment[] } };
type PromptOptions = NonNullable<Parameters<AgentSessionLike["prompt"]>[1]>;

function sameReference(left: VideoAttachment, right: VideoAttachment): boolean {
  return left.id === right.id && left.version === right.version && left.path === right.path && left.mimeType === right.mimeType;
}

/** Read the current file, never a path mentioned in text. No session-reference exception. */
export async function readVideo(ref: VideoReference, cwd: string): Promise<Buffer> {
  if (!path.isAbsolute(ref.path)) throw new Error("Video reference must have an absolute path.");
  const roots = new Set(await getAllowedFileRoots());
  roots.add(cwd); // Includes a new session's not-yet-flushed cwd, already authorized at startup.
  if (!isFilePathAllowed(ref.path, roots) || !isExistingFilePathAllowed(ref.path, roots)) {
    throw new Error("Video file is missing or outside the allowed file roots (including link targets).");
  }
  const canonical = await realpath(ref.path);
  const file = await open(canonical, constants.O_RDONLY | (constants.O_NONBLOCK || 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("Video must be a readable regular file.");
    if (stat.size > MAX_VIDEO_FILE_BYTES) throw new Error("Video exceeds the 20 MiB application file limit.");
    const chunks: Buffer[] = [];
    let length = 0;
    while (length <= MAX_VIDEO_FILE_BYTES) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_VIDEO_FILE_BYTES + 1 - length));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      length += bytesRead;
      chunks.push(chunk.subarray(0, bytesRead));
    }
    if (length > MAX_VIDEO_FILE_BYTES) throw new Error("Video exceeds the 20 MiB application file limit.");
    const bytes = Buffer.concat(chunks, length);
    const valid = ref.mimeType === "video/mp4"
      ? bytes.length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp"
        && bytes.readUInt32BE(0) >= 12 && bytes.readUInt32BE(0) <= bytes.length
      : bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "AVI ";
    if (!valid) throw new Error("Video bytes do not match the MP4/AVI container and MIME type. No conversion is performed.");
    return bytes;
  } finally {
    await file.close();
  }
}

function referencesOf(message: VideoOwner): VideoAttachment[] {
  const values = message.role === "user" ? message.piWebVideos
    : message.role === "toolResult" && message.toolName === "read_video" && !message.isError
      ? message.details?.piWebVideos : undefined;
  return values?.map(parseVideoAttachment) ?? [];
}

function owners(messages: readonly { role: string }[]) {
  return messages.flatMap((message, index) => referencesOf(message as VideoOwner)
    .map(ref => ({ message: message as VideoOwner, ref, index })));
}

/**
 * One application-side seam for normal AND Chat-only sessions. Non-video calls
 * retain the original SDK stream function. Video calls resolve SDK auth before
 * using the native Google adapter; there is no separate analysis conversation.
 */
export function createVideoTransport(session: AgentSessionLike) {
  let active: VideoSubmission | undefined;
  let compacting = false;
  const binding = createVideoInputBinding(session);
  const cwd = () => session.sessionManager.getCwd();
  return {
    queue: binding,
    observe(event: { type: string; message?: unknown; result?: unknown; aborted?: unknown; errorMessage?: unknown }): void {
      binding.observe(event);
      if (event.type === "compaction_start") compacting = true;
      if (event.type === "compaction_end") {
        compacting = false;
        if (event.result && !event.aborted && !event.errorMessage && active?.bound) {
          const remaining = owners(session.sessionManager.buildSessionProjection().messages);
          active.compactedOut = !active.refs.some(ref => remaining.some(owner => owner.ref.id === ref.id));
        }
      }
      // Public listeners run before SDK appendMessage. Bind only after THIS
      // prompt's "started" preflight, never an extension/preflight/queued input.
      const message = event.message as VideoOwner | undefined;
      if (event.type === "message_end" && message?.role === "user" && active?.armed && !active.bound) {
        message.piWebVideos = active.refs.map(ref => ({ ...ref }));
        active.bound = true;
      }
    },
    wrapConversion(original: NonNullable<AgentSessionLike["agent"]["convertToLlm"]>) {
      return async (messages: Parameters<typeof original>[0]) => {
        const references = owners(messages);
        const converted = await original(messages);
        for (const { message, ref } of references) {
          if (!converted.includes(message as Message) || !referencesOf(message).some(value => sameReference(value, ref))) {
            throw new Error("The message converter replaced, removed or changed a video's user message. Video conversion is not supported; nothing was sent.");
          }
        }
        return converted;
      };
    },
    async prompt(text: string, options: PromptOptions, value?: unknown, signal?: AbortSignal): Promise<void> {
      if (value === undefined) {
        // Reject ordinary follow-ups before SDK acceptance so the existing
        // rejected-prompt path can restore input. Commands (e.g. /model or
        // /compact) must remain usable to recover; the stream boundary still
        // rechecks the actual model/context on every provider request.
        if (!/^[!\/]/.test(text.trimStart()) && owners(session.sessionManager.buildSessionProjection().messages).length) {
          const selected = session.model && session.modelRuntime.getModel(session.model.provider, session.model.id);
          if (!selected) throw new Error("Select the supported TapSVC video model before sending.");
          assertVideoModel(selected);
        }
        return session.prompt(text, options);
      }
      if (session.isCompacting || session.isBashRunning || (!options.streamingBehavior && (active || session.isStreaming))) {
        throw new Error("Video questions require an idle session or an explicit steering/follow-up behavior. Nothing was sent.");
      }
      if (options.streamingBehavior && !binding.installed) throw new Error("Video queue binding is unavailable. Nothing was sent.");
      const refs = parseVideoReferences(value);
      const selected = session.model && session.modelRuntime.getModel(session.model.provider, session.model.id);
      if (!selected) throw new Error("Select the supported TapSVC video model before sending.");
      assertVideoModel(selected);
      for (const ref of refs) await readVideo(ref, cwd());
      if (signal?.aborted) throw new Error("Video prompt was stopped before submission. Nothing was sent.");
      const submission: VideoSubmission = { refs: refs.map(ref => ({ ...ref, id: randomUUID() })), armed: false, bound: false, compactedOut: false };
      try {
        await binding.prompt(submission, text, {
          ...options,
          preflightResult: (disposition) => {
            if (disposition === "handled" || (disposition === "queued" && !submission.bound)) {
              throw new Error("Video input was handled without its owning question. Nothing was sent.");
            }
            if (disposition === "started") {
              submission.armed = true;
              active = submission;
            }
            options.preflightResult?.(disposition);
          },
        });
      } finally {
        if (active === submission) active = undefined;
      }
    },
    async enqueue(kind: "steer" | "followUp", text: string, images: PromptOptions["images"], value: unknown, signal?: AbortSignal) {
      if (value === undefined) return session[kind](text, images);
      if (!binding.installed || session.isCompacting || session.isBashRunning) throw new Error("Video queue input is unavailable while compacting or running shell input. Nothing was queued.");
      const refs = parseVideoReferences(value);
      const selected = session.model && session.modelRuntime.getModel(session.model.provider, session.model.id);
      if (!selected) throw new Error("Select the supported TapSVC video model before sending.");
      assertVideoModel(selected);
      for (const ref of refs) await readVideo(ref, cwd());
      if (signal?.aborted) throw new Error("Video input was stopped before submission. Nothing was queued.");
      const submission: VideoSubmission = { refs: refs.map(ref => ({ ...ref, id: randomUUID() })), armed: false, bound: false, compactedOut: false };
      const disposition = await binding.enqueue(submission, kind, text, images);
      if (disposition !== "queued" || !submission.bound) throw new Error("Video input was handled without its owning queued question. Nothing was queued.");
      return disposition;
    },
    wrap(original: StreamFn): StreamFn {
      return async (model, context, options) => {
        const references = owners(context.messages);
        // SDK compaction serializes conversation text into a separate request,
        // including while a video prompt is still running. It must neither need
        // the current owner nor turn summary paths into original media input.
        if (compacting) {
          if (references.length) throw new Error("Compaction requests must not carry original video references. Nothing was sent.");
          return original(model, context, options);
        }
        // A successful SDK compaction may also remove the submitting owner
        // before a same-run tool continuation. Canonical exclusion requires
        // absence, not permission for context/converter resurrection of that ID.
        const submitted = active;
        if (submitted) {
          for (const ref of submitted.refs) {
            const activeOwners = references.filter(owner => owner.ref.id === ref.id);
            if (submitted.compactedOut) {
              if (activeOwners.length !== 0) throw new Error("The compacted video question was reintroduced into provider input. Attach it to a new question instead. Nothing was sent.");
            } else if (!submitted.bound || activeOwners.length !== 1 || !sameReference(activeOwners[0].ref, ref)) {
              throw new Error("The active video question is missing from the provider input or its reference changed. Nothing was sent.");
            }
          }
        }
        // Queued submissions can outlive the prompt() admission call (including
        // Stop). Check their now-persisted owners against the current SDK
        // projection, not an expired upload check or a last-submission slot.
        const canonical = owners(session.sessionManager.buildSessionProjection().messages);
        if (references.length !== canonical.length) throw new Error("The effective video owners changed in provider input. Nothing was sent.");
        for (const { ref } of canonical) {
          const matches = references.filter(owner => owner.ref.id === ref.id);
          if (matches.length !== 1 || !sameReference(matches[0].ref, ref)) {
            throw new Error("A video question is missing from the provider input or its reference changed. Nothing was sent.");
          }
        }
        if (!references.length) return original(model, context, options);
        assertVideoModel(model);
        // Do not use options.apiKey as a replacement for SDK auth resolution.
        const auth = await session.modelRuntime.getAuth(model, { signal: options?.signal });
        if (!auth?.auth.apiKey) throw new Error("TapSVC video authentication did not resolve an API key. Nothing was sent.");
        if (auth.auth.baseUrl && new URL(auth.auth.baseUrl).origin !== new URL(VIDEO_GOOGLE_BASE_URL).origin) {
          throw new Error("TapSVC video authentication resolved a different endpoint. Nothing was sent.");
        }
        const googleModel: Model<"google-generative-ai"> = { ...model, api: "google-generative-ai", baseUrl: VIDEO_GOOGLE_BASE_URL, headers: undefined, compat: undefined };
        const media: Array<{ index: number; content: GoogleContent; path: string; inlineData: { mimeType: string; data: string } }> = [];
        const converted = convertMessages(googleModel, normalizeContext(context));
        let encodedBytes = 0;
        for (const { ref, index } of references) {
          const bytes = await readVideo(ref, cwd());
          encodedBytes += 4 * Math.ceil(bytes.length / 3);
          if (encodedBytes > MAX_VIDEO_REQUEST_BYTES - VIDEO_REQUEST_ENVELOPE_BYTES) {
            throw new Error("Videos exceed the 120 MiB application request limit after Base64 encoding. Reduce the selection or compact older video context. Nothing was sent.");
          }
          // Use the adapter's own converter for positions; it can omit system/
          // empty assistants and merge tool results. Never assume message index
          // equals Google contents index or append media to the last user.
          const prefix = convertMessages(googleModel, normalizeContext({ messages: context.messages.slice(0, index + 1) }));
          const content = converted[prefix.length - 1];
          if (content?.role !== "user" || !content.parts?.length) throw new Error("Video's owning message cannot be converted. Nothing was sent.");
          media.push({ index: prefix.length - 1, content, path: ref.path, inlineData: { mimeType: ref.mimeType, data: bytes.toString("base64") } });
        }
        const headers = providerHeadersToRecord(model.headers, auth.auth.headers, options?.headers) ?? {};
        // Normalize case before overriding: the current provider may have been
        // configured for Anthropic. This one video request is Google + Bearer.
        for (const key of Object.keys(headers)) {
          if (["authorization", "x-api-key", "x-goog-api-key"].includes(key.toLowerCase())) delete headers[key];
        }
        headers.Authorization = `Bearer ${auth.auth.apiKey}`;
        return streamSimple(googleModel, context, {
          ...options, apiKey: auth.auth.apiKey, headers,
          onPayload: async (value, requestModel) => {
            const params = value as GoogleParams;
            const contents = params.contents;
            for (const item of media) {
              if (JSON.stringify(contents?.[item.index]) !== JSON.stringify(item.content)) {
                throw new Error("Google video message position changed. Nothing was sent.");
              }
            }
            const toolMedia = new Map<number, GoogleContent>();
            const protectedContents = new Set<GoogleContent>();
            for (const item of media) {
              const owner = contents[item.index];
              let target = owner;
              // TapSVC rejects a terminal turn mixing functionResponse and video.
              // Keep tool responses intact; put their media immediately after them.
              if (owner.parts!.some(part => part.functionResponse)) {
                if (!toolMedia.has(item.index)) toolMedia.set(item.index, { role: "user", parts: [] });
                target = toolMedia.get(item.index)!;
              }
              target.parts!.push({ text: `Video: ${item.path}` }, { inlineData: item.inlineData });
              protectedContents.add(owner);
              protectedContents.add(target);
            }
            params.contents = contents.flatMap((content, index) => toolMedia.has(index) ? [content, toolMedia.get(index)!] : [content]);
            const expected = [...protectedContents].map(content => ({ index: params.contents.indexOf(content), json: JSON.stringify(content) }));
            // SDK extension hooks swallow handler exceptions. Validate AFTER
            // that hook, in the native adapter's fail-closed onPayload boundary.
            const changed = await options?.onPayload?.(params, requestModel);
            const final = (changed ?? params) as GoogleParams;
            const videoCount = final.contents?.reduce((count, content) => count + (content.parts ?? [])
              .filter(part => part.inlineData?.mimeType?.startsWith("video/")).length, 0);
            if (final.model !== model.id || final.config?.httpOptions || videoCount !== media.length
              || expected.some(item => JSON.stringify(final.contents?.[item.index]) !== item.json)) {
              throw new Error("Provider payload hook changed the video, its user message or endpoint. Nothing was sent.");
            }
            if (Buffer.byteLength(JSON.stringify(final), "utf8") + VIDEO_REQUEST_ENVELOPE_BYTES > MAX_VIDEO_REQUEST_BYTES) {
              throw new Error("Video request exceeds the 120 MiB application limit including text, images, tools and Base64. Reduce the selection or compact older video context. Nothing was sent.");
            }
            return final;
          },
        });
      };
    },
  };
}
