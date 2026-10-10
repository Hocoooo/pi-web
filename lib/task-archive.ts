import { createHash } from "node:crypto";
import { TASK_ID_PATTERN, TaskOperationError, type TaskRequest } from "./task-types";
import type { StoredTaskRecord } from "./task-store";

export type ArchiveRequest = Extract<TaskRequest, { action: "set-archive" }>;
export function parseArchiveRequest(v: Record<string, unknown>): ArchiveRequest {
  if (Object.keys(v).length !== 5 || Object.keys(v).some(k => !["action", "id", "archived", "expectedArchiveRevision", "operationId"].includes(k))
    || typeof v.id !== "string" || !TASK_ID_PATTERN.test(v.id) || typeof v.archived !== "boolean"
    || !Number.isSafeInteger(v.expectedArchiveRevision) || (v.expectedArchiveRevision as number) < 0
    || typeof v.operationId !== "string" || !TASK_ID_PATTERN.test(v.operationId)) throw new TaskOperationError("invalid-input", "Invalid archive request.");
  return v as ArchiveRequest;
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
export async function setTaskArchive(task: StoredTaskRecord, request: ArchiveRequest): Promise<boolean> {
  const fingerprint = createHash("sha256").update(JSON.stringify([request.id, request.archived, request.expectedArchiveRevision])).digest("hex");
  if (task.archiveReceipt?.operationId === request.operationId) {
    if (task.archiveReceipt.fingerprint !== fingerprint) throw new TaskOperationError("conflict", "This archive operation ID was used for another request.");
    return false;
  }
  if (task.archiveRevision !== request.expectedArchiveRevision) throw new TaskOperationError("conflict", "Archive state changed in another page. Refresh and explicitly choose archive or restore again; no changes were saved.");
  // Visibility only: archiving never waits for, stops, or restricts session work.
  if (task.archived !== request.archived) {
    if (task.archiveRevision === Number.MAX_SAFE_INTEGER) throw new TaskOperationError("storage-unavailable", "Archive revision limit reached; no changes were saved.");
    task.archived = request.archived;
    task.archiveRevision++;
  }
  // Archive is not editing, moving, completing or publishing knowledge. Preserve
  // every other field, timestamp and independent CAS/receipt, even for a no-op.
  task.archiveReceipt = { operationId: request.operationId, fingerprint };
  return true;
}
