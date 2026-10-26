import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ContextEditEntry, SessionManager, SessionProjection } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { AgentSessionLike } from "./pi-types";

export const DEFAULT_IMAGE_CONTEXT_MAX_BYTES = 20 * 1024 * 1024;
export const IMAGE_OFFLOAD_PLACEHOLDER = "[Image offloaded from model context to meet the Pi Web image budget. Original image remains in session history; attach it again to inspect it. This is not a visual summary.]";

export function imageContextMaxBytes(value = process.env.PI_WEB_IMAGE_CONTEXT_MAX_BYTES): number {
  if (value === undefined) return DEFAULT_IMAGE_CONTEXT_MAX_BYTES;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error("PI_WEB_IMAGE_CONTEXT_MAX_BYTES must be a positive safe integer (Base64 bytes).");
  }
  return Number(value);
}

function isImage(value: unknown): value is ImageContent {
  return typeof value === "object" && value !== null && "type" in value && value.type === "image" && "data" in value && typeof value.data === "string";
}

export function imageBase64Bytes(content: unknown): number {
  return Array.isArray(content) ? content.reduce((sum, block) => sum + (isImage(block) ? Buffer.byteLength(block.data, "utf8") : 0), 0) : 0;
}

export class ImageContextBudgetError extends Error {
  constructor(bytes: number, maxBytes: number) {
    super(`Image context exceeds the Pi Web Base64 budget (${bytes} > ${maxBytes} bytes). The newest image-bearing message must fit in full. Send fewer/smaller images or compact older context. Nothing was sent for this request.`);
    this.name = "ImageContextBudgetError";
  }
}

type Edit = { targetId: string; replacement: NonNullable<ContextEditEntry["replacement"]> };

/** Plan against effective content, never raw history. Newest MESSAGE, not newest block, is protected. */
export function planImageOffload(projection: SessionProjection, maxBytes: number): Edit[] {
  const groups = projection.entries.flatMap(entry => entry.messages.flatMap(message => {
    if ((message.role !== "user" && message.role !== "toolResult" && message.role !== "custom") || !Array.isArray(message.content)) return [];
    const bytes = imageBase64Bytes(message.content);
    return message.content.some(isImage) ? [{ targetId: entry.sourceEntry.id, content: message.content, bytes }] : [];
  }));
  const newest = groups.at(-1);
  if (!newest) return [];
  if (newest.bytes > maxBytes) throw new ImageContextBudgetError(newest.bytes, maxBytes);
  let total = groups.reduce((sum, group) => sum + group.bytes, 0);
  const edits: Edit[] = [];
  for (const group of groups.slice(0, -1)) {
    if (total <= maxBytes) break;
    const content = group.content.map(block => {
      if (total <= maxBytes || !isImage(block)) return block;
      total -= Buffer.byteLength(block.data, "utf8");
      return { type: "text" as const, text: IMAGE_OFFLOAD_PLACEHOLDER };
    });
    edits.push({ targetId: group.targetId, replacement: { content } });
  }
  return edits;
}

export function offloadSessionImages(manager: SessionManager, maxBytes: number): boolean {
  const edits = planImageOffload(manager.buildSessionProjection(), maxBytes);
  for (const edit of edits) manager.appendContextEdit(edit.targetId, edit.replacement);
  return edits.length > 0;
}

/** Host hooks run outside the extension runner (which can swallow hook errors). */
export function createImageContextBudget(session: AgentSessionLike) {
  const maxBytes = imageContextMaxBytes();
  let deferredOffloadFailure: { error: unknown } | undefined;
  return {
    validateInput(images: unknown): void {
      const bytes = imageBase64Bytes(images);
      if (bytes > maxBytes) throw new ImageContextBudgetError(bytes, maxBytes);
    },
    validatePrompt(text: string, images: unknown): void {
      // Commands, especially /compact, remain usable even with an oversized
      // historical group. A new image group supersedes the protected old group.
      if (!session.isStreaming && !/^[!\/]/.test(text.trimStart()) && !imageBase64Bytes(images)) {
        planImageOffload(session.sessionManager.buildSessionProjection(), maxBytes);
      }
    },
    install(): void {
      const prepare = session.agent.prepareRequest;
      if (prepare) {
        session.agent.prepareRequest = async (request, signal) => {
          // The agent loop has now persisted its dequeued input. Fail here, not
          // in next-turn preparation where throwing can strand that input.
          if (deferredOffloadFailure) {
            const { error } = deferredOffloadFailure;
            deferredOffloadFailure = undefined;
            throw error;
          }
          // Legal edits still precede routing/compaction. An oversized newest
          // group gets the SDK's virtual-route threshold compaction opportunity
          // before the definitive check; never call the router a second time.
          try { offloadSessionImages(session.sessionManager, maxBytes); }
          catch (error) { if (!(error instanceof ImageContextBudgetError)) throw error; }
          const prepared = (await prepare(request, signal)) ?? undefined;
          if (!offloadSessionImages(session.sessionManager, maxBytes)) return prepared;
          // Compaction may have exposed a different protected group. If that
          // required edits, refresh only canonical messages, retaining the routed
          // model, thinking level, executable tools and other request fields.
          return {
            ...prepared,
            context: {
              ...(prepared?.context ?? request.context),
              messages: session.sessionManager.buildSessionProjection().messages,
            },
          };
        };
      }
      const next = session.agent.prepareNextTurnWithContext;
      if (next) {
        session.agent.prepareNextTurnWithContext = async (turn, signal) => {
          // Before SDK between-tool compaction. An oversized newest group must
          // not prevent text-only compaction or a pending new group from recovery;
          // prepareRequest and the stream guard still refuse an oversized send.
          try { offloadSessionImages(session.sessionManager, maxBytes); }
          catch (error) {
            if (!(error instanceof ImageContextBudgetError)) {
              deferredOffloadFailure = { error };
              // Skip preparation for this already-failed request, but let the
              // SDK persist its pending messages before prepareRequest rejects.
              return undefined;
            }
          }
          return next(turn, signal);
        };
      }
    },
    wrap(original: StreamFn): StreamFn {
      return (model, context, options) => {
        const bytes = context.messages.reduce((sum, message) => sum + imageBase64Bytes(message.content), 0);
        if (bytes > maxBytes) throw new ImageContextBudgetError(bytes, maxBytes);
        return original(model, context, options);
      };
    },
  };
}
