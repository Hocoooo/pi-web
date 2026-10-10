import { createHash } from "node:crypto";
import { isTaskSort, validTaskFilter } from "./task-view";
import { TASK_ID_PATTERN, TaskOperationError, type TaskBoard, type TaskRequest, type TaskSavedView } from "./task-types";

export interface StoredTaskView extends TaskSavedView { receipt: { operationId: string; fingerprint: string } }
export function publicTaskView({ receipt, ...view }: StoredTaskView): TaskSavedView { void receipt; return view; }
export function validSavedViews(value: unknown): value is StoredTaskView[] {
  if (!Array.isArray(value) || value.length > 100) return false;
  if (!Array.from(value).every((view) => view && typeof view === "object" && !Array.isArray(view)
    && Object.keys(view).every((key) => ["id", "name", "filter", "sort", "receipt"].includes(key))
    && typeof view.id === "string" && TASK_ID_PATTERN.test(view.id) && validName(view.name)
    && view.name === view.name.trim() && validTaskFilter(view.filter) && isTaskSort(view.sort)
    && view.receipt && Object.keys(view.receipt).length === 2 && typeof view.receipt.operationId === "string"
    && TASK_ID_PATTERN.test(view.receipt.operationId) && typeof view.receipt.fingerprint === "string" && /^[0-9a-f]{64}$/.test(view.receipt.fingerprint))) return false;
  return new Set(value.map((view) => view.id)).size === value.length && new Set(value.map((view) => view.name)).size === value.length
    && new Set(value.map((view) => view.receipt.operationId)).size === value.length;
}
function validName(value: unknown): value is string { return typeof value === "string" && !!value.trim() && value.length <= 100 && !/[\r\n]/.test(value); }
export function parseSaveView(value: Record<string, unknown>): Extract<TaskRequest, { action: "save-view" }> {
  if (Object.keys(value).some((key) => !["action", "id", "operationId", "expectedViewsRevision", "name", "filter", "sort"].includes(key))
    || typeof value.id !== "string" || !TASK_ID_PATTERN.test(value.id)
    || typeof value.operationId !== "string" || !TASK_ID_PATTERN.test(value.operationId)
    || !Number.isSafeInteger(value.expectedViewsRevision) || (value.expectedViewsRevision as number) < 0
    || !validName(value.name) || !validTaskFilter(value.filter) || !isTaskSort(value.sort)) throw new TaskOperationError("invalid-input", "Use a valid view name, supported conditions and a saved views revision.");
  return { action: "save-view", id: value.id, operationId: value.operationId, expectedViewsRevision: value.expectedViewsRevision as number,
    name: value.name.trim(), filter: value.filter, sort: value.sort };
}
export function saveTaskView(document: { savedViews: StoredTaskView[]; viewsRevision: number; columns: TaskBoard["columns"] | { id: string }[] }, request: Extract<TaskRequest, { action: "save-view" }>): boolean {
  const f = request.filter;
  const fingerprint = createHash("sha256").update(JSON.stringify([request.id, request.expectedViewsRevision, request.name,
    [f.text, f.project?.key, f.project === null, f.columnIds, f.priorities, f.labels, f.activity], request.sort])).digest("hex");
  const receipt = document.savedViews.find((view) => view.receipt.operationId === request.operationId);
  if (receipt) {
    if (receipt.id !== request.id || receipt.receipt.fingerprint !== fingerprint) throw new TaskOperationError("conflict", "This view operation ID belongs to different conditions.");
    return false;
  }
  if (document.viewsRevision !== request.expectedViewsRevision) throw new TaskOperationError("conflict", "Saved views changed in another page. Refresh and explicitly start a new save; your conditions were not saved.");
  if (f.columnIds.some((id) => !document.columns.some((column) => column.id === id))) throw new TaskOperationError("invalid-input", "A selected status column no longer exists. Keep or clear the condition explicitly; no view was saved.");
  if (document.savedViews.some((view) => view.id === request.id || view.name === request.name)) throw new TaskOperationError("conflict", "A view with this ID or name already exists. Choose a different name; nothing was overwritten.");
  if (document.savedViews.length >= 100 || document.viewsRevision === Number.MAX_SAFE_INTEGER) throw new TaskOperationError("storage-unavailable", "Saved views limit reached; no view was saved.");
  document.savedViews.push({ id: request.id, name: request.name, filter: request.filter, sort: request.sort, receipt: { operationId: request.operationId, fingerprint } });
  document.viewsRevision++;
  return true;
}
