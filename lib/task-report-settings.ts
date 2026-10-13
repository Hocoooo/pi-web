import { createAgentSessionServices, getAgentDir } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { getGlobalSettingsPath, readGlobalSettings, updateGlobalSettings } from "./global-settings-file";
import { resolveVisibleModels } from "./model-scope";
import type { TaskReportModelSelection, TaskReportSettings, TaskReportSettingsErrorCode } from "./task-report-settings-types";

export class TaskReportSettingsError extends Error {
  constructor(public code: TaskReportSettingsErrorCode, message: string) { super(message); }
}

function parseSelection(value: unknown): TaskReportModelSelection | null {
  if (value === null) return null;
  if (typeof value !== "object" || !value || Array.isArray(value)
    || Object.keys(value).length !== 3
    || !["provider", "modelId", "thinkingLevel"].every((key) => typeof (value as Record<string, unknown>)[key] === "string"
      && !!(value as Record<string, string>)[key].trim())) {
    throw new TaskReportSettingsError("invalid-input", "Choose a report model and an explicit thinking level.");
  }
  const { provider, modelId, thinkingLevel } = value as TaskReportModelSelection;
  return { provider, modelId, thinkingLevel };
}

async function readSelection(agentDir: string): Promise<TaskReportModelSelection | null> {
  try {
    return await readGlobalSettings(getGlobalSettingsPath(agentDir), (settings) =>
      settings.taskArchiveReport === undefined ? null : parseSelection(settings.taskArchiveReport));
  } catch {
    throw new TaskReportSettingsError("storage-unavailable", "Could not read global report settings.");
  }
}

/** Independent global services: no project overrides, deferred source runtime or model request. */
async function modelOptions(agentDir: string): Promise<Pick<TaskReportSettings, "models" | "thinkingLevels" | "thinkingLevelMaps">> {
  try {
    const services = await createAgentSessionServices({ cwd: agentDir, agentDir });
    if (services.modelRuntime.getError()) throw new Error("Models unavailable");
    const scope = await resolveVisibleModels(services.modelRuntime, services.settingsManager.getEnabledModels());
    const thinkingLevels: TaskReportSettings["thinkingLevels"] = {};
    const thinkingLevelMaps: TaskReportSettings["thinkingLevelMaps"] = {};
    for (const model of scope.visible) {
      const key = `${model.provider}:${model.id}`;
      thinkingLevels[key] = getSupportedThinkingLevels(model);
      if (model.thinkingLevelMap) thinkingLevelMaps[key] = model.thinkingLevelMap;
    }
    return { models: scope.visible.map((model) => ({ provider: model.provider, modelId: model.id, name: model.name })), thinkingLevels, thinkingLevelMaps };
  } catch {
    throw new TaskReportSettingsError("models-unavailable", "Could not load available report models.");
  }
}

function settingsState(selection: TaskReportModelSelection | null, options: Awaited<ReturnType<typeof modelOptions>>): TaskReportSettings {
  const model = selection && options.models.find((model) => model.provider === selection.provider && model.modelId === selection.modelId);
  const availability = !selection ? "unconfigured" : !model ? "model-unavailable"
    : selection.thinkingLevel === "auto" || !options.thinkingLevels[`${selection.provider}:${selection.modelId}`]?.includes(selection.thinkingLevel)
      ? "invalid-level" : "ready";
  return { selection, availability, ...options };
}

/** Public read seam for future archive intents; retains unavailable choices, never falls back. */
export async function getTaskReportSettings(agentDir = getAgentDir()): Promise<TaskReportSettings> {
  const selection = await readSelection(agentDir);
  return settingsState(selection, await modelOptions(agentDir));
}

/** Save only the report selection under the existing global SettingsManager file lock. */
export async function saveTaskReportSettings(input: unknown, agentDir = getAgentDir()): Promise<TaskReportSettings> {
  const selection = parseSelection(input);
  const state = settingsState(selection, await modelOptions(agentDir));
  if (state.availability === "model-unavailable") throw new TaskReportSettingsError("model-unavailable", "Report model is unavailable.");
  if (state.availability === "invalid-level") throw new TaskReportSettingsError("invalid-level", "Thinking level is not supported by the report model.");
  try {
    await updateGlobalSettings(getGlobalSettingsPath(agentDir), (settings) => {
      if (selection) settings.taskArchiveReport = selection;
      else delete settings.taskArchiveReport;
    });
  } catch {
    throw new TaskReportSettingsError("storage-unavailable", "Could not save global report settings.");
  }
  return state;
}
