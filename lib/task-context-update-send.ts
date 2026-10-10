import type { AgentSessionLike } from "./pi-types";
import { taskOperation, type PendingContextUpdate } from "./task-operations";
import { taskContextText, contextInputHash } from "./task-context-updates";

/** Original wrapper admission calls this only for an explicitly submitted, idle,
 * non-queued user prompt. No lifecycle event, retry or native queue calls it. */
export async function prepareContextUpdateSend(inner: AgentSessionLike, agentDir: string, signal: AbortSignal, stillIdle: () => boolean, submission: { epoch: string; sequence: number }): Promise<() => void> {
  const pending = await taskOperation({ action: "pending-context-update", sessionId: inner.sessionId }, { agentDir }) as PendingContextUpdate;
  const check = () => { if (signal.aborted || !stillIdle()) throw new Error("Context update send cancelled or session became busy. Selection remains pending."); };
  check();
  if (!pending || pending.choice.boundary.epoch === submission.epoch && pending.choice.boundary.sequence >= submission.sequence) return () => {};
  // Revalidate current authority immediately before native delivery; a newer
  // user choice does not replace the frozen choice of this explicit submission.
  const authority = await taskOperation({ action: "pending-context-update", sessionId: inner.sessionId }, { agentDir }) as PendingContextUpdate;
  if (!authority || authority.taskId !== pending.taskId || authority.relationGeneration !== pending.relationGeneration || authority.choice.operationId !== pending.choice.operationId) throw new Error("Context update relationship or intent changed. Nothing was sent.");
  check();
  const previous = inner.agent.streamFunction;
  const previousConvert = inner.agent.convertToLlm;
  if (!previous || !previousConvert) throw new Error("SDK stream/conversion boundary unavailable. Selection remains pending.");
  const { choice, snapshot, taskId } = pending;
  const material = taskContextText(snapshot);
  let entry = inner.sessionManager.getEntries().find(e => e.type === "custom_message" && e.customType === "pi-web:task-context"
    && (e.details as { operationId?: string } | undefined)?.operationId === choice.operationId);
  if (!entry) {
    await inner.sendCustomMessage({ customType: "pi-web:task-context", content: material, display: true,
      details: { taskId, versionId: choice.versionId, source: snapshot.version!.source, operationId: choice.operationId, originSessionId: inner.sessionId } }, { triggerTurn: false });
    entry = inner.sessionManager.getEntries().find(e => e.type === "custom_message" && e.customType === "pi-web:task-context"
      && (e.details as { operationId?: string } | undefined)?.operationId === choice.operationId);
  }
  check();
  if (!entry) throw new Error("Native context append was not confirmed. Selection remains pending.");
  const entryId = entry.id;
  // SDK's public stream boundary sees projected input AFTER context edits,
  // compaction, ordinary custom->user conversion and exact-system handling.
  // An auth/preflight failure or absent projection cannot confirm adoption.
  // This is an SDK-input + successful-response receipt, NOT a wire-payload/read claim.
  let completed = false;
  // The SDK projection owns entry identity, while the public conversion hook
  // runs AFTER extension context transforms. Carry this entry's exact text array
  // by request-local reference through SDK custom->user conversion. No marker,
  // extra provider field, history mutation or body/timestamp collision heuristic.
  // Identity alone is insufficient: converters may redact/truncate this array
  // in place. Check its actual text again at the stream boundary, without ever
  // restoring text the converter removed. Only this selected contribution counts.
  const retainsMaterial = (content: Array<{ type: "text"; text: string }>) => content
    .filter(part => part.type === "text" && typeof part.text === "string").map(part => part.text).join("").includes(material);
  let contribution: Array<{ type: "text"; text: string }> | undefined;
  const observedConvert: typeof previousConvert = async messages => {
    contribution = undefined;
    const projected = inner.sessionManager.buildSessionProjection().entries.find(p => p.sourceEntry.id === entryId);
    const ownsMaterial = projected?.messages.some(m => m.role === "custom" && m.customType === "pi-web:task-context"
      && (m.details as { operationId?: string } | undefined)?.operationId === choice.operationId && m.content === material);
    const index = ownsMaterial ? messages.findIndex(m => m.role === "custom" && m.customType === "pi-web:task-context"
      && (m.details as { operationId?: string } | undefined)?.operationId === choice.operationId && m.content === material) : -1;
    if (index < 0) return previousConvert(messages);
    const content: Array<{ type: "text"; text: string }> = [{ type: "text", text: material }];
    const converted = await previousConvert(messages.map((m, i) => i === index ? { ...m, content } : m));
    if (retainsMaterial(content) && converted.some(m => m.role === "user" && m.content === content)) contribution = content;
    return converted;
  };
  const observed: typeof previous = (model, context, options) => {
    const included = !!contribution && retainsMaterial(contribution)
      && context.messages.some(m => m.role === "user" && m.content === contribution);
    const stream = previous(model, context, options);
    if (included && !completed) {
      const inputHash = contextInputHash(context.messages);
      void Promise.resolve(stream).then(s => s.result()).then(async message => {
        if (completed || !["stop", "length", "toolUse"].includes(message.stopReason)) return;
        const delivery = { operationId: choice.operationId, entryId, inputHash, provider: message.provider, model: message.model,
          sentAt: new Date().toISOString(), evidence: "sdk-input-successful-response" as const };
        // Reserve locally before awaiting persistence: a fast next tool response
        // cannot append a second audit for the same observation.
        completed = true;
        try { await taskOperation({ action: "complete-context-update", id: taskId, sessionId: inner.sessionId, relationGeneration: pending.relationGeneration, delivery }, { agentDir }); }
        catch (error) { completed = false; throw error; }
        // SDK-owned append-only non-context audit. Never reinsert or rewrite material.
        inner.sessionManager.appendCustomEntry("pi-web:task-context-send", { taskId, versionId: choice.versionId, sessionId: inner.sessionId, ...delivery });
      }).catch(error => { console.error("[pi-web] Context update delivery could not be confirmed:", error instanceof Error ? error.message : "unknown error"); });
    }
    return stream;
  };
  inner.agent.convertToLlm = observedConvert;
  inner.agent.streamFunction = observed;
  return () => {
    if (inner.agent.streamFunction === observed) inner.agent.streamFunction = previous;
    if (inner.agent.convertToLlm === observedConvert) inner.agent.convertToLlm = previousConvert;
  };
}
