import { relationGeneration, assertRelationGeneration, associateRelation, parseRelationRequest, changeSessionRelation } from "./task-relations";
import { assertTaskActive, parseArchiveRequest, setTaskArchive } from "./task-archive";
import { parseStartRequest, prepareTaskStart, admitTaskStart } from "./task-start";
import { parseContextUpdateRequest, validateUpdateSession, updateState, selectContextUpdate, clearContextUpdate, completeContextUpdate, updateMaterial, readContextUpdateState } from "./task-context-updates";
import type { TaskContextUpdateState, TaskUpdateChoice, TaskStartSnapshot, TaskSessionTaskResult, TaskPickerResult } from "./task-types";
export type PendingContextUpdate = { taskId: string; relationGeneration: number; choice: TaskUpdateChoice; snapshot: TaskStartSnapshot } | null;
import type { TaskStartPreview, TaskSessionContext } from "./task-types";
import { createHash } from "node:crypto";
import type { SessionCopyReceipt } from "./task-session-copy";
type CopyOperationResult = { receipt: SessionCopyReceipt; fresh: boolean };
import { parseSaveView, publicTaskView, saveTaskView } from "./task-saved-views";
import { parseContextRequest, publishContext } from "./task-context";
import { generatedSummarySource, type SummaryDependencies } from "./task-summary";
import type { TaskSummaryResponse } from "./task-summary-types";
import { normalizeCwd, validatedCwd } from "./validated-cwd";
import { resolveProjectAuthoritatively } from "./worktree";
import { projectIdentityKey } from "./project-identity";
import { isChatWorkspace } from "./chat-workspace";
import { publicTask, taskCreationFingerprint, taskColumnRemovalDigest, withTaskStore, type StoredTaskRecord } from "./task-store";
import { taskSessionCatalogue, sameTaskSessionProject, publicTaskSession } from "./task-sessions";
import { isTaskSessionId, TASK_SESSION_BATCH_LIMIT, type TaskSessionsResult, DEFAULT_TASK_PRIORITY, isCompletionColumn, isTaskColumn, isTaskColumnId, isTaskColumnLabel, isTaskLabel, isTaskPriority, TASK_COLUMNS, TASK_COLUMN_LIMITS, TASK_ID_PATTERN, TASK_LABEL_LIMITS, TASK_TEXT_LIMITS, TaskOperationError, type TaskBoard, type TaskColumnConfig, type TaskProject, type TaskMutationResult, type TaskRequest } from "./task-types";

