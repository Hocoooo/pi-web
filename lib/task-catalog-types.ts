import type { TaskDetails, TaskProject } from "./task-types";

export type { TaskProject } from "./task-types";

/** Read-only task metadata; no histories, receipts or execution state. */
export interface TaskCatalogEntry extends Pick<TaskDetails, "title" | "description" | "completionCriteria"> {
  id: string;
  project: TaskProject | null;
  archived: boolean;
  updatedAt: string;
  /** Explicit membership only. Descendant ownership is a display/search projection. */
  sessionIds: string[];
}

export interface TaskCatalog {
  tasks: TaskCatalogEntry[];
}
