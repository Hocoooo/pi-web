"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { TaskProjectsResult, TaskProjectPreview, TaskRecord, TaskRequest } from "@/lib/task-types";
import { DirectoryPicker } from "./DirectoryPicker";
import styles from "./TaskDashboard.module.css";

/** Directory references only: selecting a task project never grants file access or starts a session. */
export function TaskProjectField({ cwd, onChange, disabled, active = true }: {
  cwd: string; onChange: (cwd: string) => void; disabled: boolean; active?: boolean;
}) {
  const { t } = useI18n();
  const id = useId();
  const [projects, setProjects] = useState<TaskProjectsResult["projects"]>([]);
  const [browse, setBrowse] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void fetch("/api/tasks", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "projects" }), signal: controller.signal })
      .then(async response => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
        if (!controller.signal.aborted) { setProjects(data.projects); setError(null); }
      }).catch(cause => { if (!controller.signal.aborted) setError((cause as Error).message); });
    return () => controller.abort();
  }, [active, reload]);
  return <div className={styles.projectField}>
    <label htmlFor={id}>{t("tasks.projectDirectory")}</label>
    <div className={styles.projectSelectRow}>
      <select id={id} title={cwd || t("tasks.noProject")} value={cwd} disabled={disabled} onChange={event => onChange(event.target.value)}>
        <option value="">{t("tasks.noProject")}</option>
        {cwd && !projects.some(project => project.cwd === cwd) && <option value={cwd}>{cwd}</option>}
        {projects.map(project => <option key={project.projectKey} value={project.cwd}>
          {project.projectRoot.split(/[\\/]/).filter(Boolean).at(-1)} · {project.projectRoot}
        </option>)}
      </select>
      <button type="button" disabled={disabled} onClick={() => setBrowse(true)}>{t("tasks.chooseProject")}</button>
    </div>
    {error && <div role="alert" className={styles.hint}>{error} <button type="button" disabled={disabled} onClick={() => setReload(value => value + 1)}>{t("tasks.refresh")}</button></div>}
    {active && browse && <div onSubmit={event => event.stopPropagation()} onKeyDownCapture={event => {
      if (event.key === "Escape" && (event.nativeEvent.isComposing || event.keyCode === 229)) event.stopPropagation();
    }} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); } }}>
      <DirectoryPicker initialPath={cwd || undefined} onCancel={() => setBrowse(false)} onSelect={directory => { onChange(directory); setBrowse(false); }} />
    </div>}
  </div>;
}

type ChangeRequest = Extract<TaskRequest, { action: "change-project" }>;
export function TaskProjectEditor({ task, active, disabled, onSave, newOperationId }: {
  task: TaskRecord; active: boolean; disabled: boolean;
  onSave: (request: ChangeRequest) => Promise<void>; newOperationId: () => string;
}) {
  const { t } = useI18n();
  const [cwd, setCwd] = useState<string | null>(null); // null closes the editor; empty string means no project.
  const [preview, setPreview] = useState<TaskProjectPreview | null>(null);
  const [request, setRequest] = useState<ChangeRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  function cancel() { setCwd(null); setPreview(null); setRequest(null); setError(null); }
  async function save() {
    if (cwd === null || disabled || pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      let next = request;
      if (!next) {
        const response = await fetch("/api/tasks", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "preview-project", id: task.id, cwd: cwd || null }) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
        const snapshot = data as TaskProjectPreview;
        next = { action: "change-project", id: task.id, cwd: cwd || null, expectedRevision: snapshot.revision, previewToken: snapshot.token, operationId: newOperationId() };
        setRequest(next); setPreview(snapshot);
        if (snapshot.detachSessionIds.length) return; // Explicit confirmation, never silently unlink.
      }
      await onSave(next);
      cancel();
    } catch (cause) {
      setError((cause as Error).message);
      // An actual conflict needs a fresh preview/confirmation. Network failures retain the exact retry.
      if ((cause as { code?: string }).code === "conflict") { setRequest(null); setPreview(null); }
    } finally { pending.current = false; setBusy(false); }
  }
  if (cwd === null) return <div className={styles.projectSummary}>
    <span title={task.project?.cwd}>{task.project?.cwd ?? t("tasks.noProject")}</span>
    <button type="button" disabled={disabled} onClick={() => setCwd(task.project?.cwd ?? "")}>{t("tasks.project.change")}</button>
  </div>;
  return <div className={styles.projectEditor}>
    <TaskProjectField cwd={cwd} disabled={disabled || busy} active={active} onChange={value => { setCwd(value); setPreview(null); setRequest(null); setError(null); }} />
    {!!preview?.detachSessionIds.length && <p role="status" className={styles.hint}>{t(preview.detachSessionIds.length === 1 ? "tasks.project.unlinkOne" : "tasks.project.unlinkMany", { count: preview.detachSessionIds.length })}</p>}
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <div className={styles.actions}>
      <button type="button" disabled={disabled || busy} onClick={() => void save()}>{t(preview?.detachSessionIds.length ? "tasks.project.confirm" : "tasks.project.save")}</button>
      <button type="button" disabled={disabled || busy} onClick={cancel}>{t("sidebar.cancel")}</button>
    </div>
  </div>;
}
