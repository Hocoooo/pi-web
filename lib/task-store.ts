import { mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { normalizeCwd } from "./validated-cwd";
import lockfile from "proper-lockfile";
import { serializeByKey } from "./key-serializer";
import { readRegularFileText } from "./regular-file";
import { DEFAULT_TASK_PRIORITY, isTaskSessionId, isTaskColumn, isTaskColumnId, isTaskColumnLabel, isTaskLabel, isTaskPriority, TASK_COLUMNS, TASK_COLUMN_LIMITS, TASK_ID_PATTERN, TASK_LABEL_LIMITS, TASK_TEXT_LIMITS, TaskOperationError, type TaskBoard, type TaskColumnConfig, type TaskRecord, isCompletionColumn } from "./task-types";

import { validSessionRelations, type SessionRelationRevision } from "./task-relations";
import { validSessionContexts } from "./task-start";
import { validSessionUpdates } from "./task-context-updates";
import { publicSharedContext, validSharedContext, type StoredSharedContext } from "./task-context";
import { publicTaskView, validSavedViews, type StoredTaskView } from "./task-saved-views";
import { validArchiveReceipt, type StoredArchiveReceipt } from "./task-archive";
import { validSessionCopies, type SessionCopyReceipt } from "./task-session-copy";

export interface StoredTaskRecord extends TaskRecord {
  sharedContext: StoredSharedContext;
  creationFingerprint: string;
  moveReceipt?: { operationId: string; fingerprint: string };
  archiveReceipt?: StoredArchiveReceipt;
  projectReceipt?: { operationId: string; fingerprint: string };
}
export interface TaskDocument { version: 7; sessionRelations: SessionRelationRevision[]; columnRemovalReceipt?: { operationId: string; fingerprint: string }; sessionCopies: SessionCopyReceipt[]; viewsRevision: number; savedViews: StoredTaskView[]; orderRevision: number; columnsRevision: number; columns: TaskColumnConfig[]; tasks: StoredTaskRecord[] }
function defaultColumns(): TaskColumnConfig[] { return TASK_COLUMNS.map(({ id, label }) => ({ id, label })); }
function validColumns(value: unknown): value is TaskColumnConfig[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > TASK_COLUMN_LIMITS.count) return false;
  if (!value.every((column) => record(column) && Object.keys(column).every((key) => key === "id" || key === "label")
    && isTaskColumnId(column.id) && (isTaskColumnLabel(column.label)
      ? column.label === column.label.trim() : column.label === null && TASK_COLUMNS.some((initial) => initial.id === column.id)))) return false;
  return new Set(value.map((column) => column.id)).size === value.length
    && value.some((column) => column.id === "done") && value.some((column) => column.id !== "done");
}

