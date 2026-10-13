/** Global report-only selection; never a chat default or an `auto` level. */
export interface TaskReportModelSelection {
  provider: string;
  modelId: string;
  thinkingLevel: string;
}

export type TaskReportSettingsAvailability = "unconfigured" | "ready" | "model-unavailable" | "invalid-level";
export type TaskReportSettingsErrorCode = "invalid-input" | "model-unavailable" | "invalid-level" | "models-unavailable" | "storage-unavailable";

export interface TaskReportSettings {
  selection: TaskReportModelSelection | null;
  availability: TaskReportSettingsAvailability;
  models: Array<{ provider: string; modelId: string; name: string }>;
  thinkingLevels: Record<string, string[]>;
  thinkingLevelMaps: Record<string, Record<string, string | null>>;
}
