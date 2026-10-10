import type { TaskContextContent, TaskSessionInfo } from "./task-types";

export interface SummaryModel { provider: string; modelId: string }
export interface SummaryItem { entryId: string; role: "user" | "assistant" | "toolResult"; text: string }
export interface SummarySnapshot {
  snapshotId: string; sessionId: string; leafId: string;
  branches: string[]; items: SummaryItem[];
}
export interface SummaryOptions {
  sessions: TaskSessionInfo[]; models: SummaryModel[]; defaultModel: SummaryModel | null;
}
export interface SummarySelection { snapshotId: string; items: Array<{ entryId: string; text: string }> }
export interface SummaryResult { generationId: string; content: TaskContextContent; source: SummaryProvenance }
export interface SummaryProvenance {
  kind: "ai"; generationId: string; generatedAt: string;
  model: SummaryModel; responseModel: string; inputHash: string;
  sources: Array<{ sessionId: string; leafId: string; entryIds: string[]; toolEntryIds: string[] }>;
}
export type TaskSummaryRequest =
  | { action: "summary-options"; id: string; originSessionId: string | null }
  | { action: "summary-source"; id: string; sessionId: string; leafId: string | null }
  | { action: "summary-generate"; id: string; operationId: string; expectedCurrentVersionId: string | null; model: SummaryModel; sources: SummarySelection[] }
  | { action: "summary-cancel"; id: string; operationId: string };
export type TaskSummaryResponse = SummaryOptions | SummarySnapshot | SummaryResult | { cancelled: true };
