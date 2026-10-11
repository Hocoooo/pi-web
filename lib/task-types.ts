/** Task records are independent of sessions. Only an explicit user move completes one. */
export const TASK_COLUMNS = [
  { id: "todo", label: null, isCompletion: false },
  { id: "in-progress", label: null, isCompletion: false },
  { id: "review", label: null, isCompletion: false },
  { id: "blocked", label: null, isCompletion: false },
  { id: "done", label: null, isCompletion: true },
] as const;
export type TaskColumnId = string;
/** null means the localized built-in name; custom names are always literal text. */
export interface TaskColumnConfig { id: TaskColumnId; label: string | null }
export interface TaskColumn extends TaskColumnConfig { isCompletion: boolean }
export const TASK_COLUMN_LIMITS = { count: 100, label: 100 } as const;
export function isCompletionColumn(id: TaskColumnId): boolean { return id === "done"; }
export function isTaskColumnId(value: unknown): value is TaskColumnId {
  return typeof value === "string" && (TASK_COLUMNS.some((column) => column.id === value) || TASK_ID_PATTERN.test(value));
}
export function isTaskColumnLabel(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= TASK_COLUMN_LIMITS.label && !/[\r\n]/.test(value);
}
export interface TaskProject {
  cwd: string;
  projectRoot: string;
  projectKey: string;
}
/** Persisted ordinal values, not translated labels or colors. Higher means more urgent. */
export const TASK_PRIORITIES = [0, 1, 2, 3] as const;
export type TaskPriority = typeof TASK_PRIORITIES[number];
export const DEFAULT_TASK_PRIORITY: TaskPriority = 1;
export const TASK_LABEL_LIMITS = { count: 20, length: 50 } as const;
export function isTaskLabel(value: unknown): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= TASK_LABEL_LIMITS.length && !/[\r\n]/.test(value);
}
export function isTaskPriority(value: unknown): value is TaskPriority {
  return TASK_PRIORITIES.some((priority) => priority === value);
}
export interface TaskDetails {
  title: string;
  description: string;
  completionCriteria: string;
  priority: TaskPriority;
  labels: string[];
}
export const TASK_CONTEXT_FIELDS = ["goal", "decisions", "progress", "nextSteps"] as const;
export const TASK_CONTEXT_TEXT_LIMIT = 20_000;
export type TaskContextContent = Record<typeof TASK_CONTEXT_FIELDS[number], string>;
export type TaskContextSource = { kind: "manual" } | { kind: "restore"; versionId: string } | import("./task-summary-types").SummaryProvenance;
export interface TaskContextVersion {
  id: string;
  confirmedAt: string;
  source: TaskContextSource;
  content: TaskContextContent;
}
export interface TaskSharedContext {
  currentVersionId: string | null;
  versions: TaskContextVersion[];
}
export type TaskContextRequest =
  | { action: "publish-context"; id: string; expectedCurrentVersionId: string | null; operationId: string; content: TaskContextContent; generationId?: string }
  | { action: "restore-context"; id: string; expectedCurrentVersionId: string | null; operationId: string; versionId: string };
export interface TaskStartSelection {
  taskId: string;
  operationId: string;
  mode: "new" | "continue";
  sessionId: string | null;
  expectedRevision: number;
  expectedCurrentVersionId: string | null;
  confirmSameCwd: boolean;
  /** Absent legacy clients mean epoch 0, never today's epoch. */
  expectedRelationGeneration?: number;
}
export interface TaskStartSnapshot {
  taskId: string;
  title: string;
  description: string;
  completionCriteria: string;
  version: TaskContextVersion | null;
}
/** Immutable new-start selection receipt, not proof of append or provider reading. */
export interface TaskSessionContext {
  sessionId: string;
  operationId: string;
  snapshot: TaskStartSnapshot;
  selection: TaskStartSelection;
  relationGeneration?: number;
}
export interface TaskStartPreview {
  selection: TaskStartSelection;
  snapshot: TaskStartSnapshot;
  cwd: string;
  sameCwdBusy: string[];
  /** Native historical material inherited by a copy; never a child admission receipt. */
  inheritedFromSessionId?: string;
}
export type TaskStartRequest =
  | { action: "prepare-start"; id: string; operationId: string; sessionId: string | null }
  | { action: "admit-start"; id: string; selection: TaskStartSelection; realSessionId: string };
