"use client";

import { TaskSessions } from "./TaskSessions";
import { type FormEvent } from "react";
import { useI18n } from "@/hooks/useI18n";
import { TASK_PRIORITIES, TASK_TEXT_LIMITS, type TaskRecord, type TaskRequest, type TaskSessionInfo, type TaskSessionActivity } from "@/lib/task-types";
import styles from "./TaskDashboard.module.css";

type EditRequest = Extract<TaskRequest, { action: "edit" }>;
export interface TaskEditDraft {
  request: EditRequest;
  labelsText: string;
  error: string | null;
}

/** Drafts live above columns so a refreshed/moved card cannot discard or silently rebase input. */
export function TaskDetails({ task, disabled, active = true, currentSessionId, editDraft, onDraftChange, onSave, onLink, onChangeRelation, runningIds, sessionActivity }: {
  active?: boolean;
  currentSessionId?: string | null;
  onChangeRelation: (session: TaskSessionInfo) => void;
  onLink: (request: Extract<TaskRequest, { action: "link" }>) => Promise<void>;
  runningIds: Set<string> | null;
  sessionActivity: Record<string, TaskSessionActivity>;
  task: TaskRecord;
  disabled: boolean;
  editDraft: TaskEditDraft | null;
  onDraftChange: (draft: TaskEditDraft | null) => void;
  onSave: (request: EditRequest) => Promise<void>;
}) {
  const { t } = useI18n();
  const draft = editDraft?.request ?? null;
  const labelsText = editDraft?.labelsText ?? "";
  const error = editDraft?.error ?? null;
  function setDraft(request: EditRequest) {
    onDraftChange({ request, labelsText, error });
  }
  function beginEdit() {
    onDraftChange({ request: { action: "edit", id: task.id, expectedRevision: task.revision, title: task.title,
      description: task.description, completionCriteria: task.completionCriteria, priority: task.priority, labels: [...task.labels] },
      labelsText: task.labels.join("\n"), error: null });
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editDraft || !draft || disabled) return;
    onDraftChange({ ...editDraft, error: null });
    try {
      await onSave({ ...draft, labels: labelsText.split(/\r?\n/).filter((label) => label.trim()) });
      onDraftChange(null);
    } catch (cause) { onDraftChange({ ...editDraft, error: (cause as Error).message }); }
  }
  return <section aria-label={task.title}>
    <h2 className={styles.detailTitle}>{task.title}</h2>
    <TaskSessions task={task} active={active} currentSessionId={currentSessionId} disabled={disabled} onLink={onLink} onChangeRelation={onChangeRelation} runningIds={runningIds} sessionActivity={sessionActivity} />
    {draft ? <form onSubmit={save} className={styles.editForm} aria-label={t("tasks.edit")}>
      <label>{t("tasks.title")}<input aria-label={t("tasks.title")} autoFocus required maxLength={TASK_TEXT_LIMITS.title} disabled={disabled} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
      <label>{t("tasks.description")}<textarea aria-label={t("tasks.description")} rows={3} maxLength={TASK_TEXT_LIMITS.description} disabled={disabled} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></label>
      <label>{t("tasks.criteria")}<textarea aria-label={t("tasks.criteria")} rows={3} maxLength={TASK_TEXT_LIMITS.completionCriteria} disabled={disabled} value={draft.completionCriteria} onChange={(event) => setDraft({ ...draft, completionCriteria: event.target.value })} /></label>
      <label>{t("tasks.priority")}<select aria-label={t("tasks.priority")} disabled={disabled} value={draft.priority} onChange={(event) => setDraft({ ...draft, priority: Number(event.target.value) as TaskRecord["priority"] })}>
        {TASK_PRIORITIES.map((priority) => <option key={priority} value={priority}>{t(`tasks.priority.${priority}`)}</option>)}
      </select></label>
      <label>{t("tasks.labels")}<textarea aria-label={t("tasks.labels")} rows={3} disabled={disabled} value={labelsText} onChange={(event) => onDraftChange({ request: draft, labelsText: event.target.value, error })} /></label>
      <p className={styles.hint}>{t("tasks.labelsHint")}</p>
      {error && <div role="alert" className={styles.error}>{error}<p>{t("tasks.draftKept")}</p></div>}
      <div className={styles.actions}>
        <button type="submit" disabled={disabled}>{t("tasks.save")}</button>
        <button type="button" disabled={disabled} onClick={() => onDraftChange(null)}>{t("sidebar.cancel")}</button>
      </div>
    </form> : <>
      {task.description && <><h3>{t("tasks.description")}</h3><p className={styles.text}>{task.description}</p></>}
      {task.completionCriteria && <><h3>{t("tasks.criteria")}</h3><p className={styles.text}>{task.completionCriteria}</p></>}
      {task.project && <><h3>{t("tasks.projectDirectory")}</h3><p className={styles.text}>{task.project.cwd}</p></>}
      <button type="button" disabled={disabled} onClick={beginEdit}>{t("tasks.edit")}</button>
    </>}
  </section>;
}
