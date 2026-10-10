import { createHash } from "node:crypto";
import { clearContextUpdate, updateState } from "./task-context-updates";
import { sameTaskSessionProject, taskSessionCatalogue } from "./task-sessions";
import { TASK_ID_PATTERN, isTaskSessionId, TaskOperationError, type TaskRelationRequest } from "./task-types";
import type { StoredTaskRecord } from "./task-store";

/** Generation-only tombstones; sessionIds remains the ONLY owner index. No native history lives here. */
export interface SessionRelationRevision {
  sessionId: string;
  generation: number;
  receipt?: { operationId: string; fingerprint: string };
}
export interface RelationDocument { tasks: StoredTaskRecord[]; sessionRelations: SessionRelationRevision[] }
export function relationGeneration(document: RelationDocument, sessionId: string): number {
  return document.sessionRelations.find(r => r.sessionId === sessionId)?.generation ?? 0;
}
export function assertRelationGeneration(document: RelationDocument, sessionId: string, expected: number) {
  if (relationGeneration(document, sessionId) !== expected) throw new TaskOperationError("conflict", "Session task relationship changed. Review again; the old operation was not executed.");
}
/** Association preserves the current epoch; departure/reassignment advances it.
 * Owner identity plus this epoch protects even unowned -> owned -> unowned ABA. */
export function associateRelation(document: RelationDocument, sessionId: string): number {
  const revision = document.sessionRelations.find(r => r.sessionId === sessionId);
  if (!revision) return 0;
  delete revision.receipt;
  return revision.generation;
}
export function validSessionRelations(value: unknown): value is SessionRelationRevision[] {
  return Array.isArray(value) && value.every(r => r && typeof r === "object" && !Array.isArray(r)
    && Object.keys(r).every(k => ["sessionId", "generation", "receipt"].includes(k)) && isTaskSessionId(r.sessionId)
    && Number.isSafeInteger(r.generation) && r.generation >= 1
    && (r.receipt === undefined || r.receipt && typeof r.receipt === "object" && Object.keys(r.receipt).length === 2
      && typeof r.receipt.operationId === "string" && TASK_ID_PATTERN.test(r.receipt.operationId)
      && typeof r.receipt.fingerprint === "string" && /^[a-f0-9]{64}$/.test(r.receipt.fingerprint)))
    && new Set(value.map(r => r.sessionId)).size === value.length;
}
export function parseRelationRequest(v: Record<string, unknown>): TaskRelationRequest {
  if (Object.keys(v).some(k => !["action", "sessionId", "sourceTaskId", "targetTaskId", "expectedGeneration", "expectedUpdateRevision", "operationId"].includes(k))
    || !isTaskSessionId(v.sessionId) || typeof v.sourceTaskId !== "string" || !TASK_ID_PATTERN.test(v.sourceTaskId)
    || v.targetTaskId !== null && (typeof v.targetTaskId !== "string" || !TASK_ID_PATTERN.test(v.targetTaskId))
    || v.targetTaskId === v.sourceTaskId || typeof v.operationId !== "string" || !TASK_ID_PATTERN.test(v.operationId)
    || !Number.isSafeInteger(v.expectedGeneration) || (v.expectedGeneration as number) < 0
    || !Number.isSafeInteger(v.expectedUpdateRevision) || (v.expectedUpdateRevision as number) < 0) {
    throw new TaskOperationError("invalid-input", "Choose a source, a different target or unlink, and the displayed relation revision.");
  }
  return v as unknown as TaskRelationRequest;
}
/** Under the same board lock as pending clear, linking, admission, archive and all callback CAS. */
export async function changeSessionRelation(document: RelationDocument, request: TaskRelationRequest, agentDir: string): Promise<boolean> {
  const fingerprint = createHash("sha256").update(JSON.stringify([request.sessionId, request.sourceTaskId, request.targetTaskId, request.expectedGeneration, request.expectedUpdateRevision])).digest("hex");
  const prior = document.sessionRelations.find(r => r.sessionId === request.sessionId);
  if (prior?.receipt?.operationId === request.operationId) {
    if (prior.receipt.fingerprint !== fingerprint) throw new TaskOperationError("conflict", "Relation operation ID already used for another request.");
    return false; // Confirmation of committed fact only: no busy check, no replay.
  }
  assertRelationGeneration(document, request.sessionId, request.expectedGeneration);
  const source = document.tasks.find(t => t.sessionIds.includes(request.sessionId));
  const target = request.targetTaskId === null ? undefined : document.tasks.find(t => t.id === request.targetTaskId);
  if (!source || source.id !== request.sourceTaskId) throw new TaskOperationError("conflict", "Source relationship changed. Nothing was reassigned.");
  if (request.targetTaskId !== null && !target) throw new TaskOperationError("not-found", "Target task no longer exists.");
  // Ownership is metadata only: neither archive nor runtime activity gates it.
  const session = (await taskSessionCatalogue(agentDir)).find(s => s.id === request.sessionId);
  if (!session) throw new TaskOperationError("not-found", "Session no longer exists.");
  if (!sameTaskSessionProject(source.project, session) || target && !sameTaskSessionProject(target.project, session)) throw new TaskOperationError("invalid-input", "Source, target and session must have the same authoritative project scope.");
  if ([source, ...(target ? [target] : [])].some(t => t.revision === Number.MAX_SAFE_INTEGER) || request.expectedGeneration === Number.MAX_SAFE_INTEGER) throw new TaskOperationError("storage-unavailable", "Revision limit reached; nothing was changed.");
  clearContextUpdate(source, request.sessionId, request.expectedUpdateRevision);
  if (target) clearContextUpdate(target, request.sessionId, updateState(target, request.sessionId).revision);
  // Selection receipts remain append-only audit. Their generation makes recovery inapplicable.
  source.sessionIds = source.sessionIds.filter(id => id !== request.sessionId);
  if (target) target.sessionIds.push(request.sessionId);
  for (const task of [source, ...(target ? [target] : [])]) {
    task.revision++;
    task.updatedAt = new Date(Math.max(Date.now(), Date.parse(task.updatedAt) + 1)).toISOString();
  }
  const revision = prior ?? { sessionId: request.sessionId, generation: 0 };
  revision.generation++;
  revision.receipt = { operationId: request.operationId, fingerprint };
  if (!prior) document.sessionRelations.push(revision);
  return true;
}