export interface TaskUpdateChoice { relationGeneration?: number; operationId: string; versionId: string; expectedRevision: number; selectedAt: string; boundary: { epoch: string; sequence: number } }
/** Successful SDK input/response observation, not provider wire or proof of model comprehension. */
export interface TaskUpdateDelivery { operationId: string; entryId: string; inputHash: string; provider: string; model: string; sentAt: string; evidence: "sdk-input-successful-response" }
export interface TaskSessionUpdate { sessionId: string; revision: number; pendingOperationId: string | null; choices: TaskUpdateChoice[]; deliveries: TaskUpdateDelivery[] }
export interface TaskContextUpdateState {
  task: TaskRecord | null;
  relationGeneration: number;
  state: TaskSessionUpdate;
  current: { operationId: string; versionId: string | null; originSessionId: string; projected: boolean; successfulSend: boolean } | null;
}
export type TaskContextUpdateRequest =
  | { action: "context-update-state"; sessionId: string }
  | { action: "accept-context-update"; id: string; sessionId: string; operationId: string; expectedRevision: number; versionId: string; expectedRelationGeneration?: number }
  | { action: "clear-context-update"; id: string; sessionId: string; expectedRevision: number; expectedRelationGeneration?: number }
  | { action: "pending-context-update"; sessionId: string }
  | { action: "complete-context-update"; id: string; sessionId: string; delivery: TaskUpdateDelivery; relationGeneration?: number };
export interface TaskRecord extends TaskDetails {
  archived: boolean;
  archiveRevision: number;
  sharedContext: TaskSharedContext;
  id: string;
  project: TaskProject | null;
  columnId: TaskColumnId;
  revision: number;
  createdAt: string;
  updatedAt: string;
  sessionIds: string[];
  sessionContexts: TaskSessionContext[];
  sessionUpdates: TaskSessionUpdate[];
}
export type TaskMovePosition = { edge: "start" | "end" } | { before: string } | { after: string };
export type TaskSort = "manual" | "priority" | "updated";
/** null project means all; {key:null} explicitly selects tasks without a project. */
export interface TaskFilter {
  text: string;
  project: { key: string | null } | null;
  columnIds: string[];
  priorities: TaskPriority[];
  labels: string[];
  activity: "all" | "working" | "idle";
}
export interface TaskSavedView { id: string; name: string; filter: TaskFilter; sort: TaskSort }
export interface TaskBoard {
  /** Server-derived full ordered source digests; response-only, not column configuration. */
  columnRemovalDigests: Record<TaskColumnId, string>;
  viewsRevision: number;
  savedViews: TaskSavedView[];
  orderRevision: number;
  columnsRevision: number;
  columns: readonly TaskColumn[];
  tasks: TaskRecord[];
}
/** Fixed full source snapshot, including tasks outside the current view. */
export interface TaskColumnRemovalRequest {
  action: "remove-column";
  columnId: TaskColumnId;
  targetColumnId: TaskColumnId;
  expectedColumnsRevision: number;
  expectedOrderRevision: number;
  expectedSourceDigest: string;
  confirmCompletion: boolean;
  operationId: string;
}
export interface TaskRelationRequest {
  action: "change-session-relation";
  sessionId: string;
  sourceTaskId: string;
  targetTaskId: string | null;
  expectedGeneration: number;
  expectedUpdateRevision: number;
  operationId: string;
}
export type TaskRequest =
  | TaskRelationRequest
  | TaskColumnRemovalRequest
  | { action: "list" }
  | { action: "projects" }
  | { action: "preview-project"; id: string; cwd: string | null }
  | { action: "change-project"; id: string; cwd: string | null; expectedRevision: number; previewToken: string; operationId: string }
  | { action: "set-archive"; id: string; archived: boolean; expectedArchiveRevision: number; operationId: string }
  | { action: "admit-session-work"; sessionId: string; taskId?: string }
  | { action: "prepare-session-copy"; operationId: string; sourceSessionId: string; fingerprint: string }
  | { action: "complete-session-copy"; operationId: string; sourceSessionId: string; fingerprint: string; newSessionId: string | null }
  | { action: "save-view"; id: string; operationId: string; expectedViewsRevision: number; name: string; filter: TaskFilter; sort: TaskSort }
  | { action: "task-picker"; cwd: string | null; sessionId?: never }
  | { action: "task-picker"; sessionId: string; cwd?: never }
  | { action: "session-task"; sessionId: string }
  | { action: "sessions"; id: string }
  | { action: "link"; id: string; expectedRevision: number; sessionIds: string[] }
  | { action: "createFromSession"; id: string; title: string; description: string; completionCriteria: string; sourceSessionId: string }
  | { action: "set-columns"; expectedColumnsRevision: number; columns: TaskColumnConfig[] }
  | { action: "create"; id: string; title: string; description: string; completionCriteria: string; cwd: string | null }
  | { action: "move"; id: string; columnId: TaskColumnId; expectedRevision: number; expectedOrderRevision: number; operationId: string; position: TaskMovePosition }
  | ({ action: "edit"; id: string; expectedRevision: number } & TaskDetails)
  | TaskContextRequest
  | TaskStartRequest
  | TaskContextUpdateRequest;
