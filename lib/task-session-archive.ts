import { createHash } from "node:crypto";
import { archiveRequestFingerprint, setTaskArchive, type ArchiveRequest } from "./task-archive";
import { relationGeneration } from "./task-relations";
import { resolveFamilyRoots } from "./session-family";
import { listSessionArchiveMetadata, invalidateSessionListCache } from "./session-reader";
import { archiveSessionBatchOnce, isSessionArchiveError, isSessionArchiveId } from "./session-archive";
import { taskSessionPathInScope } from "./task-sessions";
import { publicTask, publicTaskBoard, withTaskStore, type StoredTaskRecord, type TaskDocument } from "./task-store";
import { TaskOperationError, type TaskArchivePreview, type TaskArchiveSkipped, type TaskMutationResult } from "./task-types";

/** Called under the board lock. The token binds exact membership/epochs and the complete
 * effective family scope, including other owners. Busy state/archive flags are not admission. */
export async function previewTaskSessionArchive(document: TaskDocument, task: StoredTaskRecord, agentDir: string, archiveRevision = task.archiveRevision): Promise<TaskArchivePreview> {
  const catalog = task.sessionIds.length ? await listSessionArchiveMetadata(agentDir) : [];
  const byId = new Map(catalog.map(session => [session.id, session]));
  const roots = resolveFamilyRoots(catalog.filter(session => !session.relationUnavailable));
  const owners = new Map(document.tasks.flatMap(owner => owner.sessionIds.map(id => [id, owner] as const)));
  const familyIds = new Set<string>(), skipped: TaskArchiveSkipped[] = [];
  const { getRpcSessionMetadata } = await import("./rpc-manager");
  const transientIds = new Set(getRpcSessionMetadata().filter(s => taskSessionPathInScope(agentDir, s.path)).map(s => s.id));
  for (const sessionId of [...task.sessionIds].sort()) {
    let reason: TaskArchiveSkipped["reason"] | undefined;
    if (!isSessionArchiveId(sessionId)) reason = "unsupported-id";
    else if (!byId.has(sessionId)) reason = transientIds.has(sessionId) ? "unpersisted" : "missing";
    else if (!roots.get(sessionId)) reason = "unresolved-family";
    else if (!isSessionArchiveId(roots.get(sessionId))) reason = "unsupported-id";
    if (reason) skipped.push({ sessionId, reason });
    else familyIds.add(roots.get(sessionId)!);
  }
  const families = [...familyIds].sort().map(rootSessionId => {
    const sessionIds = catalog.filter(s => roots.get(s.id) === rootSessionId).map(s => s.id).sort();
    const otherOwners = [...new Set(sessionIds.map(id => owners.get(id)).filter(owner => owner && owner.id !== task.id))]
      .sort((a, b) => a!.id.localeCompare(b!.id));
    const name = byId.get(rootSessionId)?.name;
    return { rootSessionId, ...(name ? { name } : {}), sessionIds,
      otherTasks: otherOwners.map(owner => ({ id: owner!.id, title: owner!.title, sessionIds: sessionIds.filter(id => owners.get(id)?.id === owner!.id) })) };
  });
  const linkedSessionIds = [...task.sessionIds].sort();
  const identity = [task.id, task.revision, archiveRevision,
    linkedSessionIds.map(id => [id, relationGeneration(document, id)]), skipped,
    families.map(family => [family.rootSessionId, family.sessionIds.map(id => [id, owners.get(id)?.id ?? null, relationGeneration(document, id)]), family.otherTasks])];
  const token = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  return { taskId: task.id, archiveRevision, token, linkedSessionIds, families, skipped };
}
function findTask(document: TaskDocument, id: string): StoredTaskRecord {
  const task = document.tasks.find(task => task.id === id);
  if (!task) throw new TaskOperationError("not-found", "Task not found. Reload the board.");
  return task;
}
function response(document: TaskDocument, task: StoredTaskRecord): TaskMutationResult {
  const cascade = task.archiveReceipt!.cascade!;
  return { task: publicTask(task), board: publicTaskBoard(document),
    sessionArchive: { rootSessionIds: cascade.rootSessionIds, skipped: cascade.skipped } };
}