function invalid(message: string): never { throw new TaskOperationError("invalid-input", message); }
function parseRequest(input: unknown, sessionCopy = false): TaskRequest {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return invalid("A task operation is required.");
  const value = input as Record<string, unknown>;
  if (value.action === "prepare-session-copy" || value.action === "complete-session-copy") {
    const keys = ["action", "operationId", "sourceSessionId", "fingerprint", ...(value.action === "complete-session-copy" ? ["newSessionId"] : [])];
    if (!sessionCopy || Object.keys(value).some((key) => !keys.includes(key))
      || typeof value.operationId !== "string" || !TASK_ID_PATTERN.test(value.operationId) || !isTaskSessionId(value.sourceSessionId)
      || typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.fingerprint)
      || value.action === "complete-session-copy" && value.newSessionId !== null && !isTaskSessionId(value.newSessionId)) return invalid("Invalid internal session copy request.");
    return value as Extract<TaskRequest, { action: "prepare-session-copy" | "complete-session-copy" }>;
  }
  if (value.action === "task-picker") {
    if (Object.hasOwn(value, "sessionId")) {
      if (Object.keys(value).some(key => !["action", "sessionId"].includes(key)) || !isTaskSessionId(value.sessionId)) return invalid("A valid session ID is required, without a project directory.");
      return { action: "task-picker", sessionId: value.sessionId };
    }
    if (Object.keys(value).some(key => !["action", "cwd"].includes(key))
      || value.cwd !== null && (typeof value.cwd !== "string" || !value.cwd.trim() || value.cwd.length > 4096)) return invalid("Select one project directory or no project.");
    return { action: "task-picker", cwd: value.cwd as string | null };
  }
  if (value.action === "session-task") {
    if (Object.keys(value).some(key => !["action", "sessionId"].includes(key)) || !isTaskSessionId(value.sessionId)) return invalid("A valid session ID is required.");
    return { action: "session-task", sessionId: value.sessionId };
  }
  if (value.action === "change-session-relation") return parseRelationRequest(value);
  if (value.action === "remove-column") {
    if (Object.keys(value).some(key => !["action", "columnId", "targetColumnId", "expectedColumnsRevision", "expectedOrderRevision", "expectedSourceDigest", "confirmCompletion", "operationId"].includes(key))
      || !isTaskColumnId(value.columnId) || !isTaskColumnId(value.targetColumnId) || value.columnId === value.targetColumnId
      || !Number.isSafeInteger(value.expectedColumnsRevision) || (value.expectedColumnsRevision as number) < 0
      || !Number.isSafeInteger(value.expectedOrderRevision) || (value.expectedOrderRevision as number) < 0
      || typeof value.confirmCompletion !== "boolean" || typeof value.operationId !== "string" || !TASK_ID_PATTERN.test(value.operationId)
      || typeof value.expectedSourceDigest !== "string" || value.expectedSourceDigest.length !== 64 || !/^[0-9a-f]{64}$/.test(value.expectedSourceDigest)) return invalid("Choose a source, a different receiving column and its full removal digest.");
    return { action: "remove-column", columnId: value.columnId, targetColumnId: value.targetColumnId,
      expectedColumnsRevision: value.expectedColumnsRevision as number, expectedOrderRevision: value.expectedOrderRevision as number,
      expectedSourceDigest: value.expectedSourceDigest, confirmCompletion: value.confirmCompletion, operationId: value.operationId };
  }
  if (["context-update-state", "accept-context-update", "clear-context-update", "pending-context-update", "complete-context-update"].includes(value.action as string)) return parseContextUpdateRequest(value);
  if (value.action === "set-archive") return parseArchiveRequest(value);
  if (value.action === "admit-session-work") {
    if (Object.keys(value).some(k => !["action", "sessionId", "taskId"].includes(k)) || !isTaskSessionId(value.sessionId)
      || Object.hasOwn(value, "taskId") && (typeof value.taskId !== "string" || !TASK_ID_PATTERN.test(value.taskId))) return invalid("Invalid session admission request.");
    return value as Extract<TaskRequest, { action: "admit-session-work" }>;
  }
  if (value.action === "prepare-start" || value.action === "admit-start") return parseStartRequest(value);
  if (value.action === "save-view") return parseSaveView(value);
  if (value.action === "publish-context" || value.action === "restore-context") return parseContextRequest(value);
  const keys = value.action === "list" ? ["action"] : value.action === "set-columns" ? ["action", "expectedColumnsRevision", "columns"] : value.action === "create"
    ? ["action", "id", "title", "description", "completionCriteria", "cwd"]
    : value.action === "move" ? ["action", "id", "columnId", "expectedRevision", "expectedOrderRevision", "operationId", "position"]
    : value.action === "edit" ? ["action", "id", "title", "description", "completionCriteria", "priority", "labels", "expectedRevision"]
    : value.action === "createFromSession" ? ["action", "id", "title", "description", "completionCriteria", "sourceSessionId"]
    : value.action === "sessions" ? ["action", "id"]
    : value.action === "link" ? ["action", "id", "expectedRevision", "sessionIds"] : null;
  if (!keys || Object.keys(value).some((key) => !keys.includes(key))) return invalid("Unknown task operation or field.");
  if (value.action === "list") return { action: "list" };
  if (value.action === "set-columns") {
    if (!Number.isSafeInteger(value.expectedColumnsRevision) || (value.expectedColumnsRevision as number) < 0) return invalid("A columns revision is required.");
    if (!Array.isArray(value.columns) || value.columns.length < 2 || value.columns.length > TASK_COLUMN_LIMITS.count) return invalid(`Use between 2 and ${TASK_COLUMN_LIMITS.count} columns.`);
    const columns: TaskColumnConfig[] = Array.from(value.columns).map((column) => {
      if (typeof column !== "object" || column === null || Array.isArray(column)
        || Object.keys(column).some((key) => key !== "id" && key !== "label") || !isTaskColumnId(column.id)) return invalid("Each column needs a stable ID and name; completion identity cannot be edited.");
      if (column.label === null && TASK_COLUMNS.some((initial) => initial.id === column.id)) return { id: column.id, label: null };
      if (!isTaskColumnLabel(column.label)) return invalid(`Column names must be non-empty single-line text of at most ${TASK_COLUMN_LIMITS.label} characters.`);
      return { id: column.id, label: column.label.trim() };
    });
    if (new Set(columns.map((column) => column.id)).size !== columns.length) return invalid("Column IDs must be unique.");
    return { action: "set-columns", expectedColumnsRevision: value.expectedColumnsRevision as number, columns };
  }
  if (typeof value.id !== "string" || !TASK_ID_PATTERN.test(value.id)) return invalid("A valid task UUID is required.");
  if (value.action === "sessions") return { action: "sessions", id: value.id };
  if (value.action === "move" || value.action === "edit" || value.action === "link") {
    if (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 1) return invalid("A task revision is required.");
  }
  if (value.action === "link") {
    if (!Array.isArray(value.sessionIds) || value.sessionIds.length === 0 || value.sessionIds.length > TASK_SESSION_BATCH_LIMIT
      || Array.from(value.sessionIds).some((id) => !isTaskSessionId(id))) return invalid(`Choose 1 to ${TASK_SESSION_BATCH_LIMIT} valid session IDs.`);
    return { action: "link", id: value.id, expectedRevision: value.expectedRevision as number, sessionIds: [...new Set(value.sessionIds as string[])] };
  }
  if (value.action === "move") {
    if (!isTaskColumnId(value.columnId)) return invalid("Choose an existing task column.");
    if (!Number.isSafeInteger(value.expectedOrderRevision) || (value.expectedOrderRevision as number) < 0) return invalid("A board order revision is required.");
    if (typeof value.operationId !== "string" || !TASK_ID_PATTERN.test(value.operationId)) return invalid("A move operation UUID is required.");
    const position = value.position;
    if (typeof position !== "object" || position === null || Array.isArray(position) || Object.keys(position).length !== 1) return invalid("Choose one move anchor.");
    const anchor = position as Record<string, unknown>;
    const anchorKey = Object.keys(anchor)[0];
    if (anchorKey === "edge" ? anchor.edge !== "start" && anchor.edge !== "end"
      : !["before", "after"].includes(anchorKey) || typeof anchor[anchorKey] !== "string" || !TASK_ID_PATTERN.test(anchor[anchorKey] as string)) return invalid("Choose a valid move anchor.");
    return { action: "move", id: value.id, columnId: value.columnId, expectedRevision: value.expectedRevision as number,
      expectedOrderRevision: value.expectedOrderRevision as number, operationId: value.operationId, position: value.position as Extract<TaskRequest, { action: "move" }>["position"] };
  }
  for (const key of ["title", "description", "completionCriteria"] as const) {
    if (typeof value[key] !== "string" || value[key].length > TASK_TEXT_LIMITS[key]) return invalid(`${key} must be text of at most ${TASK_TEXT_LIMITS[key]} characters.`);
  }
  if (!(value.title as string).trim()) return invalid("A task title is required.");
  if (value.action === "edit") {
    if (!isTaskPriority(value.priority)) return invalid("Choose a priority from 0 (low) to 3 (urgent).");
    if (!Array.isArray(value.labels) || value.labels.length > TASK_LABEL_LIMITS.count
      || Array.from(value.labels).some((label) => !isTaskLabel(label))) {
      return invalid(`Use at most ${TASK_LABEL_LIMITS.count} non-empty single-line labels of at most ${TASK_LABEL_LIMITS.length} characters.`);
    }
    return { action: "edit", id: value.id, expectedRevision: value.expectedRevision as number,
      title: (value.title as string).trim(), description: value.description as string, completionCriteria: value.completionCriteria as string,
      priority: value.priority, labels: [...new Set((value.labels as string[]).map((label) => label.trim()))] };
  }
  if (value.action === "createFromSession") {
    if (!isTaskSessionId(value.sourceSessionId)) return invalid("Choose an existing source session ID.");
    return { action: "createFromSession", id: value.id, title: (value.title as string).trim(), description: value.description as string,
      completionCriteria: value.completionCriteria as string, sourceSessionId: value.sourceSessionId };
  }
  if (value.cwd !== null && (typeof value.cwd !== "string" || !value.cwd.trim() || value.cwd.length > 4096)) return invalid("Select one project directory or no project.");
  return { ...(value as Extract<TaskRequest, { action: "create" }>), title: (value.title as string).trim() };
}
async function selectedProject(cwd: string | null, agentDir: string): Promise<TaskProject | null> {
  if (cwd === null) return null;
  let normalized: string;
  try { normalized = validatedCwd(cwd); }
  catch (error) { return invalid((error as Error).message); }
  if (isChatWorkspace(normalized, agentDir)) return null;
  const project = await resolveProjectAuthoritatively(normalized);
  return { cwd: normalized, projectRoot: project.projectRoot, projectKey: projectIdentityKey(project.projectRoot) };
}

