"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { TaskReportModelSelection, TaskReportSettings as Settings } from "@/lib/task-report-settings-types";
import { ModelSelector } from "./ModelSelector";
import { ConfigButton, ConfigScopeTag } from "./SettingsUi";

async function requestSettings(selection?: TaskReportModelSelection | null, signal?: AbortSignal): Promise<Settings> {
  const response = await fetch("/api/task-reports/settings", selection === undefined ? { signal } : {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ selection }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.code ?? "storage-unavailable");
  return data;
}

/** General Settings' global-only report selection. Confirmation saves, browsing does not. */
export function TaskReportSettings({ active }: { active: boolean }) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void requestSettings(undefined, controller.signal).then((data) => {
      if (!controller.signal.aborted) setSettings(data);
    }).catch((error: Error) => {
      if (!controller.signal.aborted) setError(error.message);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [active, reload]);

  const errorText = (code: string) => t(`reports.settings.error.${["invalid-input", "model-unavailable", "invalid-level", "models-unavailable", "storage-unavailable"].includes(code) ? code : "storage-unavailable"}`);
  const save = async (selection: TaskReportModelSelection | null) => {
    setSaving(true);
    setError("");
    try {
      setSettings(await requestSettings(selection));
      return {};
    } catch (error) {
      const code = error instanceof Error ? error.message : "storage-unavailable";
      setError(code);
      return { error: errorText(code) };
    } finally { setSaving(false); }
  };

  return <section className="settings-general-section" aria-label={t("reports.settings.title")}>
    <h3 className="settings-general-heading">{t("reports.settings.title")} <ConfigScopeTag scope="global">{t("config.global")}</ConfigScopeTag></h3>
    <p className="settings-general-description">{t("reports.settings.help")}</p>
    <div className="settings-chat-option settings-chat-range-option">
      <label>{t("reports.settings.model")}</label>
      <ModelSelector variant="field" placement="auto" ariaLabel={t("reports.settings.model")}
        options={settings?.models ?? []} value={settings?.selection} emptyLabel={t("reports.settings.unconfigured")}
        disabled={loading || !settings} busy={saving} onChange={() => {}}
        thinking={{ level: settings?.selection?.thinkingLevel, levels: settings?.thinkingLevels ?? {}, levelMaps: settings?.thinkingLevelMaps,
          onConfirm: (provider, modelId, thinkingLevel) => save({ provider, modelId, thinkingLevel }) }} />
      {loading && <p role="status" className="settings-general-description">{t("reports.settings.loading")}</p>}
      {!loading && settings && <p role="status" className="settings-general-description">
        {t(`reports.settings.${settings.availability}`)}
        {settings.selection && ` · ${settings.selection.provider}/${settings.selection.modelId} · ${settings.selection.thinkingLevel}`}
      </p>}
      {error && <p role="alert" className="settings-general-error">{errorText(error)}</p>}
      <div className="config-detail-actions">
        <ConfigButton variant="secondary" size="small" disabled={loading || saving} onClick={() => setReload((value) => value + 1)}>{t("reports.settings.reload")}</ConfigButton>
        {settings?.selection && <ConfigButton variant="secondary" size="small" disabled={loading || saving} onClick={() => void save(null)}>{t("reports.settings.clear")}</ConfigButton>}
      </div>
    </div>
  </section>;
}
