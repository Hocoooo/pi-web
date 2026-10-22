import type { LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { currentServerPerf, startServerPerf, withServerPerf } from "./perf";

/** A per-runtime gate for orderly shutdown during initial extension binding.
 * The wrapper drains that binding before shutdown/disposal and file removal.
 * This does not serialize concurrent SDK reload or change direct destroy. */
export function createExtensionLifecycle() {
  let closing = false;
  return {
    close() { closing = true; },
    wrap(base: LoadExtensionsResult): LoadExtensionsResult {
      return {
        ...base,
        extensions: base.extensions.map((extension, extensionIndex) => {
          const handlers = new Map(extension.handlers);
          for (const event of ["session_start", "session_shutdown", "resources_discover"] as const) {
            const originals = handlers.get(event);
            if (!originals) continue;
            handlers.set(event, originals.map((handler, handlerIndex) => function (this: unknown, ...args) {
              // Do not start another connection/index/resource discovery only to
              // immediately tear it down. All shutdown handlers still run.
              if (closing && event !== "session_shutdown") return Promise.resolve(undefined);
              return withServerPerf(startServerPerf(`runtime.extension.${event}`), async () => {
                const perf = currentServerPerf();
                perf?.span("handler", {
                  extensionIndex, handlerIndex,
                  nativeFinder: /[\\/]pi-fff[\\/]/.test(extension.path),
                  externalMcp: /[\\/]pi-mcp-extension[\\/]/.test(extension.path),
                });
                const pending = handler.apply(this, args);
                perf?.span("dispatch");
                const result = await pending;
                perf?.span("wait");
                return result;
              });
            }));
          }
          return { ...extension, handlers };
        }),
      };
    },
  };
}
