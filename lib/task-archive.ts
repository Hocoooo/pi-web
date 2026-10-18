import { createHash } from "node:crypto";
import { isTaskSessionId, TASK_ID_PATTERN, TaskOperationError, type TaskArchiveSkipped, type TaskRequest } from "./task-types";
import type { StoredTaskRecord } from "./task-store";

export type ArchiveRequest = Extract<TaskRequest, { action: "set-archive" }>;
export function parseArchiveRequest(v: Record<string, unknown>): ArchiveRequest {
  const cascade = v.cascade;
  if (cascade !== undefined && (v.archived !== true || typeof cascade !== "object" || cascade === null || Array.isArray(cascade)
    || Object.keys(cascade).length !== 2 || !Object.hasOwn(cascade, "previewToken") || !Object.hasOwn(cascade, "confirmCrossTask")
    || typeof (cascade as Record<string, unknown>).previewToken !== "string" || !/^[0-9a-f]{64}$/.test((cascade as Record<string, unknown>).previewToken as string)
    || typeof (cascade as Record<string, unknown>).confirmCrossTask !== "boolean")) throw new TaskOperationError("invalid-input", "A current archive preview and explicit family consent are required.");
  if (Object.keys(v).length !== (cascade === undefined ? 5 : 6) || Object.keys(v).some(k => !["action", "id", "archived", "expectedArchiveRevision", "operationId", "cascade"].includes(k))
    || typeof v.id !== "string" || !TASK_ID_PATTERN.test(v.id) || typeof v.archived !== "boolean"
    || !Number.isSafeInteger(v.expectedArchiveRevision) || (v.expectedArchiveRevision as number) < 0
    || typeof v.operationId !== "string" || !TASK_ID_PATTERN.test(v.operationId)) throw new TaskOperationError("invalid-input", "Invalid archive request.");
  return v as ArchiveRequest;
}
export interface StoredArchiveCascade {
  status: "pending" | "completed";
  expectedArchiveRevision: number;
  previewToken: string;
  confirmCrossTask: boolean;
  rootSessionIds: string[];
  skipped: TaskArchiveSkipped[];
}
export interface StoredArchiveReceipt { operationId: string; fingerprint: string; cascade?: StoredArchiveCascade }
export function validArchiveReceipt(value: unknown): value is StoredArchiveReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(key => !["operationId", "fingerprint", "cascade"].includes(key))
    || typeof v.operationId !== "string" || !TASK_ID_PATTERN.test(v.operationId)
    || typeof v.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(v.fingerprint)) return false;
  if (!Object.hasOwn(v, "cascade")) return true;
  if (typeof v.cascade !== "object" || v.cascade === null || Array.isArray(v.cascade)) return false;
  const c = v.cascade as Record<string, unknown>;
  return Object.keys(c).length === 6 && Object.keys(c).every(key => ["status", "expectedArchiveRevision", "previewToken", "confirmCrossTask", "rootSessionIds", "skipped"].includes(key))
    && (c.status === "pending" || c.status === "completed") && Number.isSafeInteger(c.expectedArchiveRevision) && (c.expectedArchiveRevision as number) >= 0
    && typeof c.previewToken === "string" && /^[0-9a-f]{64}$/.test(c.previewToken) && typeof c.confirmCrossTask === "boolean"
    && Array.isArray(c.rootSessionIds) && c.rootSessionIds.every(id => typeof id === "string" && TASK_ID_PATTERN.test(id)) && new Set(c.rootSessionIds).size === c.rootSessionIds.length
    && Array.isArray(c.skipped) && c.skipped.every(s => typeof s === "object" && s !== null && !Array.isArray(s)
      && Object.keys(s).length === 2 && isTaskSessionId(s.sessionId) && ["missing", "unpersisted", "unsupported-id", "unresolved-family"].includes(s.reason))
    && new Set(c.skipped.map(s => s.sessionId)).size === c.skipped.length;
}
export function archiveRequestFingerprint(request: ArchiveRequest): string {
  const tuple: unknown[] = [request.id, request.archived, request.expectedArchiveRevision];
  if (request.cascade) tuple.push([request.cascade.previewToken, request.cascade.confirmCrossTask]);
  return createHash("sha256").update(JSON.stringify(tuple)).digest("hex");
}
export function assertTaskActive(task: StoredTaskRecord): void {
  if (task.archived) throw new TaskOperationError("conflict", "This task is archived. Restore it from the task board's Archived list before starting work. Nothing was sent; the task was not automatically restored.");
}
/** Called under the existing board lock. Runtime is the existing wrapper lifecycle,
 * including queued/UI work and closing wrappers until disposal; never disk guesses. */
export async function assertTaskSessionsIdle(agentDir: string, ids: readonly string[]): Promise<void> {
  const { getTaskSessionActivity } = await import("./rpc-manager");
  const busy = getTaskSessionActivity(agentDir, ids).filter(s => s.running || s.waitingForInput || s.compacting || s.bashRunning || s.queued);
  if (busy.length) throw new TaskOperationError("conflict", `Associated conversation is busy (${busy.map(s => `${s.id}: ${s.waitingForInput ? "waiting for input" : s.compacting ? "compacting" : s.bashRunning ? "shell running" : s.queued ? "queued work" : "running or awaiting admission"}`).join(", ")}). Wait for all work to finish or explicitly Stop it in chat, then retry. Changing task links does not stop work.`);
}
export async function setTaskArchive(task: StoredTaskRecord, request: ArchiveRequest, agentDir: string): Promise<boolean> {
  const fingerprint = archiveRequestFingerprint(request);
  if (task.archiveReceipt?.operationId === request.operationId) {
    if (task.archiveReceipt.fingerprint !== fingerprint) throw new TaskOperationError("conflict", "This archive operation ID was used for another request.");
    return false;
  }
  if (task.archiveRevision !== request.expectedArchiveRevision) throw new TaskOperationError("conflict", "Archive state changed in another page. Refresh and explicitly choose archive or restore again; no changes were saved.");
  // Visibility only: archiving never waits for, stops, or restricts session work.
  if (task.archived !== request.archived) {
    if (task.archiveRevision === Number.MAX_SAFE_INTEGER) throw new TaskOperationError("storage-unavailable", "Archive revision limit reached; no changes were saved.");
    if (request.archived) {
      const { prepareTaskReport } = await import("./task-reports");
      const reportId = await prepareTaskReport(task, agentDir);
      task.reportIds = [...(task.reportIds ?? []), reportId];
    }
    task.archived = request.archived;
    task.archiveRevision++;
  }
  // Archive is not editing, moving, completing or publishing knowledge. Preserve
  // every other field, timestamp and independent CAS/receipt, even for a no-op.
  task.archiveReceipt = { operationId: request.operationId, fingerprint };
  return true;
}
