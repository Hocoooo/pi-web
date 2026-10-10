import { compareTaskPriority, isTaskColumnId, isTaskLabel, isTaskPriority, type TaskBoard, type TaskFilter, type TaskRecord, type TaskSort } from "./task-types";

export const emptyTaskFilter = (): TaskFilter => ({ text: "", project: null, columnIds: [], priorities: [], labels: [], activity: "all" });
export function isTaskSort(value: unknown): value is TaskSort { return value === "manual" || value === "priority" || value === "updated"; }
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
export function validTaskFilter(value: unknown): value is TaskFilter {
  if (!object(value) || Object.keys(value).length !== 6 || Object.keys(value).some((key) => !["text", "project", "columnIds", "priorities", "labels", "activity"].includes(key))) return false;
  const array = (v: unknown, max: number, valid: (entry: unknown) => boolean) => Array.isArray(v) && v.length <= max && Array.from(v).every(valid) && new Set(v).size === v.length;
  return typeof value.text === "string" && value.text.length <= 200
    && (value.project === null || object(value.project) && Object.keys(value.project).length === 1 && "key" in value.project
      && (value.project.key === null || typeof value.project.key === "string" && !!value.project.key && value.project.key.length <= 4096))
    && array(value.columnIds, 100, isTaskColumnId) && array(value.priorities, 4, isTaskPriority)
    && array(value.labels, 20, (label) => isTaskLabel(label) && label === (label as string).trim())
    && ["all", "working", "idle"].includes(value.activity as string);
}
export type TaskActivityState = "working" | "idle" | "unknown";
export function taskActivity(task: TaskRecord, runningIds: ReadonlySet<string> | null, stale: boolean): TaskActivityState {
  // No linked sessions can work. Never assert idle for linked sessions from a failed/stale snapshot.
  if (!task.sessionIds.length) return "idle";
  if (runningIds === null || stale) return "unknown";
  return task.sessionIds.some((id) => runningIds.has(id)) ? "working" : "idle";
}
/** Fail closed on removed/unknown column IDs. 14 can consume this without dropping the condition. */
export function projectTaskView(board: TaskBoard, filter: TaskFilter, sort: TaskSort, runningIds: ReadonlySet<string> | null, stale = false): { tasks: TaskRecord[]; invalid: boolean } {
  if (!validTaskFilter(filter) || !isTaskSort(sort) || filter.columnIds.some((id) => !board.columns.some((column) => column.id === id))) return { tasks: [], invalid: true };
  const text = filter.text.trim().toLowerCase();
  const tasks = board.tasks.filter((task) => (!text || [task.title, task.description, task.completionCriteria].some((field) => field.toLowerCase().includes(text)))
    && (filter.project === null || (task.project?.projectKey ?? null) === filter.project.key)
    && (!filter.columnIds.length || filter.columnIds.includes(task.columnId))
    && (!filter.priorities.length || filter.priorities.includes(task.priority))
    && filter.labels.every((label) => task.labels.includes(label))
    && (filter.activity === "all" || taskActivity(task, runningIds, stale) === filter.activity));
  if (sort === "priority") tasks.sort(compareTaskPriority);
  if (sort === "updated") tasks.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
    || Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { tasks, invalid: false };
}
