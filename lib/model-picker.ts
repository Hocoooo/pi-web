import type { SettingChangeResult } from "./model-command";

export interface PickerModel { provider: string; modelId: string; name: string }
export function modelKey(model: Pick<PickerModel, "provider" | "modelId">): string {
  return `${model.provider}:${model.modelId}`;
}
export function filterModelOptions<T extends PickerModel>(options: T[], query: string): T[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return options;
  return options.filter(option => `${option.name} ${option.modelId} ${option.provider}/${option.modelId}`.toLocaleLowerCase().includes(normalized));
}
export interface ThinkingPickerConfig {
  level?: string;
  levels: Record<string, string[]>;
  levelMaps?: Record<string, Record<string, string | null>>;
  onConfirm: (provider: string, modelId: string, level: string) => Promise<SettingChangeResult>;
}
export function hasThinkingPickerConfig(thinking?: ThinkingPickerConfig | null): thinking is ThinkingPickerConfig {
  return Boolean(thinking?.onConfirm);
}

export function initialThinkingLevel(levels: string[], current?: string): string {
  return (current && levels.includes(current) ? current : levels.includes("high") ? "high" : levels[0]) ?? "";
}
export function nextPickerIndex(current: number, count: number, key: string): number {
  if (!count) return -1;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return (Math.max(0, current) + (key === "ArrowUp" ? -1 : 1) + count) % count;
}
