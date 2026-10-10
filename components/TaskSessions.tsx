"use client";

import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { TaskPanelNavigation } from "./task-panel-navigation";
import Link from "next/link";
import { useI18n } from "@/hooks/useI18n";
import { TASK_SESSION_BATCH_LIMIT, type TaskRecord, type TaskRequest, type TaskSessionInfo, type TaskSessionsResult, type TaskSessionActivity } from "@/lib/task-types";
import styles from "./TaskDashboard.module.css";

export function TaskSessions({ task, disabled, onLink, onChangeRelation, runningIds, sessionActivity }: {
  onChangeRelation: (session: TaskSessionInfo) => void;
  task: TaskRecord; disabled: boolean; runningIds: Set<string> | null;
  sessionActivity: Record<string, TaskSessionActivity>;
  onLink: (request: Extract<TaskRequest, { action: "link" }>) => Promise<void>;
}) {
  const { t } = useI18n();
  const navigate = useContext(TaskPanelNavigation);
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<TaskSessionsResult | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const version = useRef(0);
  const load = useCallback(async () => {
    const current = ++version.current;
    setLoading(true);
    try {
      const response = await fetch("/api/tasks", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sessions", id: task.id }) });
      const next = await response.json();
      if (!response.ok) throw new Error(next.error ?? `HTTP ${response.status}`);
      if (version.current === current) { setData(next); setError(null); }
    } catch (cause) { if (version.current === current) setError((cause as Error).message); }
    finally { if (version.current === current) setLoading(false); }
  }, [task.id]);
  useEffect(() => {
    if (!open) return;
    const requests = version;
    void load();
    return () => { requests.current++; };
    // Explicitly reread after a saved link; no full-history hydration or Agent command.
  }, [open, task.revision, load]);
  async function link() {
    if (disabled || loading || selected.length === 0) return;
    try {
      await onLink({ action: "link", id: task.id, expectedRevision: task.revision, sessionIds: selected });
      setSelected([]); setError(null);
    } catch (cause) { setError((cause as Error).message); }
  }
  const hint = (session: TaskSessionInfo) => {
    const activity = sessionActivity[session.id];
    return session.missing ? t("tasks.sessionMissing") : runningIds === null ? t("tasks.activityUnknown")
      : !runningIds.has(session.id) ? t("tasks.aiIdle") : activity?.waitingForInput ? t("tasks.waitingInput")
      : activity?.compacting ? t("tasks.compacting") : activity?.bashRunning ? t("tasks.bashRunning")
      : activity?.queued ? t("tasks.queued") : t("tasks.aiWorking");
  };
  return <section aria-label={t("tasks.sessions")}>
    <button type="button" disabled={disabled} aria-expanded={open} onClick={() => setOpen(!open)}>{t("tasks.sessions")} ({task.sessionIds?.length ?? 0})</button>
    {open && <>
      <p className={styles.hint}>{t("tasks.linkPolicy")}</p>
      <button type="button" disabled={disabled || loading} onClick={() => void load()}>{t("tasks.refreshSessions")}</button>
      {loading && <p role="status">{t("tasks.loading")}</p>}
      {error && <div role="alert" className={styles.error}>{error}</div>}
      {data && <>
        <ul aria-label={t("tasks.linkedSessions")}>
          {data.linked.map((session) => <li key={session.id}>
            {session.missing ? <span>{session.id}</span> : <Link prefetch={false} href={`/?session=${encodeURIComponent(session.id)}`} onClick={event => {
              if (!navigate || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              void navigate(`/?session=${encodeURIComponent(session.id)}`).catch(cause => setError((cause as Error).message));
            }}>{session.name || session.id}</Link>}
            {" — "}{hint(session)}{session.cwd && <p className={styles.project}>{session.cwd}</p>}
            <button type="button" disabled={disabled || loading || !!session.missing} onClick={() => onChangeRelation(session)}>{t("tasks.relation.title")}</button>
          </li>)}
        </ul>
        <fieldset disabled={disabled || loading}>
          <legend>{t("tasks.linkSessions")}</legend>
          {data.candidates.length === 0 && <p>{t("tasks.noCandidates")}</p>}
          {data.candidates.map((session) => <label key={session.id} className={styles.sessionChoice}>
            <input type="checkbox" checked={selected.includes(session.id)}
              disabled={!selected.includes(session.id) && selected.length >= TASK_SESSION_BATCH_LIMIT}
              onChange={(event) => setSelected((ids) => event.target.checked ? [...ids, session.id] : ids.filter((id) => id !== session.id))} />
            <span>{session.name || session.id} — {hint(session)}{session.cwd && <span className={styles.project}>{session.cwd}</span>}</span>
          </label>)}
        </fieldset>
        <div className={styles.actions}>
          <button type="button" disabled={disabled || loading || selected.length === 0} onClick={() => void link()}>{t("tasks.linkSelected")} ({selected.length})</button>
          <button type="button" disabled={disabled || selected.length === 0} onClick={() => { setSelected([]); setError(null); }}>{t("sidebar.cancel")}</button>
        </div>
      </>}
    </>}
  </section>;
}
