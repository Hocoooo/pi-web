"use client";

import { useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { TaskRecord, TaskRelationRequest, TaskSessionInfo } from "@/lib/task-types";
import styles from "./TaskDashboard.module.css";

/** Fixed source/epoch/CAS; refresh must never silently rebase an open confirmation. */
export function TaskRelation({ source, session, tasks, disabled, newOperationId, onSave, onCancel }: {
  source: TaskRecord; session: TaskSessionInfo; tasks: TaskRecord[]; disabled: boolean;
  newOperationId: () => string; onSave: (request: TaskRelationRequest) => Promise<void>; onCancel: () => void;
}) {
  const { t } = useI18n();
  const [targetId, setTargetId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const request = useRef<TaskRelationRequest | null>(null);
  const select = useRef<HTMLSelectElement>(null);
  useEffect(() => { select.current?.focus(); }, []);
  const targets = tasks.filter(task => task.id !== source.id && (task.project?.projectKey ?? null) === (source.project?.projectKey ?? null));
  const target = targets.find(task => task.id === targetId);
  async function save() {
    request.current ??= { action: "change-session-relation", sessionId: session.id, sourceTaskId: source.id,
      targetTaskId: targetId || null, expectedGeneration: session.relationGeneration ?? 0,
      expectedUpdateRevision: session.updateRevision ?? 0, operationId: newOperationId() };
    try { await onSave(request.current); }
    catch (cause) { setError((cause as Error).message); }
  }
  return <section aria-label={t("tasks.relation.title")} className={styles.form}
    onKeyDown={event => { if (event.key === "Escape" && !disabled && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); onCancel(); } }}>
    <h2>{t("tasks.relation.title")}</h2>
    <p>{session.name || session.id} — {session.id}</p>
    <p>{t("tasks.relation.source")}: {source.title} — {source.id}</p>
    <label>{t("tasks.relation.target")}
      <select aria-label={t("tasks.relation.target")} ref={select} value={targetId} disabled={disabled} onChange={event => { setTargetId(event.target.value); request.current = null; setError(null); }}>
        <option value="">{t("tasks.relation.unlink")}</option>
        {targets.map(task => <option key={task.id} value={task.id}>{task.title} — {task.id}</option>)}
      </select>
    </label>
    <p>{t("tasks.relation.target")}: {target ? `${target.title} — ${target.id}` : t("tasks.relation.unlink")}</p>
    <p>{t("tasks.relation.warning")}</p>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    <div className={styles.actions}>
      <button type="button" disabled={disabled || !!targetId && !target} onClick={() => void save()}>{t(error ? "tasks.relation.retry" : "tasks.relation.confirm")}</button>
      <button type="button" disabled={disabled} onClick={onCancel}>{t("sidebar.cancel")}</button>
    </div>
  </section>;
}
