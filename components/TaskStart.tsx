"use client";
import { useContext, useState } from "react";
import { TaskPanelNavigation } from "./task-panel-navigation";
import { useRouter } from "next/navigation";
import { useI18n } from "@/hooks/useI18n";
import type { TaskRecord, TaskStartPreview } from "@/lib/task-types";
import { rememberTaskPreview } from "@/lib/task-start-client";
import { TaskContextPreview } from "./TaskContextPreview";
import styles from "./TaskDashboard.module.css";

export function TaskStart({ task, disabled, newOperationId }: { task: TaskRecord; disabled: boolean; newOperationId: () => string }) {
  const { t } = useI18n();
  const router = useRouter();
  const navigate = useContext(TaskPanelNavigation);
  const [open, setOpen] = useState(false);
  const [sessionId, setSessionId] = useState("");
  const [preview, setPreview] = useState<TaskStartPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function prepare() {
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/tasks", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "prepare-start", id: task.id, operationId: newOperationId(), sessionId: sessionId || null }) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
      setPreview(value);
    } catch (cause) { setError((cause as Error).message); } finally { setBusy(false); }
  }
  return <section aria-label={t("tasks.start")}>
    <button type="button" disabled={disabled} onClick={() => { setOpen(true); setSessionId(""); setPreview(null); setError(null); }}>{t("tasks.start")}</button>
    {open && <div>
      {!preview ? <>
        <label>{t("tasks.startTarget")}<select aria-label={t("tasks.startTarget")} value={sessionId} disabled={busy} onChange={e => setSessionId(e.target.value)}>
          <option value="">{t("tasks.startNew")}</option>
          {task.sessionIds.map(id => <option key={id} value={id}>{t("tasks.startContinue")} · {id}</option>)}
        </select></label>
        <button type="button" disabled={busy} onClick={() => void prepare()}>{t("tasks.startPreview")}</button>
      </> : <>
        <TaskStartMaterial preview={preview} />
        <button type="button" disabled={busy} onClick={async () => {
          const token = rememberTaskPreview(preview);
          const query = new URLSearchParams(preview.selection.sessionId ? { session: preview.selection.sessionId } : { cwd: preview.cwd });
          query.set("taskStart", token);
          if (!navigate) { router.push(`/?${query}`); return; }
          setBusy(true); setError(null);
          try { await navigate(`/?${query}`); }
          catch (cause) { setError((cause as Error).message); }
          finally { setBusy(false); }
        }}>{t("tasks.startOpen")}</button>
        <button type="button" onClick={() => setPreview(null)}>{t("tasks.startReview")}</button>
      </>}
      {error && <p role="alert" className={styles.error}>{error}</p>}
      <button type="button" disabled={busy} onClick={() => { setOpen(false); setPreview(null); }}>{t("sidebar.cancel")}</button>
    </div>}
  </section>;
}
export function TaskStartMaterial({ preview }: { preview: TaskStartPreview }) {
  const { t } = useI18n();
  const s = preview.snapshot;
  return <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
    <p>{t("tasks.startNoSend")}</p>
    <strong>{s.title}</strong><p>{s.taskId}</p><p>{s.description}</p><p>{s.completionCriteria}</p>
    <p>{t("tasks.startVersion")} {s.version?.id ?? t("tasks.startNoVersion")}</p>
    {s.version && <><p>{JSON.stringify(s.version.source)}</p><TaskContextPreview content={s.version.content} /></>}
    {preview.inheritedFromSessionId && <p>{t("tasks.startInherited")} {preview.inheritedFromSessionId}</p>}
    {preview.selection.mode === "continue" && <p>{t("tasks.startKeepVersion")}</p>}
    {preview.sameCwdBusy.length > 0 && <p role="status">{t("tasks.startCwdRisk")}</p>}
  </div>;
}
