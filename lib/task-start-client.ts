import type { TaskStartPreview } from "./task-types";
// Preparation is per-page memory, like unsent chat drafts. Never persists user text to localStorage.
const previews = new Map<string, TaskStartPreview>();
const sessions = new Map<string, TaskStartPreview>();
export function rememberTaskPreview(preview: TaskStartPreview): string {
  previews.set(preview.selection.operationId, preview);
  for (const [sessionId, prior] of sessions) {
    if (prior.selection.operationId === preview.selection.operationId) sessions.set(sessionId, preview);
  }
  return preview.selection.operationId;
}
export function taskPreviewForTarget(token: string | null, sessionId: string | null, cwd: string | null): TaskStartPreview | null {
  const preview = token ? previews.get(token) : sessionId ? sessions.get(sessionId) : undefined;
  if (!preview) return null;
  return sessionId ? (preview.selection.sessionId === sessionId || preview.selection.mode === "new" && preview.selection.operationId === sessionId ? preview : null)
    : preview.selection.mode === "new" && preview.cwd === cwd ? preview : null;
}
export function rememberTaskSession(sessionId: string, preview: TaskStartPreview): void { sessions.set(sessionId, preview); }
