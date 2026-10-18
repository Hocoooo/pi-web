"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { TaskRecord } from "@/lib/task-types";
import type { TaskReportSummary } from "@/lib/task-report-types";
import styles from "./TaskDashboard.module.css";

/** Reads never authorize model work. Explicit operations retain their ID until confirmed. */
export function TaskReports({ task, active = true }: { task: TaskRecord; active?: boolean }) {
  const { t } = useI18n();
  const [reports, setReports] = useState<TaskReportSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [latestSuccessfulReportId, setLatestSuccessfulReportId] = useState<string | null>(null);
  const [regenerationErrors, setRegenerationErrors] = useState<Record<string, string>>({});
  const regenerationIds = useRef<Record<string, string>>({});
  const [retryErrors, setRetryErrors] = useState<Record<string, string>>({});
  const [retrying, setRetrying] = useState<string | null>(null);
  const retryIds = useRef<Record<string, string>>({});
  const submitting = useRef(false);
  const submit = async (id: string, action: "retry" | "regenerate") => {
    if (submitting.current) return;
    submitting.current = true; setRetrying(id);
    const ids = action === "retry" ? retryIds : regenerationIds;
    const setErrors = action === "retry" ? setRetryErrors : setRegenerationErrors;
    const operationId = ids.current[id] ??= crypto.randomUUID();
    try {
      const response = await fetch("/api/task-reports", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, id, operationId }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || t("reports.archive.retryError"));
      if (!Number.isSafeInteger(data.attempt) || (action === "retry" ? data.id !== id : data.regeneratedFromId !== id || typeof data.id !== "string")) throw new Error(t("reports.archive.retryError"));
      delete ids.current[id];
      setErrors(value => { const next = { ...value }; delete next[id]; return next; });
      setReload(value => value + 1);
    } catch (e) { setErrors(value => ({ ...value, [id]: e instanceof Error ? e.message : t("reports.archive.retryError") })); }
    finally { submitting.current = false; setRetrying(null); }
  };
  const identities = (task.reportIds ?? []).join(",");
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setReports([]); setLatestSuccessfulReportId(null); setError(null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      try {
        const response = await fetch(`/api/task-reports?taskId=${encodeURIComponent(task.id)}`, { signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || t("reports.archive.readError"));
        if (!controller.signal.aborted) {
          setReports(data.reports); setLatestSuccessfulReportId(data.latestSuccessfulReportId); setError(null);
          if (data.reports.some((report: TaskReportSummary) => report.status === "queued" || report.status === "generating")) {
            timer = setTimeout(() => { void read(); }, 1000);
          }
        }
      } catch (e) { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : t("reports.archive.readError")); }
    };
    if (identities) void read();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [active, task.id, identities, reload, t]);
  if (!identities) return null;
  return <section aria-label={t("reports.archive.title")} className={styles.detailMetadata}>
    <h3>{t("reports.archive.title")}</h3>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <button type="button" onClick={() => setReload(value => value + 1)}>{t("reports.archive.reload")}</button>
    {latestSuccessfulReportId && <p><a href={`/api/task-reports?id=${encodeURIComponent(latestSuccessfulReportId)}&body=1`} target="_blank" rel="noreferrer">{t("reports.archive.latestSuccessful")}</a></p>}
    <h4>{t("reports.archive.history")}</h4>
    {reports.map((report, index) => <div key={report.id} style={{ overflowWrap: "anywhere" }}>
      <h4>{t("reports.archive.version")} {index + 1}{index === reports.length - 1 && ` · ${t("reports.archive.current")}`}</h4>
      {report.regeneratedFromId && <p className={styles.hint}>{t("reports.archive.regeneratedFrom")}: {report.regeneratedFromId}</p>}
      <p role="status">{t(`reports.archive.status.${report.status}`)} · <time dateTime={report.createdAt}>{new Date(report.createdAt).toLocaleString()}</time></p>
      {report.phase && <p className={styles.hint}>{t(`reports.archive.phase.${report.phase}`)}</p>}
      {report.stage && <p className={styles.hint}>{t(`reports.archive.stage.${report.stage.kind}`)}{report.stage.level !== undefined && ` · ${t("reports.archive.level")} ${report.stage.level}`}{report.stage.materialId && ` · ${report.stage.materialId}`}</p>}
      {report.materials && <div style={{ overflowWrap: "anywhere" }}>
        <p className={styles.hint}>{t("reports.archive.materials")} · {report.materials.filter(material => material.hasBody).length}/{report.materials.length}</p>
        <ul>{report.materials.map(material => <li key={material.id}>
          {material.hasBody ? <a href={`/api/task-reports?id=${encodeURIComponent(report.id)}&material=${encodeURIComponent(material.id)}`} target="_blank" rel="noreferrer">{material.id}</a>
            : <span>{material.id} · {t("reports.archive.materialPending")}</span>}
          {` · ${t("reports.archive.level")} ${material.level ?? 0}`}
          {material.inputMaterialIds && <span> · {t("reports.archive.inputs")}: {material.inputMaterialIds.join(", ")}</span>}
        </li>)}</ul>
      </div>}
      {report.error && <p role="alert" className={styles.error} style={{ overflowWrap: "anywhere" }}>{report.error}</p>}
      {report.status === "failed" && <p className={styles.hint}>{t("reports.archive.failure")}</p>}
      {report.status === "unconfirmed" && <p className={styles.hint}>{t("reports.archive.unknown")}</p>}
      {(["failed", "unconfirmed", "awaiting-configuration"].includes(report.status) || retryErrors[report.id]) && <div>
        <p className={styles.hint}>{t("reports.archive.retryCharge")}</p>
        {retryErrors[report.id] && <p role="alert" className={styles.error} style={{ overflowWrap: "anywhere" }}>{retryErrors[report.id]}</p>}
        <button type="button" disabled={retrying !== null} onClick={() => { void submit(report.id, "retry"); }}>
          {t(retrying === report.id ? "reports.archive.retrying" : retryErrors[report.id] ? "reports.archive.retryExact" : "reports.archive.retry")}
        </button>
      </div>}
      {report.configurationIssue && <p className={styles.hint}>{["unconfigured", "model-unavailable", "invalid-level"].includes(report.configurationIssue) ? t(`reports.settings.${report.configurationIssue}`) : report.configurationIssue}</p>}
      {report.sources.length === 0 && <p className={styles.hint}>{t("reports.archive.noSources")}</p>}
      {report.sources.map(source => <p key={source.sessionId} className={styles.hint} style={{ overflowWrap: "anywhere" }}>
        {source.sessionId} · {t(`reports.archive.source.${source.status}`)} · {t("reports.archive.cutoff")}: {source.cutoffEntryId ?? "—"}
        {source.activity.running && ` · ${t("tasks.aiWorking")}`}
        {source.error && ` · ${source.error}`}
      </p>)}
      <p className={styles.hint}>{t("reports.archive.snapshotOnly")}</p>
      <div>
        <p className={styles.hint}>{t("reports.archive.regenerateCharge")}</p>
        {regenerationErrors[report.id] && <p role="alert" className={styles.error}>{regenerationErrors[report.id]}</p>}
        <button type="button" disabled={retrying !== null} onClick={() => { void submit(report.id, "regenerate"); }}>
          {t(retrying === report.id ? "reports.archive.retrying" : regenerationErrors[report.id] ? "reports.archive.regenerateExact" : "reports.archive.regenerate")}
        </button>
      </div>
      {report.hasBody && <a href={`/api/task-reports?id=${encodeURIComponent(report.id)}&body=1`} target="_blank" rel="noreferrer">{t("reports.archive.open")}</a>}
    </div>)}
  </section>;
}
