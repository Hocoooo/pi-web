/** Client/server contract. These are application limits, not TapSVC limits. */
export const MAX_VIDEO_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_VIDEO_REQUEST_BYTES = 32 * 1024 * 1024;
// The native Google SDK expands config into wire fields. Bound the complete
// adapter params (text/images/tools included) with room for that fixed envelope.
export const VIDEO_REQUEST_ENVELOPE_BYTES = 64 * 1024;
export const VIDEO_PROVIDER = "tapsvc";
export const VIDEO_MODEL_ID = "google/gemini-3.8-flash";
export const VIDEO_GOOGLE_BASE_URL = "https://llm-proxy.tapsvc.com/v1beta";

export type VideoMimeType = "video/mp4" | "video/avi";

/** Host metadata on ONE native user message. Never a content block or text marker. */
export interface VideoReference {
  version: 1;
  path: string;
  mimeType: VideoMimeType;
}

/** Display/recall projection of an input owned by the existing SDK queue. */
export interface QueuedVideoInput {
  text: string;
  images?: Array<{ type: "image"; data: string; mimeType: string }>;
  video?: VideoAttachment;
}

/** Server-assigned identity survives the SDK's cloned request projections. */
export interface VideoAttachment extends VideoReference {
  id: string;
}

export function parseVideoAttachment(value: unknown): VideoAttachment {
  const ref = parseVideoReference(value);
  const id = (value as Record<string, unknown>).id;
  if (typeof id !== "string" || !/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid persisted video attachment identity.");
  return { ...ref, id };
}

export function videoMimeTypeForName(name: string): VideoMimeType | undefined {
  if (/\.mp4$/i.test(name)) return "video/mp4";
  if (/\.avi$/i.test(name)) return "video/avi";
  return undefined;
}

/** Empty browser MIME uses the suffix; nonempty MIME must match the container. */
export function videoMimeTypeForFile(file: { name: string; type: string }): VideoMimeType | undefined {
  const mimeType = videoMimeTypeForName(file.name);
  if (!file.type || file.type === mimeType || (mimeType === "video/avi" && file.type === "video/x-msvideo")) return mimeType;
  return undefined;
}

export function parseVideoReference(value: unknown): VideoReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Attach exactly one MP4 or AVI video reference.");
  }
  const ref = value as Record<string, unknown>;
  if (ref.version !== 1 || typeof ref.path !== "string" || !ref.path
    || /[\u0000-\u001f]/.test(ref.path) || ref.path.length > 4096
    || !videoMimeTypeForName(ref.path) || ref.mimeType !== videoMimeTypeForName(ref.path)) {
    throw new Error("Invalid video reference: expected version 1, an MP4/AVI path and its matching MIME type.");
  }
  return { version: 1, path: ref.path, mimeType: ref.mimeType as VideoMimeType };
}

export function assertVideoModel(model: { provider: string; id: string; api?: string; baseUrl?: string }): void {
  if (model.provider !== VIDEO_PROVIDER || model.id !== VIDEO_MODEL_ID
    || (model.api !== "anthropic-messages" && model.api !== "google-generative-ai")
    || !model.baseUrl || new URL(model.baseUrl).origin !== new URL(VIDEO_GOOGLE_BASE_URL).origin) {
    throw new Error(`Video requires ${VIDEO_PROVIDER}/${VIDEO_MODEL_ID} at the TapSVC endpoint. No model was switched and nothing was sent.`);
  }
}

/** Reject unsupported command entrances before they can silently discard a video. */
export function validateVideoCommand(command: Record<string, unknown>): void {
  if (!Object.hasOwn(command, "video")) return;
  parseVideoReference(command.video);
  if (!["prompt", "steer", "follow_up"].includes(command.type as string)
    || (command.streamingBehavior !== undefined && (command.type !== "prompt" || !["steer", "followUp"].includes(command.streamingBehavior as string)))
    || typeof command.message !== "string" || !command.message.trim()
    || /^[!\/]/.test(command.message.trimStart())) {
    throw new Error("Video is supported only on an ordinary question (including steering/follow-up), not commands or shell input. Nothing was sent.");
  }
}
