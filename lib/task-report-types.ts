import type { TaskDetails, TaskProject, TaskSessionActivity } from "./task-types";
import type { TaskReportModelSelection } from "./task-report-settings-types";

export interface TaskReportItem { entryId: string; timestamp: string; kind: string; text: string }
export interface TaskReportSource {
  sessionId: string;
  capturedAt: string;
  status: "available" | "missing" | "unavailable";
  error?: string;
  leafId: string | null;
  cutoffEntryId: string | null;
  activity: TaskSessionActivity;
  items: TaskReportItem[];
}
export interface TaskReportSnapshot {
  task: TaskDetails & { id: string; project: TaskProject | null; columnId: string; revision: number; archiveRevision: number; createdAt: string; updatedAt: string };
  sources: TaskReportSource[];
}
export type TaskReportStatus = "awaiting-configuration" | "queued" | "generating" | "generated" | "failed" | "unconfirmed";
export interface TaskReportPart {
  sourceIndex: number; itemIndex: number;
  /** UTF-16 offsets in the frozen item's text, never splitting a surrogate pair. */
  start: number; end: number;
}
export interface TaskReportMaterial {
  id: string; parts: TaskReportPart[]; body: string | null; completedAt?: string;
  /** Detailed sources are level 0; synthesis materials reference the complete preceding group. */
  level?: number; inputMaterialIds?: string[]; sentAt?: string;
}
export interface TaskReportSummary {
  id: string; taskId: string; createdAt: string; status: TaskReportStatus;
  selection: TaskReportModelSelection | null;
  configurationIssue: string | null;
  sources: Omit<TaskReportSource, "items">[];
  hasBody: boolean;
  phase?: "preparing" | "sending" | "completed";
  stage?: { kind: "report" | "material" | "synthesis"; materialId?: string; level?: number };
  materials?: (Omit<TaskReportMaterial, "body"> & { hasBody: boolean })[];
  /** Initial attempt is 1; only explicit retries advance it. IDs confirm retries after lost responses. */
  attempt?: number;
  retryOperationIds?: string[];
  /** New-version identity and exact regeneration confirmation, retained across retry attempts. */
  regeneratedFromId?: string;
  regenerationOperationId?: string;
  startedAt?: string;
  sentAt?: string;
  completedAt?: string;
  error?: string;
}
export interface TaskReport extends Omit<TaskReportSummary, "materials"> {
  snapshot: TaskReportSnapshot; body: string | null; materials?: TaskReportMaterial[];
}