/** Two durable commits, NOT a cross-file transaction. Reserve a fixed intent before effects.
 * Every effect application holds board -> archive locks in that order. Restoring/reassigning
 * can fence uncommitted work; the atomic archive receipt confirms committed work without replay. */
export async function archiveTaskWithSessions(request: ArchiveRequest, agentDir: string): Promise<TaskMutationResult> {
  const fingerprint = archiveRequestFingerprint(request);
  const pending = await withTaskStore(agentDir, async document => {
    const task = findTask(document, request.id);
    if (task.archiveReceipt?.operationId === request.operationId) {
      await setTaskArchive(task, request); // Exact identity check before confirming old effects.
      if (!task.archiveReceipt.cascade) throw new TaskOperationError("conflict", "This archive operation has no linked conversation intent.");
      return { value: task.archiveReceipt.cascade.status === "pending", changed: false };
    }
    if (task.archiveRevision !== request.expectedArchiveRevision) throw new TaskOperationError("conflict", "Archive state changed. Review the task archive again; no changes were saved.");
    // Every fresh cascade must cross active -> archived, advancing the monotonic fence.
    // A new same-state receipt would otherwise let a superseded batch pass old CAS again.
    if (task.archived) throw new TaskOperationError("conflict", "This task is already archived. Retry its original pending intent, or explicitly restore it before reviewing a new archive.");
    const preview = await previewTaskSessionArchive(document, task, agentDir);
    if (preview.token !== request.cascade!.previewToken) throw new TaskOperationError("conflict", "Linked conversations or their families changed. Review the archive again; no changes were saved.");
    if (preview.families.some(family => family.otherTasks.length) && !request.cascade!.confirmCrossTask) throw new TaskOperationError("conflict", "Confirm the impact on other tasks' conversation families before archiving. Nothing was changed.");
    await setTaskArchive(task, request);
    task.archiveReceipt!.cascade = { status: "pending", expectedArchiveRevision: request.expectedArchiveRevision,
      previewToken: preview.token, confirmCrossTask: request.cascade!.confirmCrossTask,
      rootSessionIds: preview.families.map(family => family.rootSessionId), skipped: preview.skipped };
    return { value: true, changed: true };
  });
  return withTaskStore(agentDir, async (document, assertBoardLock) => {
    const task = findTask(document, request.id), receipt = task.archiveReceipt;
    if (receipt?.operationId !== request.operationId || receipt.fingerprint !== fingerprint || !receipt.cascade || !task.archived) {
      throw new TaskOperationError("conflict", "A later task archive or restore replaced this intent. No old conversation batch was replayed.");
    }
    const cascade = receipt.cascade;
    if (!pending || cascade.status === "completed") return { value: response(document, task), changed: false };
    try {
      await archiveSessionBatchOnce({ taskId: task.id, operationId: request.operationId, fingerprint,
        sessionIds: cascade.rootSessionIds }, agentDir, async () => {
        const current = await previewTaskSessionArchive(document, task, agentDir, cascade.expectedArchiveRevision);
        return current.token === cascade.previewToken
          && JSON.stringify(current.families.map(family => family.rootSessionId)) === JSON.stringify(cascade.rootSessionIds)
          && JSON.stringify(current.skipped) === JSON.stringify(cascade.skipped);
      }, assertBoardLock);
    } catch (error) {
      if (isSessionArchiveError(error) && error.code === "scope-changed") throw new TaskOperationError("conflict", "The task is archived, but the linked conversation scope changed before application. Restore and review a new archive intent; this batch was not replayed.");
      throw new TaskOperationError("storage-unavailable", "The task may be archived, but its conversation batch was not confirmed. Retry the same intent or explicitly restore the task to cancel pending work.");
    }
    // Invalidate even if the subsequent board completion write fails or its response is lost.
    invalidateSessionListCache();
    cascade.status = "completed";
    return { value: response(document, task), changed: true };
  });
}