export interface TaskProjectsResult { projects: TaskProject[] }
export interface TaskProjectPreview { project: TaskProject | null; revision: number; token: string; detachSessionIds: string[] }
export interface TaskMutationResult { task: TaskRecord; board: TaskBoard }
export interface TaskCopyResult { cancelled: boolean; newSessionId?: string }
export type TaskSessionActivity = Pick<TaskSessionInfo, "running" | "waitingForInput" | "compacting" | "bashRunning" | "queued">;
export interface TaskSessionInfo {
  id: string;
  relationGeneration?: number;
  updateRevision?: number;
  name?: string;
  cwd?: string;
  missing?: boolean;
  running: boolean;
  waitingForInput?: boolean;
  compacting?: boolean;
  bashRunning?: boolean;
  queued?: boolean;
}
export interface TaskSessionsResult { linked: TaskSessionInfo[]; candidates: TaskSessionInfo[] }
/** Lightweight ownership metadata; deliberately excludes legacy context and native history. */
export interface TaskSessionTaskResult { task: { id: string; title: string; archived: boolean } | null }
/** Picker metadata only; status is the saved column label, or its built-in ID. */
export interface TaskPickerResult {
  tasks: { id: string; title: string; archived: boolean; revision: number; status: string; statusKey?: string }[];
  relation: { sessionId: string; sourceTaskId: string | null; generation: number; updateRevision: number } | null;
}
export const TASK_SESSION_BATCH_LIMIT = 100;
// Reuse native session ID syntax (SDK permits explicit non-UUID IDs), never a path.
export function isTaskSessionId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 200 && /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value);
}
export type TaskErrorCode = "invalid-input" | "not-found" | "conflict" | "storage-unavailable" | "unsupported-version";
export class TaskOperationError extends Error {
  constructor(public readonly code: TaskErrorCode, message: string) { super(message); }
}
export const TASK_TEXT_LIMITS = { title: 200, description: 20_000, completionCriteria: 20_000 } as const;
export const TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Reusable priority order. Equal priorities: older creation first, then UUID code-point order.
 * This does not change the board's saved manual order. */
export function compareTaskPriority(a: TaskRecord, b: TaskRecord): number {
  return b.priority - a.priority || Date.parse(a.createdAt) - Date.parse(b.createdAt)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
export function isTaskColumn(value: unknown, columns: readonly TaskColumnConfig[]): value is TaskColumnId {
  return columns.some((column) => column.id === value);
}
