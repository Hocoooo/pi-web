"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { TaskArchivePreview as ArchivePreview } from "@/lib/task-types";
import styles from "./TaskDashboard.module.css";
import archiveStyles from "./TaskArchivePreview.module.css";

/** Inline, read-only review. Consent belongs to this snapshot, never a refreshed board. */
export function TaskArchivePreview({ preview, error, disabled, onConfirm, onCancel, onRetry }: {
  preview: ArchivePreview | null; error: string | null; disabled: boolean;
  onConfirm: (confirmCrossTask: boolean) => void; onCancel: () => void; onRetry: () => void;
}) {
  const { t } = useI18n();
  const [consent, setConsent] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const crossTask = preview?.families.some(family => family.otherTasks.length > 0) ?? false;
  useLayoutEffect(() => {
    panel.current?.focus({ preventScroll: true });
    panel.current?.scrollIntoView({ block: "nearest" });
  }, []);
  return <section ref={panel} tabIndex={-1} role="region" aria-label={t("tasks.archive.review")} data-task-archive-preview className={archiveStyles.review}
    onKeyDown={event => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      event.preventDefault(); onCancel();
    }}>
    <h3>{t("tasks.archive.review")}</h3>
    <p>{t("tasks.archive.cascadeHelp")}</p>
    <p>{t("tasks.archive.restoreHelp")}</p>
    {!preview && !error && <p role="status">{t("tasks.archive.previewLoading")}</p>}
    {error && <div role="alert" className={styles.error}>{error} <button type="button" disabled={disabled} onClick={onRetry}>{t("tasks.refresh")}</button></div>}
    {preview && <>
      <p>{t("tasks.archive.familyCount", { count: preview.families.length })}</p>
      <ul className={archiveStyles.families}>{preview.families.map(family => <li key={family.rootSessionId}>
        <strong>{family.name || family.rootSessionId}</strong>
        <p className={styles.hint}>{t("tasks.archive.sessionCount", { count: family.sessionIds.length })}</p>
        <details><summary>{t("tasks.archive.familyMembers")}</summary><ul>{family.sessionIds.map(id => <li key={id}><code>{id}</code></li>)}</ul></details>
        {family.otherTasks.length > 0 && <><p>{t("tasks.archive.otherTasks")}</p><ul>{family.otherTasks.map(task => <li key={task.id}>
          {task.title} · {t("tasks.archive.sessionCount", { count: task.sessionIds.length })}
        </li>)}</ul></>}
      </li>)}</ul>
      {preview.skipped.length > 0 && <><h3>{t("tasks.archive.skippedCount", { count: preview.skipped.length })}</h3><ul>{preview.skipped.map(item => <li key={item.sessionId}>
        <code>{item.sessionId}</code> · {t(`tasks.archive.skip.${item.reason}`)}
      </li>)}</ul></>}
      {crossTask && <label className={styles.sessionChoice}><input type="checkbox" checked={consent} disabled={disabled} onChange={event => setConsent(event.target.checked)} /><span>{t("tasks.archive.crossTaskConsent")}</span></label>}
    </>}
    <div className={styles.actions}>
      <button type="button" disabled={disabled || !preview || (crossTask && !consent)} onClick={() => onConfirm(crossTask && consent)}>{t("tasks.archive.confirmCascade")}</button>
      <button type="button" onClick={onCancel}>{t("sidebar.cancel")}</button>
    </div>
  </section>;
}
