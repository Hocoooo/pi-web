"use client";

import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { TaskPanelNavigation } from "./task-panel-navigation";
import Link from "next/link";
import { useI18n } from "@/hooks/useI18n";
import { TASK_SESSION_BATCH_LIMIT, type TaskRecord, type TaskRequest, type TaskSessionInfo, type TaskSessionsResult, type TaskSessionActivity } from "@/lib/task-types";
import styles from "./TaskDashboard.module.css";

export function TaskSessions({ task, active = true, currentSessionId, disabled, onLink, onChangeRelation, runningIds, sessionActivity }: {
  active?: boolean;
  currentSessionId?: string | null;
  onChangeRelation: (session: TaskSessionInfo) => void;
  task: TaskRecord; disabled: boolean; runningIds: Set<string> | null;
  sessionActivity: Record<string, TaskSessionActivity>;
  onLink: (request: Extract<TaskRequest, { action: "link" }>) => Promise<void>;
}) {
  const { t } = useI18n();
  const navigate = useContext(TaskPanelNavigation);
  const [linking, setLinking] = useState(false);
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
    if (!active) return;
    const requests = version;
    void load();
    return () => { requests.current++; };
    // Explicitly reread after a saved link; no full-history hydration or Agent command.
  }, [active, task.revision, load]);
  async function link() {
    if (disabled || loading || selected.length === 0) return;
    try {
      await onLink({ action: "link", id: task.id, expectedRevision: task.revision, sessionIds: selected });
      setSelected([]); setLinking(false); setError(null);
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
    <div className={styles.sectionHeader}>
      <h3>{t("tasks.sessions")} ({task.sessionIds.length})</h3>
      <div className={styles.actions}>
        <button type="button" className={styles.quietButton} disabled={!data || disabled || loading} aria-expanded={linking} onClick={() => setLinking(!linking)}>{t("tasks.linkSessions")}</button>
        <button type="button" className={styles.smallIconButton} aria-label={t("tasks.refreshSessions")} title={t("tasks.refreshSessions")} disabled={disabled || loading} onClick={() => void load()}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 7a7 7 0 0 1 12-1l2 2M4 16l2 2a7 7 0 0 0 12-1" /></svg>
        </button>
      </div>
    </div>
    <>
      {loading && <p role="status">{t("tasks.loading")}</p>}
      {error && <div role="alert" className={styles.error}>{error}</div>}
      {data && <>
        {data.linked.length === 0 && <p className={styles.hint}>{t("tasks.noLinkedSessions")}</p>}
        <ul className={styles.sessionList} aria-label={t("tasks.linkedSessions")}>
          {data.linked.map((session) => <li key={session.id}>
            <div className={styles.sessionInfo}>
            <div className={styles.sessionTitleRow}>
            {session.missing ? <span>{session.id}</span> : <Link prefetch={false} href={`/?session=${encodeURIComponent(session.id)}`} onClick={event => {
              if (!navigate || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              void navigate(`/?session=${encodeURIComponent(session.id)}`).catch(cause => setError((cause as Error).message));
            }}>{session.name || session.id}</Link>}
            {session.id === currentSessionId && <span className={styles.currentChat}>{t("tasks.panel.currentChat")}</span>}
            </div>
            <span className={styles.sessionState} data-working={runningIds?.has(session.id) || undefined}>{hint(session)}</span>
            {task.project && session.cwd && session.cwd !== task.project.cwd && <p className={styles.sessionPath} title={session.cwd}>{session.cwd}</p>}
            </div>
            <button type="button" className={styles.smallIconButton} aria-label={t("tasks.relation.title")} title={t("tasks.relation.title")} disabled={disabled || loading || !!session.missing} onClick={() => onChangeRelation(session)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>
            </button>
          </li>)}
        </ul>
        {linking && <><p className={styles.hint}>{t("tasks.linkPolicy")}</p><fieldset disabled={disabled || loading}>
          <legend>{t("tasks.linkSessions")}</legend>
          {data.candidates.length === 0 && <p>{t("tasks.noCandidates")}</p>}
          {data.candidates.map((session) => <label key={session.id} className={styles.sessionChoice}>
            <input type="checkbox" checked={selected.includes(session.id)}
              disabled={!selected.includes(session.id) && selected.length >= TASK_SESSION_BATCH_LIMIT}
              onChange={(event) => setSelected((ids) => event.target.checked ? [...ids, session.id] : ids.filter((id) => id !== session.id))} />
            <span>{session.name || session.id}{session.id === currentSessionId && <strong> · {t("tasks.panel.currentChat")}</strong>} — {hint(session)}{session.cwd && <span className={styles.project}>{session.cwd}</span>}</span>
          </label>)}
        </fieldset>
        <div className={styles.actions}>
          <button type="button" disabled={disabled || loading || selected.length === 0} onClick={() => void link()}>{t("tasks.linkSelected")} ({selected.length})</button>
          <button type="button" disabled={disabled || loading} onClick={() => { setSelected([]); setLinking(false); setError(null); }}>{t("sidebar.cancel")}</button>
        </div></>}
      </>}
    </>
  </section>;
}