/** Single task boundary. Legacy context data remains readable, but new context work is suspended. */
export async function taskOperation(input: unknown, options: { agentDir: string; signal?: AbortSignal; summaryDeps?: SummaryDependencies; sessionCopy?: boolean }): Promise<TaskBoard | TaskMutationResult | TaskSessionsResult | TaskSessionTaskResult | TaskPickerResult | TaskSummaryResponse | CopyOperationResult | TaskStartPreview | TaskContextUpdateState | PendingContextUpdate | { context: TaskSessionContext | null }> {
  // Refuse before opening (or migrating) storage, loading histories or invoking providers.
  if (typeof input === "object" && input !== null && "action" in input && typeof input.action === "string"
    && (input.action.startsWith("summary-") || ["publish-context", "restore-context", "prepare-start", "admit-start",
      "context-update-state", "accept-context-update", "clear-context-update", "pending-context-update", "complete-context-update"].includes(input.action))) {
    throw new TaskOperationError("invalid-input", "Task shared context and task-start are suspended. Use ordinary chat and manage task links separately. Nothing was changed or sent.");
  }
  const request = parseRequest(input, options.sessionCopy);
  // Compatibility for older in-process callers: task visibility never gates session work.
  // In particular, ordinary chat must not depend on task-store availability or migration.
  if (request.action === "admit-session-work") return { context: null };
  return withTaskStore<TaskBoard | TaskMutationResult | TaskSessionsResult | TaskSessionTaskResult | TaskPickerResult | CopyOperationResult | TaskStartPreview | TaskContextUpdateState | PendingContextUpdate | { context: TaskSessionContext | null }>(options.agentDir, async (document) => {
    const board = (): TaskBoard => ({ columnRemovalDigests: Object.fromEntries(document.columns.map(column => [column.id, taskColumnRemovalDigest(document.tasks, column.id)])), viewsRevision: document.viewsRevision, savedViews: document.savedViews.map(publicTaskView), orderRevision: document.orderRevision, columnsRevision: document.columnsRevision,
      columns: document.columns.map((column) => ({ ...column, isCompletion: isCompletionColumn(column.id) })), tasks: document.tasks.map(publicTask) });
    const result = (task: StoredTaskRecord, changed: boolean) => ({ value: { task: publicTask(task), board: board() }, changed });
    const bumpOrder = () => {
      if (document.orderRevision === Number.MAX_SAFE_INTEGER) throw new TaskOperationError("storage-unavailable", "Task order revision limit reached; no changes were saved.");
      document.orderRevision++;
    };
    if (request.action === "task-picker") {
      let project: TaskProject | null;
      let relation: TaskPickerResult["relation"] = null;
      if (request.sessionId !== undefined) {
        const session = (await taskSessionCatalogue(options.agentDir)).find(session => session.id === request.sessionId);
        if (!session) throw new TaskOperationError("not-found", "Session no longer exists.");
        project = session.project;
        const owner = document.tasks.find(task => task.sessionIds.includes(request.sessionId!));
        relation = { sessionId: request.sessionId, sourceTaskId: owner?.id ?? null,
          generation: relationGeneration(document, request.sessionId), updateRevision: owner ? updateState(owner, request.sessionId).revision : 0 };
      } else project = await selectedProject(request.cwd, options.agentDir);
      const tasks = document.tasks.filter(task => (task.project?.projectKey ?? null) === (project?.projectKey ?? null))
        .map(task => {
          const column = document.columns.find(column => column.id === task.columnId)!;
          return { id: task.id, title: task.title, archived: task.archived, revision: task.revision,
            status: column.label ?? task.columnId, ...(column.label === null ? {statusKey: column.id} : {}) };
        });
      return { value: { tasks, relation }, changed: false };
    }
    if (request.action === "session-task") {
      const owner = document.tasks.find(task => task.sessionIds.includes(request.sessionId));
      return { value: { task: owner ? { id: owner.id, title: owner.title, archived: owner.archived } : null }, changed: false };
    }
    if (request.action === "change-session-relation") {
      const changed = await changeSessionRelation(document, request, options.agentDir);
      return { value: board(), changed };
    }
    if (request.action === "prepare-session-copy" || request.action === "complete-session-copy") {
      const receipt = document.sessionCopies.find((r) => r.operationId === request.operationId);
      if (receipt && (receipt.fingerprint !== request.fingerprint || receipt.sourceSessionId !== request.sourceSessionId)) throw new TaskOperationError("conflict", "This copy ID was used for another request.");
      if (receipt?.status === "completed") {
        if (request.action === "complete-session-copy" && request.newSessionId !== receipt.newSessionId) throw new TaskOperationError("conflict", "This copy already completed with another session.");
        return { value: { receipt: { ...receipt }, fresh: false }, changed: false };
      }
      const owner = document.tasks.find((task) => task.sessionIds.includes(request.sourceSessionId));
      if (request.action === "prepare-session-copy") {
        if (receipt) {
          assertRelationGeneration(document, request.sourceSessionId, receipt.sourceRelationGeneration ?? 0);
          if ((owner?.id ?? null) !== receipt.taskId) throw new TaskOperationError("conflict", "Source relationship changed. Old copy intent cannot execute.");
          return { value: { receipt: { ...receipt }, fresh: false }, changed: false };
        }
        const prepared: SessionCopyReceipt = { operationId: request.operationId, fingerprint: request.fingerprint, sourceSessionId: request.sourceSessionId,
          sourceRelationGeneration: relationGeneration(document, request.sourceSessionId), taskId: owner?.id ?? null, status: "prepared", newSessionId: null };
        document.sessionCopies.push(prepared);
        return { value: { receipt: { ...prepared }, fresh: true }, changed: true };
      }
      if (!receipt) throw new TaskOperationError("not-found", "Session copy intent not found.");
      assertRelationGeneration(document, request.sourceSessionId, receipt.sourceRelationGeneration ?? 0);
      if ((owner?.id ?? null) !== receipt.taskId) throw new TaskOperationError("conflict", "Source task relationship changed during copying. No relationship was inherited.");
      if (request.newSessionId !== null) {
        if (request.newSessionId === request.sourceSessionId || document.sessionCopies.some((r) => r.newSessionId === request.newSessionId)) throw new TaskOperationError("conflict", "This session already belongs to a different copy operation.");
        if (document.tasks.some((task) => task.sessionIds.includes(request.newSessionId!))) throw new TaskOperationError("conflict", "Copied session already belongs to a task. No relationship was changed.");
        if (owner) {
          const catalogue = await taskSessionCatalogue(options.agentDir);
          const source = catalogue.find((session) => session.id === request.sourceSessionId);
          const child = catalogue.find((session) => session.id === request.newSessionId);
          if (!source || !child) throw new TaskOperationError("not-found", "Source or copied session no longer exists. No relationship was inherited.");
          if (!sameTaskSessionProject(owner.project, source) || !sameTaskSessionProject(owner.project, child)) return invalid("Copied session is outside the task's current project scope. No relationship was inherited.");
          if (owner.revision === Number.MAX_SAFE_INTEGER) throw new TaskOperationError("storage-unavailable", "Task revision limit reached; no relationship was inherited.");
          associateRelation(document, child.id);
          owner.sessionIds.push(child.id);
          owner.revision++;
          owner.updatedAt = new Date(Math.max(Date.now(), Date.parse(owner.updatedAt) + 1)).toISOString();
        }
      }
      receipt.newSessionId = request.newSessionId;
      receipt.status = "completed";
      return { value: { receipt: { ...receipt }, fresh: false }, changed: true };
    }
    if (request.action === "context-update-state" || request.action === "pending-context-update") {
      const owner = document.tasks.find(t => t.sessionIds.includes(request.sessionId));
      if (request.action === "context-update-state") return { value: await readContextUpdateState(owner, request.sessionId, options.agentDir, relationGeneration(document, request.sessionId)), changed: false };
      if (!owner) return { value: null, changed: false };
      assertTaskActive(owner);
      await validateUpdateSession(owner, request.sessionId, options.agentDir);
      const state = updateState(owner, request.sessionId), choice = state.choices.find(c => c.operationId === state.pendingOperationId);
      const generation = relationGeneration(document, request.sessionId);
      return { value: choice && (choice.relationGeneration ?? 0) === generation ? { taskId: owner.id, relationGeneration: generation, choice, snapshot: updateMaterial(owner, choice) } : null, changed: false };
    }
    if (request.action === "list") return { value: board(), changed: false };
    if (request.action === "save-view") {
      const changed = saveTaskView(document, request);
      return { value: board(), changed };
    }
    if (request.action === "remove-column") {
      const fingerprint = createHash("sha256").update(JSON.stringify([request.columnId, request.targetColumnId,
        request.expectedColumnsRevision, request.expectedOrderRevision, request.expectedSourceDigest, request.confirmCompletion])).digest("hex");
      // Confirm only the latest exact deletion, even after its source no longer exists.
      if (document.columnRemovalReceipt?.operationId === request.operationId) {
        if (document.columnRemovalReceipt.fingerprint !== fingerprint) throw new TaskOperationError("conflict", "This removal ID was used for another request.");
        return { value: board(), changed: false };
      }
      if (document.columnsRevision !== request.expectedColumnsRevision || document.orderRevision !== request.expectedOrderRevision) throw new TaskOperationError("conflict", "Columns or task order changed. Cancel removal, refresh and review the full affected scope again.");
      if (!isTaskColumn(request.columnId, document.columns) || !isTaskColumn(request.targetColumnId, document.columns)) return invalid("Choose existing source and receiving columns.");
      if (isCompletionColumn(request.columnId) || document.columns.filter(column => !isCompletionColumn(column.id)).length <= 1) return invalid("The completion column and last unfinished column cannot be removed.");
      if (isCompletionColumn(request.targetColumnId) && !request.confirmCompletion) return invalid("Separately confirm that all affected tasks will be marked complete.");
      const affected = document.tasks.filter(task => task.columnId === request.columnId);
      if (taskColumnRemovalDigest(document.tasks, request.columnId) !== request.expectedSourceDigest) throw new TaskOperationError("conflict", "Affected tasks changed. Cancel removal, refresh and review all tasks again.");
      if (document.columnsRevision === Number.MAX_SAFE_INTEGER || affected.some(task => task.revision === Number.MAX_SAFE_INTEGER)) throw new TaskOperationError("storage-unavailable", "Revision limit reached; no changes were saved.");
      // Append the entire source projection, preserving every independent domain.
      if (affected.length) {
        bumpOrder();
        const remaining = document.tasks.filter(task => task.columnId !== request.columnId);
        const lastTarget = remaining.findLastIndex(task => task.columnId === request.targetColumnId);
        for (const task of affected) {
          task.columnId = request.targetColumnId; task.revision++;
          task.updatedAt = new Date(Math.max(Date.now(), Date.parse(task.updatedAt) + 1)).toISOString();
        }
        const index = lastTarget < 0 ? remaining.length : lastTarget + 1;
        document.tasks = [...remaining.slice(0, index), ...affected, ...remaining.slice(index)];
      }
      document.columns = document.columns.filter(column => column.id !== request.columnId);
      document.columnsRevision++;
      document.columnRemovalReceipt = { operationId: request.operationId, fingerprint };
      return { value: board(), changed: true };
    }
    if (request.action === "set-columns") {
      if (document.columnsRevision !== request.expectedColumnsRevision) throw new TaskOperationError("conflict", "Columns changed in another page. Refresh, then cancel and reopen column settings to use the saved configuration; your draft was not saved.");
      // Configuration edits never bypass dedicated full-scope removal confirmation.
      if (document.columns.some((column) => !isTaskColumn(column.id, request.columns))) return invalid("Column removal is not supported. Keep every existing column, including the completion column.");
      if (!request.columns.some((column) => isCompletionColumn(column.id)) || !request.columns.some((column) => !isCompletionColumn(column.id))) return invalid("Keep one completion column and at least one unfinished column.");
      if (JSON.stringify(document.columns) === JSON.stringify(request.columns)) return { value: board(), changed: false };
      if (document.columnsRevision === Number.MAX_SAFE_INTEGER) throw new TaskOperationError("storage-unavailable", "Columns revision limit reached; no changes were saved.");
      document.columns = request.columns;
      document.columnsRevision++;
      return { value: board(), changed: true };
    }
    const existing = document.tasks.find((task) => task.id === request.id);
    if (request.action === "create" || request.action === "createFromSession") {
      const cwd = request.action === "createFromSession" || request.cwd === null ? null : normalizeCwd(request.cwd);
      const creationFingerprint = taskCreationFingerprint({ ...request, cwd: cwd !== null && isChatWorkspace(cwd, options.agentDir) ? null : cwd });
      if (existing) {
        if (existing.creationFingerprint !== creationFingerprint) {
          throw new TaskOperationError("conflict", "This task ID was already used for different content. Reload before creating another task.");
        }
        return result(existing, false);
      }
      // A genuinely new UUID still validates today's directory and project rules,
      // under the same lock that checked for an already committed create.
      let project: TaskProject | null;
      let sessionIds: string[] = [];
      if (request.action === "createFromSession") {
        const source = (await taskSessionCatalogue(options.agentDir)).find((session) => session.id === request.sourceSessionId);
        if (!source) throw new TaskOperationError("not-found", "Source session no longer exists. No task was created.");
        if (document.tasks.some((task) => task.sessionIds.includes(source.id))) throw new TaskOperationError("conflict", "Source session already belongs to a task. No task was created.");
        project = source.project;
        sessionIds = [source.id];
      } else project = await selectedProject(request.cwd, options.agentDir);
      const now = new Date().toISOString();
      for (const sessionId of sessionIds) associateRelation(document, sessionId);
      const task: StoredTaskRecord = { archived: false, archiveRevision: 0, creationFingerprint, sharedContext: { currentVersionId: null, versions: [] }, id: request.id, title: request.title, description: request.description, completionCriteria: request.completionCriteria, priority: DEFAULT_TASK_PRIORITY, labels: [], project, sessionIds, sessionContexts: [], sessionUpdates: [], columnId: document.columns.find(column => column.id === "todo")?.id ?? document.columns.find(column => !isCompletionColumn(column.id))!.id, revision: 1, createdAt: now, updatedAt: now };
      bumpOrder();
      document.tasks.push(task);
      return result(task, true);
    }
    if (!existing) throw new TaskOperationError("not-found", "Task not found. Reload the board.");
    if (request.action === "accept-context-update" || request.action === "clear-context-update" || request.action === "complete-context-update") {
      // Selecting/clearing intent can persist while archived, but reporting a
      // send can never bypass the same active guard as original admission.
      if (request.action === "complete-context-update") assertTaskActive(existing);
      await validateUpdateSession(existing, request.sessionId, options.agentDir);
      const generation = relationGeneration(document, request.sessionId);
      if (request.action === "complete-context-update") {
        // Exact successful receipts confirm history, but cannot add a late old-epoch delivery.
        if (updateState(existing, request.sessionId).deliveries.some(d => d.operationId === request.delivery.operationId)) return result(existing, false);
        assertRelationGeneration(document, request.sessionId, request.relationGeneration ?? 0);
        const choice = updateState(existing, request.sessionId).choices.find(c => c.operationId === request.delivery.operationId);
        if (!choice || (choice.relationGeneration ?? 0) !== generation) throw new TaskOperationError("conflict", "Old context choice cannot complete under a new relationship.");
      } else assertRelationGeneration(document, request.sessionId, request.expectedRelationGeneration ?? 0);
      if (request.action === "accept-context-update" && document.tasks.some(task =>
        task.sessionContexts.some(c => c.operationId === request.operationId)
        || task.sessionUpdates.some(s => (task.id !== request.id || s.sessionId !== request.sessionId) && s.choices.some(c => c.operationId === request.operationId)))) {
        throw new TaskOperationError("conflict", "This context operation ID belongs to another session or initial task start.");
      }
      const changed = request.action === "accept-context-update" ? selectContextUpdate(existing, request, generation)
        : request.action === "clear-context-update" ? clearContextUpdate(existing, request.sessionId, request.expectedRevision)
        : completeContextUpdate(existing, request.sessionId, request.delivery);
      return result(existing, changed);
    }
    if (request.action === "set-archive") return result(existing, await setTaskArchive(existing, request));
    if (request.action === "prepare-start") { assertTaskActive(existing); return { value: await prepareTaskStart(existing, request.operationId, request.sessionId, options.agentDir, relationGeneration(document, request.sessionId ?? request.operationId)), changed: false }; }
    if (request.action === "admit-start") {
      assertTaskActive(existing);
      const admitted = await admitTaskStart(document.tasks, existing, request.selection, request.realSessionId, options.agentDir, relationGeneration(document, request.realSessionId));
      if (admitted.changed) associateRelation(document, request.realSessionId);
      return { value: { context: admitted.context }, changed: admitted.changed };
    }
    if (request.action === "sessions" || request.action === "link") {
      const catalogue = await taskSessionCatalogue(options.agentDir);
      const byId = new Map(catalogue.map((session) => [session.id, session]));
      const owners = new Map(document.tasks.flatMap((task) => task.sessionIds.map((id) => [id, task.id] as const)));
      if (request.action === "sessions") return { value: {
        linked: existing.sessionIds.map((id) => byId.has(id) ? { ...publicTaskSession(byId.get(id)!), relationGeneration: relationGeneration(document, id), updateRevision: updateState(existing, id).revision } : { id, missing: true, running: false }),
        candidates: catalogue.filter((session) => !owners.has(session.id) && sameTaskSessionProject(existing.project, session)).map(publicTaskSession),
      }, changed: false };
      // Validate the ENTIRE batch before mutation (including already-linked IDs).
      for (const id of request.sessionIds) {
        const session = byId.get(id);
        if (!session) throw new TaskOperationError("not-found", "A selected session no longer exists. No sessions were linked.");
        if (!sameTaskSessionProject(existing.project, session)) return invalid("A selected session is outside this task's project. No sessions were linked.");
        if (owners.has(id) && owners.get(id) !== existing.id) throw new TaskOperationError("conflict", "A selected session belongs to another task. No sessions were linked.");
      }
      const additions = request.sessionIds.filter((id) => !owners.has(id));
      if (additions.length === 0) return result(existing, false);
      if (existing.revision !== request.expectedRevision) throw new TaskOperationError("conflict", "This task changed. Refresh before linking; no sessions were linked.");
      if (existing.revision === Number.MAX_SAFE_INTEGER) throw new TaskOperationError("storage-unavailable", "Task revision limit reached; no changes were saved.");
      for (const sessionId of additions) associateRelation(document, sessionId);
      existing.sessionIds.push(...additions);
      existing.revision++;
      existing.updatedAt = new Date(Math.max(Date.now(), Date.parse(existing.updatedAt) + 1)).toISOString();
      return result(existing, true);
    }
    if (request.action === "publish-context" || request.action === "restore-context") {
      // Committed exact receipts remain confirmable after restart/expiry without a second model call.
      const alreadyCommitted = existing.sharedContext.versions.some((v) => v.receipt.operationId === request.operationId);
      const source = request.action === "publish-context" && request.generationId && !alreadyCommitted
        ? await generatedSummarySource(existing, options.agentDir, request.generationId, request.expectedCurrentVersionId, options.summaryDeps, document) : undefined;
      const changed = publishContext(existing.sharedContext, request, source);
      // Knowledge has its own current-version CAS. Do not invalidate edit/move revisions or receipts.
      if (changed) existing.updatedAt = new Date(Math.max(Date.now(), Date.parse(existing.updatedAt) + 1)).toISOString();
      return result(existing, changed);
    }
    if (request.action === "edit") {
      // Drafts remain tied to their original snapshot, even if the page reloads the board.
      // Never infer an edit's identity from mutable fields or the original create fingerprint.
      if (existing.revision !== request.expectedRevision) throw new TaskOperationError("conflict", "This task changed in another page. Refresh before editing it again; your draft was not saved.");
      const details = { title: request.title, description: request.description, completionCriteria: request.completionCriteria, priority: request.priority, labels: request.labels };
      const unchanged = existing.title === details.title && existing.description === details.description
        && existing.completionCriteria === details.completionCriteria && existing.priority === details.priority
        && JSON.stringify(existing.labels) === JSON.stringify(details.labels);
      if (unchanged) return result(existing, false);
      if (existing.revision === Number.MAX_SAFE_INTEGER) throw new TaskOperationError("storage-unavailable", "Task revision limit reached; no changes were saved.");
      Object.assign(existing, details);
      existing.revision++;
      existing.updatedAt = new Date(Math.max(Date.now(), Date.parse(existing.updatedAt) + 1)).toISOString();
      return result(existing, true);
    }
    const fingerprint = createHash("sha256").update(JSON.stringify([
      request.id, request.columnId, request.expectedRevision, request.expectedOrderRevision, request.position,
    ])).digest("hex");
    if (existing.moveReceipt?.operationId === request.operationId) {
      if (existing.moveReceipt.fingerprint !== fingerprint) throw new TaskOperationError("conflict", "This move ID was already used for another request. Refresh before moving again.");
      return result(existing, false);
    }
    // Exact historical moves confirm before existence checks; never replay a deleted target.
    if (!isTaskColumn(request.columnId, document.columns)) return invalid("Choose an existing task column. Refresh before moving again.");
    if (existing.revision !== request.expectedRevision || document.orderRevision !== request.expectedOrderRevision) throw new TaskOperationError("conflict", "This task or board order changed in another page. Refresh before moving again.");
    const remaining = document.tasks.filter((task) => task.id !== existing.id);
    const position = request.position;
    let index: number;
    if ("edge" in position) {
      const indices = remaining.flatMap((task, i) => task.columnId === request.columnId ? [i] : []);
      index = indices.length === 0 ? remaining.length : position.edge === "start" ? indices[0] : indices[indices.length - 1] + 1;
    } else {
      const neighborId = "before" in position ? position.before : position.after;
      const neighborIndex = remaining.findIndex((task) => task.id === neighborId);
      if (neighborIndex < 0 || remaining[neighborIndex].columnId !== request.columnId) return invalid("The move neighbor must be another task in the target column. Refresh before moving again.");
      index = neighborIndex + ("after" in position ? 1 : 0);
    }
    remaining.splice(index, 0, existing);
    const oldColumnOrder = document.tasks.filter((task) => task.columnId === request.columnId).map((task) => task.id);
    const newColumnOrder = remaining.filter((task) => task.id === existing.id || task.columnId === request.columnId).map((task) => task.id);
    const unchanged = existing.columnId === request.columnId && JSON.stringify(oldColumnOrder) === JSON.stringify(newColumnOrder);
    existing.moveReceipt = { operationId: request.operationId, fingerprint };
    if (!unchanged) {
      if (existing.revision === Number.MAX_SAFE_INTEGER) throw new TaskOperationError("storage-unavailable", "Task revision limit reached; no changes were saved.");
      bumpOrder();
      existing.columnId = request.columnId;
      existing.revision++;
      existing.updatedAt = new Date(Math.max(Date.now(), Date.parse(existing.updatedAt) + 1)).toISOString();
      document.tasks = remaining;
    }
    // Even a logical no-op persists its exact receipt, without changing order/revision/time.
    return result(existing, true);
  });
}
