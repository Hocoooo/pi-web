import { createHash, randomUUID } from "node:crypto";
/** A single-process logical boundary, not a clock or a queue. Persisted choices
 * from an earlier process precede every explicit submission in the new process. */
export function contextUpdateBoundary(): { epoch: string; sequence: number } {
  const key = Symbol.for("pi-web:context-update-boundary");
  const globals = globalThis as unknown as Record<symbol, { epoch: string; sequence: number }>;
  const state = globals[key] ??= { epoch: randomUUID(), sequence: 0 };
  if (state.sequence === Number.MAX_SAFE_INTEGER) throw new Error("Context update boundary limit reached.");
  return { epoch: state.epoch, sequence: ++state.sequence };
}
import { publicSharedContext } from "./task-context";
import { taskContextText } from "./task-start";
import { sameTaskSessionProject, taskSessionCatalogue } from "./task-sessions";
import { TASK_ID_PATTERN, isTaskSessionId, TaskOperationError, type TaskContextUpdateRequest, type TaskSessionUpdate, type TaskUpdateChoice, type TaskUpdateDelivery, type TaskContextUpdateState } from "./task-types";
import type { StoredTaskRecord } from "./task-store";

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const uuid = (v: unknown): v is string => typeof v === "string" && TASK_ID_PATTERN.test(v);
const revision = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const date = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));
const fail = (message: string): never => { throw new TaskOperationError("invalid-input", message); };
export function parseContextUpdateRequest(v: Record<string, unknown>): TaskContextUpdateRequest {
  const keys = v.action === "context-update-state" ? ["action", "sessionId"] : v.action === "accept-context-update"
    ? ["action", "id", "sessionId", "operationId", "expectedRevision", "versionId", "expectedRelationGeneration"] : v.action === "clear-context-update"
    ? ["action", "id", "sessionId", "expectedRevision", "expectedRelationGeneration"] : v.action === "pending-context-update" ? ["action", "sessionId"]
    : ["action", "id", "sessionId", "delivery", "relationGeneration"];
  if (v.expectedRelationGeneration !== undefined && !revision(v.expectedRelationGeneration) || v.relationGeneration !== undefined && !revision(v.relationGeneration)) return fail("Invalid relation generation.");
  if (Object.keys(v).some(k => !keys.includes(k)) || !isTaskSessionId(v.sessionId)) return fail("Invalid context update request.");
  if (v.action === "context-update-state" || v.action === "pending-context-update") return v as unknown as TaskContextUpdateRequest;
  if (!uuid(v.id)) return fail("A task UUID is required.");
  if (v.action === "complete-context-update") {
    if (!validDelivery(v.delivery)) return fail("Invalid context delivery.");
  } else if (!revision(v.expectedRevision) || v.action === "accept-context-update" && (!uuid(v.operationId) || !uuid(v.versionId))) return fail("Select an explicit version and revision.");
  return v as unknown as TaskContextUpdateRequest;
}
function validDelivery(v: unknown): v is TaskUpdateDelivery {
  return object(v) && Object.keys(v).length === 7 && uuid(v.operationId) && typeof v.entryId === "string" && !!v.entryId
    && typeof v.inputHash === "string" && /^[a-f0-9]{64}$/.test(v.inputHash) && typeof v.provider === "string" && !!v.provider
    && typeof v.model === "string" && !!v.model && date(v.sentAt) && v.evidence === "sdk-input-successful-response";
}
export function validSessionUpdates(v: unknown, task: Record<string, unknown>): v is TaskSessionUpdate[] {
  if (!Array.isArray(v)) return false;
  const ids = new Set<string>();
  return v.every(s => {
    if (!object(s) || Object.keys(s).length !== 5 || !isTaskSessionId(s.sessionId) || ids.has(s.sessionId) || s.pendingOperationId !== null && (!Array.isArray(task.sessionIds) || !task.sessionIds.includes(s.sessionId))
      || !revision(s.revision) || !Array.isArray(s.choices) || !Array.isArray(s.deliveries)) return false;
    const operations = new Set<string>();
    const versions = (task.sharedContext as { versions?: { id: string }[] })?.versions;
    if (!s.choices.every(c => object(c) && Object.keys(c).length === (c.relationGeneration === undefined ? 5 : 6) && (c.relationGeneration === undefined || revision(c.relationGeneration)) && object(c.boundary) && Object.keys(c.boundary).length === 2 && uuid(c.boundary.epoch) && revision(c.boundary.sequence) && uuid(c.operationId) && !operations.has(c.operationId)
      && uuid(c.versionId) && versions?.some(v => v.id === c.versionId) && revision(c.expectedRevision) && date(c.selectedAt) && !!operations.add(c.operationId))) return false;
    if (s.pendingOperationId !== null && (!uuid(s.pendingOperationId) || !operations.has(s.pendingOperationId))) return false;
    const delivered = new Set<string>();
    if (!s.deliveries.every(d => validDelivery(d) && operations.has(d.operationId) && !delivered.has(d.operationId) && !!delivered.add(d.operationId))) return false;
    ids.add(s.sessionId); return true;
  });
}
export async function validateUpdateSession(task: StoredTaskRecord, sessionId: string, agentDir: string) {
  const session = (await taskSessionCatalogue(agentDir)).find(s => s.id === sessionId);
  if (!session || !task.sessionIds.includes(sessionId)) throw new TaskOperationError("conflict", "Session relationship changed or disappeared. No update was applied.");
  if (!sameTaskSessionProject(task.project, session)) return fail("Session is outside the task's current project.");
}
export function updateState(task: StoredTaskRecord, sessionId: string): TaskSessionUpdate {
  return task.sessionUpdates.find(s => s.sessionId === sessionId) ?? { sessionId, revision: 0, pendingOperationId: null, choices: [], deliveries: [] };
}
function bump(state: TaskSessionUpdate) {
  if (state.revision === Number.MAX_SAFE_INTEGER) throw new TaskOperationError("storage-unavailable", "Context selection revision limit reached.");
  state.revision++;
}
export function selectContextUpdate(task: StoredTaskRecord, request: Extract<TaskContextUpdateRequest, { action: "accept-context-update" }>, generation = 0) {
  const state = updateState(task, request.sessionId), prior = state.choices.find(c => c.operationId === request.operationId);
  if (prior) {
    if (prior.versionId !== request.versionId || prior.expectedRevision !== request.expectedRevision) throw new TaskOperationError("conflict", "This selection ID was used for different content.");
    return false; // Exact confirmation never reinstates an old pending choice.
  }
  if (state.revision !== request.expectedRevision) throw new TaskOperationError("conflict", "Context selection changed in another page. Reload and explicitly select again.");
  if (!task.sharedContext.versions.some(v => v.id === request.versionId)) return fail("Choose a confirmed version of this task.");
  bump(state);
  state.choices.push({ relationGeneration: generation, operationId: request.operationId, versionId: request.versionId, expectedRevision: request.expectedRevision, selectedAt: new Date().toISOString(), boundary: contextUpdateBoundary() });
  state.pendingOperationId = request.operationId;
  if (!task.sessionUpdates.includes(state)) task.sessionUpdates.push(state);
  return true;
}
/** Public CAS clear for ticket10. Call before unlink/reassignment under the same task lock.
 * It clears only intent, never removes historical choices, deliveries or native material. */