/** Immutable creation identity, independent of later task fields or project resolution. */
export function taskCreationFingerprint(input: Pick<TaskRecord, "title" | "description" | "completionCriteria"> & { cwd: string | null; sourceSessionId?: string }): string {
  const identity = [input.title.trim(), input.description, input.completionCriteria,
    input.cwd === null ? null : normalizeCwd(input.cwd)];
  // Source creates bind the immutable request identity, not today's source cwd.
  if (input.sourceSessionId !== undefined) identity.push(`source:${input.sourceSessionId}`);
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

/** Fixed-size confirmation of the full ordered source, including hidden/archived tasks.
 * Server-only streamed tuples bind identity and all field/relationship mutations through revision. */
export function taskColumnRemovalDigest(tasks: readonly Pick<TaskRecord, "id" | "columnId" | "revision" | "archiveRevision">[], columnId: string): string {
  const hash = createHash("sha256").update("pi-web:column-removal:v1\n").update(JSON.stringify(columnId)).update("\n");
  for (const task of tasks) if (task.columnId === columnId) hash.update(JSON.stringify([task.id, task.revision, task.archiveRevision])).update("\n");
  return hash.digest("hex");
}

/** Internal retry metadata is not part of the public board/task record. */
export function publicTask(task: StoredTaskRecord): TaskRecord {
  const { creationFingerprint, moveReceipt, archiveReceipt, projectReceipt, ...record } = task;
  void creationFingerprint; void moveReceipt; void archiveReceipt; void projectReceipt;
  const cascade = archiveReceipt?.cascade;
  return { ...record, sharedContext: publicSharedContext(task.sharedContext),
    ...(cascade?.status === "pending" ? { pendingSessionArchive: {
      operationId: archiveReceipt!.operationId, expectedArchiveRevision: cascade.expectedArchiveRevision,
      previewToken: cascade.previewToken, confirmCrossTask: cascade.confirmCrossTask,
    } } : {}) };
}
export function publicTaskBoard(document: TaskDocument): TaskBoard {
  return { columnRemovalDigests: Object.fromEntries(document.columns.map(column => [column.id, taskColumnRemovalDigest(document.tasks, column.id)])),
    viewsRevision: document.viewsRevision, savedViews: document.savedViews.map(publicTaskView), orderRevision: document.orderRevision, columnsRevision: document.columnsRevision,
    columns: document.columns.map(column => ({ ...column, isCompletion: isCompletionColumn(column.id) })), tasks: document.tasks.map(publicTask) };
}
const MAX_BYTES = 32 * 1024 * 1024;
const STORE_KEY = Symbol.for("pi-web.task-store");
function invalidStore(): never {
  throw new TaskOperationError("storage-unavailable", "Task storage is invalid. Restore or repair it before retrying; no records were overwritten.");
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validTask(value: unknown, columns: readonly TaskColumnConfig[]): value is TaskRecord {
  if (!record(value) || typeof value.id !== "string" || !TASK_ID_PATTERN.test(value.id) || !isTaskColumn(value.columnId, columns)) return false;
  if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) return false;
  const legacyArchive = !Object.hasOwn(value, "archived") && !Object.hasOwn(value, "archiveRevision") && !Object.hasOwn(value, "archiveReceipt");
  if (!legacyArchive && (typeof value.archived !== "boolean" || !Number.isSafeInteger(value.archiveRevision) || (value.archiveRevision as number) < 0)) return false;
  if (Object.hasOwn(value, "pendingSessionArchive")) return false; // Response-only retry intent, never persisted.
  if (value.archiveReceipt !== undefined && (!validArchiveReceipt(value.archiveReceipt)
    || value.archiveReceipt.cascade && (value.archived !== true
      || value.archiveRevision !== value.archiveReceipt.cascade.expectedArchiveRevision && value.archiveRevision !== value.archiveReceipt.cascade.expectedArchiveRevision + 1))) return false;
  if (value.projectReceipt !== undefined && (!record(value.projectReceipt) || Object.keys(value.projectReceipt).length !== 2
    || typeof value.projectReceipt.operationId !== "string" || !TASK_ID_PATTERN.test(value.projectReceipt.operationId)
    || typeof value.projectReceipt.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(value.projectReceipt.fingerprint))) return false;
  for (const key of ["title", "description", "completionCriteria"] as const) {
    if (typeof value[key] !== "string" || value[key].length > TASK_TEXT_LIMITS[key]) return false;
  }
  if (!(value.title as string).trim()) return false;
  // Missing fields are ticket 01 v1 records; present but invalid fields are corruption.
  if (value.sessionIds !== undefined && (!Array.isArray(value.sessionIds)
    || value.sessionIds.some((id) => !isTaskSessionId(id)) || new Set(value.sessionIds).size !== value.sessionIds.length)) return false;
  if (value.priority !== undefined && !isTaskPriority(value.priority)) return false;
  if (value.labels !== undefined && (!Array.isArray(value.labels) || value.labels.length > TASK_LABEL_LIMITS.count
    || value.labels.some((label) => !isTaskLabel(label)))) return false;
  if (value.creationFingerprint !== undefined && (typeof value.creationFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(value.creationFingerprint))) return false;
  if (value.sharedContext !== undefined && !validSharedContext(value.sharedContext)) return false;
  if (value.sessionContexts !== undefined && !validSessionContexts(value.sessionContexts, value)) return false;
  if (value.sessionUpdates !== undefined && !validSessionUpdates(value.sessionUpdates, value)) return false;
  if (value.moveReceipt !== undefined && (!record(value.moveReceipt)
    || typeof value.moveReceipt.operationId !== "string" || !TASK_ID_PATTERN.test(value.moveReceipt.operationId)
    || typeof value.moveReceipt.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(value.moveReceipt.fingerprint))) return false;
  if (![value.createdAt, value.updatedAt].every((date) => typeof date === "string" && Number.isFinite(Date.parse(date)))) return false;
  if (value.project === null) return true;
  const project = value.project;
  return record(project) && ["cwd", "projectRoot", "projectKey"].every((key) => typeof project[key] === "string" && project[key].length > 0);
}
/** Version dispatch is the migration boundary. Unknown versions are never guessed or overwritten. */
function decodeDocument(text: string): { document: TaskDocument; migrated: boolean } {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return invalidStore(); }
  if (!record(value) || !Number.isSafeInteger(value.version)) return invalidStore();
  if (value.version !== 1 && value.version !== 2 && value.version !== 3 && value.version !== 4 && value.version !== 5 && value.version !== 6 && value.version !== 7) throw new TaskOperationError("unsupported-version", "Task storage uses an unsupported version. Use a compatible Pi Web version; no records were overwritten.");
  if (value.version >= 3 && (!validColumns(value.columns) || !Number.isSafeInteger(value.columnsRevision) || (value.columnsRevision as number) < 0)) return invalidStore();
  const columns = value.version >= 3 ? value.columns as TaskColumnConfig[] : defaultColumns();
  if (!Array.isArray(value.tasks) || !value.tasks.every((task) => validTask(task, columns))) return invalidStore();
  if (value.version !== 1 && (!Number.isSafeInteger(value.orderRevision) || (value.orderRevision as number) < 0
    || value.tasks.some((task) => (task as StoredTaskRecord).creationFingerprint === undefined || task.priority === undefined || task.labels === undefined))) return invalidStore();
  if (value.version >= 4 && value.tasks.some((task) => task.sessionIds === undefined || task.sharedContext === undefined)) return invalidStore();
  if (value.version >= 5 && value.tasks.some(task => task.sessionContexts === undefined)) return invalidStore();
  // v6 is the composed schema, not a numeral alias for either isolated tree.
  // Only pre-v6 archive/update absences are migration; v6 missing domains are corruption.
  if (value.version >= 6 && value.tasks.some(task => task.sessionUpdates === undefined
    || !Object.hasOwn(task, "archived") || !Object.hasOwn(task, "archiveRevision"))) return invalidStore();
  const contextOperations = value.tasks.flatMap(task => [...(task.sessionContexts ?? []).map((c: { operationId: string }) => c.operationId),
    ...(task.sessionUpdates ?? []).flatMap((s: { choices: { operationId: string }[] }) => s.choices.map(c => c.operationId))]);
  if (new Set(contextOperations).size !== contextOperations.length) return invalidStore();
  if (new Set(value.tasks.map((task) => task.id)).size !== value.tasks.length) return invalidStore();
  const linkedIds = value.tasks.flatMap((task) => task.sessionIds ?? []);
  if (new Set(linkedIds).size !== linkedIds.length) return invalidStore();
  // Ticket 01's earlier v1 records had no retry metadata and no editable text.
  // Hydrate their original content once; subsequent writes persist the identity.
  // Ticket 06 adds knowledge to v2 through this same locked migration entry.
  // Only absence is legacy; null/partial/invalid history is never reset.
  // Additive v4 extension: only both absent fields are legacy. Partial/invalid views fail closed.
  const legacyViews = !Object.hasOwn(value, "savedViews") && !Object.hasOwn(value, "viewsRevision");
  if (!legacyViews && (!validSavedViews(value.savedViews) || !Number.isSafeInteger(value.viewsRevision) || (value.viewsRevision as number) < 0)) return invalidStore();
  const legacyCopies = !Object.hasOwn(value, "sessionCopies");
  if (!legacyCopies && !validSessionCopies(value.sessionCopies)) return invalidStore();
  if (Object.hasOwn(value, "columnRemovalReceipt") && (!record(value.columnRemovalReceipt)
    || Object.keys(value.columnRemovalReceipt).length !== 2
    || typeof value.columnRemovalReceipt.operationId !== "string" || !TASK_ID_PATTERN.test(value.columnRemovalReceipt.operationId)
    || typeof value.columnRemovalReceipt.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(value.columnRemovalReceipt.fingerprint))) return invalidStore();
  if (value.version >= 6 && (legacyViews || legacyCopies)) return invalidStore();
  if (value.version === 7 && (!validSessionRelations(value.sessionRelations)
    || value.tasks.some(task => task.sessionContexts.some((c: { relationGeneration?: number; selection: { expectedRelationGeneration?: number } }) => c.relationGeneration === undefined || c.selection.expectedRelationGeneration === undefined)
      || task.sessionUpdates.some((s: { choices: { relationGeneration?: number }[] }) => s.choices.some(c => c.relationGeneration === undefined)))
    || (value.sessionCopies as SessionCopyReceipt[]).some(r => r.sourceRelationGeneration === undefined))) return invalidStore();
  if (value.version !== 7 && (Object.hasOwn(value, "sessionRelations")
    || value.tasks.some(task => (task.sessionContexts ?? []).some((c: { sessionId: string }) => !task.sessionIds?.includes(c.sessionId))))) return invalidStore();
  const migrated = value.version !== 7;
  for (const task of value.tasks as StoredTaskRecord[]) {
    task.sharedContext ??= { currentVersionId: null, versions: [] };
    task.creationFingerprint ??= taskCreationFingerprint({ ...task, cwd: task.project?.cwd ?? null });
    task.priority ??= DEFAULT_TASK_PRIORITY;
    task.labels ??= [];
    task.sessionIds ??= [];
    task.sessionContexts ??= [];
    task.sessionUpdates ??= [];
    if (migrated) {
      for (const context of task.sessionContexts) { context.relationGeneration ??= 0; context.selection.expectedRelationGeneration ??= 0; }
      for (const state of task.sessionUpdates) for (const choice of state.choices) choice.relationGeneration ??= 0;
    }
    if (!Object.hasOwn(task, "archived")) { task.archived = false; task.archiveRevision = 0; }
  }
  // v3 means the published main columns/context schema, never the isolated 04-only v3.
  // v1/v2/main-v3/v4/v5/v6 -> v7 retains every independent domain, including14's optional removal receipt.
  // Only legacy absences hydrate; columnRemovalDigests is never persisted.
  // Column defaults apply only to v1/v2; invalid main-v3/v4 columns are never guessed.
  const copies = legacyCopies ? [] : value.sessionCopies as SessionCopyReceipt[];
  if (migrated) for (const receipt of copies) receipt.sourceRelationGeneration ??= 0;
  const document: TaskDocument = { version: 7, sessionRelations: value.version === 7 ? value.sessionRelations as SessionRelationRevision[] : [], ...(Object.hasOwn(value, "columnRemovalReceipt") ? { columnRemovalReceipt: value.columnRemovalReceipt as TaskDocument["columnRemovalReceipt"] } : {}), sessionCopies: copies, viewsRevision: legacyViews ? 0 : value.viewsRevision as number,
    savedViews: legacyViews ? [] : value.savedViews as StoredTaskView[], orderRevision: value.version === 1 ? 0 : value.orderRevision as number,
    columnsRevision: value.version >= 3 ? value.columnsRevision as number : 0, columns,
    tasks: value.tasks as StoredTaskRecord[] };
  // Validate the complete hydrated target before exposing it or committing a migration.
  // Older epochs remain history; future epochs cannot be justified by this authority.
  const epochs = new Map(document.sessionRelations.map(r => [r.sessionId, r.generation]));
  for (const task of document.tasks) {
    if (task.sessionContexts.some(c => (c.relationGeneration ?? 0) > (epochs.get(c.sessionId) ?? 0)
      || !task.sessionIds.includes(c.sessionId) && (c.relationGeneration ?? 0) >= (epochs.get(c.sessionId) ?? 0))) return invalidStore();
    if (task.sessionUpdates.some(s => s.choices.some(c => (c.relationGeneration ?? 0) > (epochs.get(s.sessionId) ?? 0)
      || c.operationId === s.pendingOperationId && (c.relationGeneration ?? 0) !== (epochs.get(s.sessionId) ?? 0)))) return invalidStore();
  }
  if (document.sessionCopies.some(r => (r.sourceRelationGeneration ?? 0) > (epochs.get(r.sourceSessionId) ?? 0))) return invalidStore();
  return { document, migrated };
}
async function atomicWrite(file: string, document: TaskDocument, assertLock: () => void): Promise<void> {
  const text = `${JSON.stringify(document)}\n`;
  if (Buffer.byteLength(text) > MAX_BYTES) throw new TaskOperationError("storage-unavailable", "Task storage has reached its size limit; no changes were saved.");
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    try { await handle.writeFile(text, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    assertLock();
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  }
}

/** Serializes readers and writers across route bundles AND processes, then atomically commits. */
export async function withTaskStore<T>(agentDir: string, operation: (document: TaskDocument, assertLock: () => void) => { value: T; changed: boolean } | Promise<{ value: T; changed: boolean }>): Promise<T> {
  try {
    const directory = join(agentDir, "tasks");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = join(await realpath(directory), "board.json");
    return await serializeByKey(STORE_KEY, file, async () => {
      let compromised = false;
      const assertLock = () => {
        if (compromised) throw new TaskOperationError("storage-unavailable", "Task storage lost its lock. Reload before retrying; the operation was not confirmed.");
      };
      const release = await lockfile.lock(file, {
        realpath: false,
        stale: 30_000,
        retries: { retries: 10, factor: 2, minTimeout: 25, maxTimeout: 500 },
        // The default throws from a timer and kills the server. Surface lost ownership to the operation instead.
        onCompromised: () => { compromised = true; },
      });
      try {
        const text = readRegularFileText(file, MAX_BYTES);
        const missing = text === undefined;
        const decoded = missing ? { document: { version: 7 as const, sessionRelations: [], sessionCopies: [], viewsRevision: 0, savedViews: [], orderRevision: 0, columnsRevision: 0, columns: defaultColumns(), tasks: [] }, migrated: false } : decodeDocument(text);
        const result = await operation(decoded.document, assertLock);
        assertLock();
        if (missing || decoded.migrated || result.changed) await atomicWrite(file, decoded.document, assertLock);
        assertLock();
        return result.value;
      } finally { await release(); }
    });
  } catch (error) {
    if (error instanceof TaskOperationError) throw error;
    throw new TaskOperationError("storage-unavailable", "Task storage is unavailable. Check access and retry; the operation was not confirmed.");
  }
}
