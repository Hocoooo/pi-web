"use client";

import { ModelSelector } from "./ModelSelector";
import type { SettingChangeResult } from "@/lib/model-command";
import { hasThinkingPickerConfig, type PickerModel } from "@/lib/model-picker";

interface Props {
  model?: { provider: string; modelId: string } | null;
  isAutoModelSelection?: boolean;
  modelNames?: Record<string, string>;
  modelList?: { id: string; name: string; provider: string; input?: string[] }[];
  onModelChange: (provider: string, modelId: string) => void;
  defaultModel?: { provider: string; modelId: string } | null;
  onSetDefaultModel?: (provider: string, modelId: string) => void;
  onModelThinkingChange?: (provider: string, modelId: string, level: string) => Promise<SettingChangeResult>;
  modelThinkingLevels?: Record<string, string[]>;
  modelThinkingLevelMaps?: Record<string, Record<string, string | null>>;
  modelSwitching?: boolean;
  thinkingLevel?: string;
  disabled?: boolean;
  openRequest?: { query: string };
  onRequestClose?: () => void;
}

export function ChatInputModelControl({
  model, isAutoModelSelection, modelNames, modelList, onModelChange, onModelThinkingChange,
  modelThinkingLevels, modelThinkingLevelMaps, modelSwitching, thinkingLevel, disabled,
  openRequest, onRequestClose, defaultModel, onSetDefaultModel,
}: Props) {
  const options: PickerModel[] = modelList?.length
    ? modelList.map((entry) => ({ provider: entry.provider, modelId: entry.id, name: entry.name }))
    : Object.entries(modelNames ?? {}).map(([modelId, name]) => ({
      provider: model?.provider ?? "unknown",
      modelId,
      name,
    }));
  const thinking = onModelThinkingChange
    ? { level: thinkingLevel, levels: modelThinkingLevels ?? {}, levelMaps: modelThinkingLevelMaps, onConfirm: onModelThinkingChange }
    : undefined;
  return (
    <ModelSelector
      options={options}
      value={model}
      onChange={onModelChange}
      defaultValue={defaultModel}
      onSetDefault={onSetDefaultModel}
      disabled={disabled}
      busy={modelSwitching}
      openRequest={openRequest}
      onRequestClose={onRequestClose}
      thinking={hasThinkingPickerConfig(thinking) ? thinking : undefined}
      isAutoSelection={isAutoModelSelection}
    />
  );
}