export function clearContextUpdate(task: StoredTaskRecord, sessionId: string, expectedRevision: number) {
  const state = updateState(task, sessionId);
  if (state.revision !== expectedRevision) throw new TaskOperationError("conflict", "Context selection changed. Reload before clearing it.");
  if (state.pendingOperationId === null) return false;
  bump(state); state.pendingOperationId = null; return true;
}
export function completeContextUpdate(task: StoredTaskRecord, sessionId: string, delivery: TaskUpdateDelivery) {
  const state = updateState(task, sessionId);
  if (!state.choices.some(c => c.operationId === delivery.operationId)) throw new TaskOperationError("conflict", "Context selection no longer belongs to this session.");
  if (state.deliveries.some(d => d.operationId === delivery.operationId)) return false;
  bump(state); state.deliveries.push(delivery);
  if (state.pendingOperationId === delivery.operationId) state.pendingOperationId = null;
  return true;
}
export function updateMaterial(task: StoredTaskRecord, choice: TaskUpdateChoice) {
  return { taskId: task.id, title: "Shared context update", description: "", completionCriteria: "",
    version: publicSharedContext(task.sharedContext).versions.find(v => v.id === choice.versionId)! };
}
export function contextInputHash(messages: unknown): string { return createHash("sha256").update(JSON.stringify(messages)).digest("hex"); }
export async function readContextUpdateState(task: StoredTaskRecord | undefined, sessionId: string, agentDir: string, generation = 0): Promise<TaskContextUpdateState> {
  const state = task ? updateState(task, sessionId) : { sessionId, revision: 0, pendingOperationId: null, choices: [], deliveries: [] };
  if (!task) return { task: null, relationGeneration: generation, state, current: null };
  await validateUpdateSession(task, sessionId, agentDir);
  const { readSummarySession } = await import("./task-summary");
  const { publicTask } = await import("./task-store");
  const manager = await readSummarySession(agentDir, sessionId);
  if (!manager || manager.getSessionId() !== sessionId) throw new TaskOperationError("conflict", "Session history changed. Reload before choosing.");
  let current: TaskContextUpdateState["current"] = null;
  const projected = manager.buildSessionProjection().entries;
  for (const entry of manager.getBranch().reverse()) {
    if (entry.type !== "custom_message" || entry.customType !== "pi-web:task-context" || !object(entry.details) || entry.details.taskId !== task.id) continue;
    const operationId = entry.details.operationId;
    const original = task.sessionContexts.find(c => c.operationId === operationId && entry.content === taskContextText(c.snapshot));
    const owner = task.sessionUpdates.find(s => s.choices.some(c => c.operationId === operationId));
    const choice = owner?.choices.find(c => c.operationId === operationId);
    if (!original && (!choice || entry.content !== taskContextText(updateMaterial(task, choice)))) continue;
    current = { operationId: operationId as string, versionId: original?.snapshot.version?.id ?? choice?.versionId ?? null, originSessionId: original?.sessionId ?? owner!.sessionId,
      projected: projected.some(p => p.sourceEntry.id === entry.id && p.messages.some(m => m.role === "custom" && m.content === entry.content)),
      successfulSend: owner?.sessionId === sessionId && !!owner.deliveries.some(d => d.operationId === operationId && d.entryId === entry.id) };
    break;
  }
  return { task: publicTask(task), relationGeneration: generation, state, current };
}
export { taskContextText };
