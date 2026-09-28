import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { MessagePerformance } from "./message-performance";

type TimedMessage = AssistantMessage & { piWebPerformance?: MessagePerformance };

/**
 * One eager relay per SDK request (including each retry/tool continuation).
 * Do not observe the upstream stream twice: its queue is not a broadcast.
 * Measure before downstream extension/UI processing; keep the SDK's original
 * stream function so authentication, request options and cache warming survive.
 */
export function createRequestPerformanceTracker(now: () => number = () => performance.now()) {
  const completed = new WeakMap<object, MessagePerformance>();
  return {
    wrap(original: StreamFn): StreamFn {
      return (model, context, options) => {
        const started = now();
        let first: number | undefined;
        let partial: TimedMessage | undefined;
        const relay = createAssistantMessageEventStream();
        const timing = (): MessagePerformance => {
          const end = now();
          return {
            version: 1,
            ttftMs: first === undefined ? null : Math.max(0, first - started),
            generationMs: first === undefined ? null : Math.max(0, end - first),
            totalMs: Math.max(0, end - started),
          };
        };
        const finish = (message: TimedMessage, measured: MessagePerformance) => {
          message.piWebPerformance = measured;
          completed.set(message, measured);
          return message;
        };
        void (async () => {
          try {
            const upstream = await original(model, context, options);
            for await (const event of upstream) {
              if (first === undefined
                && (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta")
                && event.delta.length > 0) first = now();
              if (event.type === "done" || event.type === "error") {
                const measured = timing();
                const message = finish(await upstream.result(), measured);
                relay.push(event.type === "done" ? { ...event, message } : { ...event, error: message });
                relay.end(message);
                return;
              }
              partial = event.partial;
              partial.piWebPerformance = timing();
              relay.push(event);
            }
            // Some custom providers end(result) without a terminal event.
            const measured = timing();
            relay.end(finish(await upstream.result(), measured));
          } catch (error) {
            // StreamFn failures must settle as error messages, never leave the
            // consumer waiting forever on a failed background relay task.
            const reason = options?.signal?.aborted ? "aborted" : "error";
            const message: TimedMessage = {
              ...(partial ?? {
                role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
                timestamp: Date.now(),
                usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              }),
              stopReason: reason,
              errorMessage: error instanceof Error ? error.message : String(error),
            };
            finish(message, timing());
            relay.push({ type: "error", reason, error: message });
            relay.end(message);
          }
        })();
        return relay;
      };
    },
    /** message_end extensions may replace fields before public subscribers run. */
    restore(message: object): void {
      const measured = completed.get(message);
      if (measured) Object.assign(message, { piWebPerformance: measured });
    },
  };
}
