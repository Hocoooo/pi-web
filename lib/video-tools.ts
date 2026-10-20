import { randomUUID } from "node:crypto";
import path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionFactory, type InlineExtension, type LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { assertVideoModel, MAX_VIDEO_ATTACHMENTS, parseVideoReferences, videoMimeTypeForName } from "./video-attachments";
import { readVideo } from "./video-transport";

const HOST_VIDEO_EXTENSION_NAME = "pi-web-video-tools";
const HOST_VIDEO_EXTENSION_PATH = `<inline:${HOST_VIDEO_EXTENSION_NAME}>`;

/** Keep this host capability independent of user-extension loading and explicit in the tool scope. */
export function subagentVideoToolExtensions(tools: readonly string[]): InlineExtension[] {
  return tools.includes("read_video") ? [{
    name: HOST_VIDEO_EXTENSION_NAME,
    factory: createVideoToolsExtension(),
  }] : [];
}

/** Resolve duplicates AFTER the child's extension scope, also on reload. SDK replaceable
 * factories are removed before that scope and could lose the host fallback altogether. */
export function withVideoToolPrecedence(scope?: (base: LoadExtensionsResult) => LoadExtensionsResult) {
  return (base: LoadExtensionsResult): LoadExtensionsResult => {
    const scoped = scope ? scope(base) : base;
    const host = scoped.extensions.find(extension => extension.path === HOST_VIDEO_EXTENSION_PATH);
    if (!host?.tools.has("read_video")) return scoped;
    const userTool = scoped.extensions.some(extension => extension !== host && extension.tools.has("read_video"));
    return {
      ...scoped,
      extensions: userTool ? scoped.extensions.filter(extension => extension !== host) : scoped.extensions,
      // Only the host's now-resolved single-tool conflicts; unrelated diagnostics stay.
      errors: scoped.errors.filter(error => error.path !== HOST_VIDEO_EXTENSION_PATH
        || !error.error.startsWith('Tool "read_video" conflicts with ')),
    };
  };
}

/** The result stores paths, not Base64. The normal stream adapter supplies the original media. */
export function createVideoToolsExtension(): ExtensionFactory {
  return pi => {
    pi.registerTool(defineTool({
      name: "read_video",
      label: "Read videos",
      description: "Read original local MP4/AVI videos into the current Gemini conversation (not a summary or extracted frames). Requires tapsvc/google/gemini-3.8-flash. Pass 1–4 file paths, each at most 20 MiB. For a directory, first discover relevant videos recursively with available file/shell tools, respecting ignored files and allowed roots; do not read unrelated videos. If there are too many, list candidates and ask the user to narrow the selection instead of silently batching. The video bytes are sent to the model provider. Use this tool, not ordinary read, to understand videos. Results and their order remain available for follow-up questions while in context.",
      exposure: "model-only",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      parameters: Type.Object({
        paths: Type.Array(Type.String({ description: "Video file path, absolute or relative to the session working directory." }), { minItems: 1, maxItems: MAX_VIDEO_ATTACHMENTS }),
      }),
      async execute(_id, params, signal, _onUpdate, ctx) {
        if (!ctx.model) throw new Error("Select the supported TapSVC video model before reading videos.");
        assertVideoModel(ctx.model);
        const refs = parseVideoReferences(params.paths.map(value => {
          const filePath = path.resolve(ctx.cwd, value);
          return { version: 1, path: filePath, mimeType: videoMimeTypeForName(filePath) };
        }));
        for (const ref of refs) {
          signal?.throwIfAborted();
          await readVideo(ref, ctx.cwd);
        }
        signal?.throwIfAborted();
        return {
          content: [{ type: "text", text: `Read ${refs.length} original video(s), in order:\n${refs.map((ref, i) => `${i + 1}. ${ref.path}`).join("\n")}\nThe original videos accompany this result in the model input.` }],
          details: { piWebVideos: refs.map(ref => ({ ...ref, id: randomUUID() })) },
        };
      },
    }));
  };
}
