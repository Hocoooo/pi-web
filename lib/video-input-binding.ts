import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionLike } from "./pi-types";
import type { QueuedVideoInput, VideoAttachment } from "./video-attachments";

type Kind = "steering" | "followUp";
export interface VideoSubmission {
  ref: VideoAttachment;
  armed: boolean;
  bound: boolean;
  compactedOut: boolean;
}

/**
 * Observe the SDK's public enqueue/consume/clear boundaries. The SDK remains
 * the only queue: this view holds its message objects for display/recall only,
 * never drains, schedules, retries or persists them. Async scope identifies a
 * host submission, never text/timestamp matching. Nested extension submissions
 * exit that scope even when an input handler injects an identical question.
 */
export function createVideoInputBinding(session: AgentSessionLike) {
  const scope = new AsyncLocalStorage<VideoSubmission>();
  const pending = new Map<AgentMessage, Kind>();
  const references = new WeakMap<AgentMessage, VideoAttachment>();
  const prompt = session.prompt?.bind(session);
  const steer = session.steer?.bind(session);
  const followUp = session.followUp?.bind(session);
  let changed = () => {};
  let installed = false;
  const input = (message: AgentMessage): QueuedVideoInput => {
    const content = message.role === "user" ? message.content : "";
    return {
      text: typeof content === "string" ? content : content.filter(c => c.type === "text").map(c => c.text).join(""),
      ...(Array.isArray(content) ? { images: content.filter(c => c.type === "image").map(c => ({ type: "image" as const, data: c.data, mimeType: c.mimeType })) } : {}),
      ...(references.has(message) ? { video: { ...references.get(message)! } } : {}),
    };
  };
  const snapshot = () => {
    const result: { steering: QueuedVideoInput[]; followUp: QueuedVideoInput[] } = { steering: [], followUp: [] };
    for (const [message, kind] of pending) result[kind].push(input(message));
    return result;
  };
  return {
    prompt: (submission: VideoSubmission, text: string, options: Parameters<AgentSessionLike["prompt"]>[1]) => scope.run(submission, () => prompt(text, options)),
    enqueue: (submission: VideoSubmission, kind: "steer" | "followUp", text: string, images: Parameters<AgentSessionLike["steer"]>[1]) => scope.run(submission, () => (kind === "steer" ? steer : followUp)(text, images)),
    snapshot,
    get installed() { return installed; },
    install(onChange: () => void) {
      const agent = session.agent;
      if (!agent.steer || !agent.followUp || !agent.clearSteeringQueue || !agent.clearFollowUpQueue) return;
      installed = true;
      changed = onChange;
      // Public extension sendUserMessage goes through session.prompt; it must
      // not inherit an enclosing host input handler's attachment scope.
      session.prompt = (...args) => scope.exit(() => prompt(...args));
      session.steer = (...args) => scope.exit(() => steer(...args));
      session.followUp = (...args) => scope.exit(() => followUp(...args));
      for (const [method, kind] of [["steer", "steering"], ["followUp", "followUp"]] as const) {
        const enqueue = agent[method]!.bind(agent);
        agent[method] = message => {
          const submission = scope.getStore();
          if (submission && !submission.armed && !submission.bound && message.role === "user") {
            references.set(message, { ...submission.ref });
            Object.assign(message, { piWebVideo: { ...submission.ref } });
            submission.bound = true;
          }
          enqueue(message);
          if (message.role === "user") { pending.set(message, kind); changed(); }
        };
      }
      for (const [method, kind] of [["clearSteeringQueue", "steering"], ["clearFollowUpQueue", "followUp"]] as const) {
        const clear = agent[method]!.bind(agent);
        agent[method] = () => {
          clear();
          for (const [message, queuedKind] of pending) if (kind === queuedKind) pending.delete(message);
          changed();
        };
      }
    },
    observe(event: { type: string; message?: unknown }) {
      const message = event.message as AgentMessage;
      if (event.type === "message_start" && pending.delete(message)) changed();
      // As for ordinary prompts, bind host metadata after extension events and
      // before SDK appendMessage, using the queued object's independent tuple.
      if (event.type === "message_end" && references.has(message)) {
        Object.assign(message, { piWebVideo: { ...references.get(message)! } });
        references.delete(message);
      }
    },
    clear(recall: boolean, running: boolean, recallInputs?: unknown) {
      const inputs = snapshot();
      const videos = [...inputs.steering, ...inputs.followUp].filter(i => i.video);
      // Public message_start follows awaited extension handlers, not the SDK's
      // dequeue. This display view cannot authorize Recall during a live run.
      if (recall && videos.length && running) {
        throw new Error("Stop the conversation and wait until it is idle before recalling video questions. No queued input was cleared.");
      }
      if (recall && videos.length > 1) {
        throw new Error("The queue contains multiple video questions. They cannot be merged into one attachment; the queue was kept. Continue explicitly to consume them.");
      }
      if (recall && recallInputs !== undefined) {
        // Clear only the exact full input the browser saved before this request.
        // A later enqueue must not be discarded behind a stale recovery snapshot.
        const key = (view: typeof inputs) => JSON.stringify([view.steering, view.followUp].map(queue => queue.map(i => [
          i.text, (i.images ?? []).map(image => [image.data, image.mimeType]),
          i.video ? [i.video.id, i.video.version, i.video.path, i.video.mimeType] : null,
        ])));
        if (key(recallInputs as typeof inputs) !== key(inputs)) {
          throw new Error("The queue changed before Recall. No queued input was cleared; check the current queue.");
        }
      }
      return { ...session.clearQueue(), inputs };
    },
  };
}
