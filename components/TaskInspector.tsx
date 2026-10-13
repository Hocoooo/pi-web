"use client";

import type { ReactNode, RefObject } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { TaskColumnId, TaskMovePosition, TaskRecord, TaskSort } from "@/lib/task-types";
import styles from "./TaskDashboard.module.css";
import { TaskReports } from "./TaskReports";

/** Outside the board projection: filtering, moving and archiving cannot remove an open review. */
export function TaskInspector({ active = true, hidden = false, task, visibleTasks, sort, disabled, panelRef, onClose, onMove, onArchive, archiveReview, onCancelArchive, onResumeArchive, feedback, children }: {
  task: TaskRecord; visibleTasks: TaskRecord[]; sort: TaskSort; disabled: boolean;
  active?: boolean; hidden?: boolean; panelRef?: RefObject<HTMLDivElement | null>; onClose: () => void;
  onMove: (task: TaskRecord, columnId: TaskColumnId, position?: TaskMovePosition) => void;
  onArchive: (trigger: HTMLButtonElement) => void; archiveReview?: ReactNode;
  onCancelArchive?: () => void; onResumeArchive?: () => void; feedback: ReactNode; children: ReactNode;
}) {
  const { t } = useI18n();
  const neighbors = visibleTasks.filter(item => item.columnId === task.columnId);
  const index = neighbors.findIndex(item => item.id === task.id);
  return <div hidden={hidden} ref={panelRef} tabIndex={-1} className={styles.inspector} data-task-inspector={task.id}
    onKeyDown={event => {
      if (event.key === "Escape" && onCancelArchive && !event.defaultPrevented) {
        event.stopPropagation();
        if (!event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); onCancelArchive(); }
        return;
      }
      if (event.key === "Escape" && !event.defaultPrevented && !event.nativeEvent.isComposing && event.keyCode !== 229) {
        event.preventDefault(); event.stopPropagation(); onClose();
      }
    }}>
    <header className={styles.inspectorHeader}><span>{t("tasks.panel.details")}</span><button type="button" aria-label={t("tasks.panel.closeDetails")} onClick={onClose}>✕</button></header>
    {children}
    <div className={styles.detailMetadata}>
      <p className={styles.metadata}>{t("tasks.priority")}: {t(`tasks.priority.${task.priority}`)}</p>
      {task.labels.length > 0 && <ul className={styles.labels} aria-label={t("tasks.labels")}>{task.labels.map(label => <li key={label}>{label}</li>)}</ul>}
      <p className={styles.metadata}>{t("tasks.updated")}: <time dateTime={task.updatedAt}>{new Date(task.updatedAt).toLocaleString()}</time></p>
    </div>
    <TaskReports task={task} active={active} />
    {feedback}
    {task.pendingSessionArchive && <div role="status" className={styles.error}>
      <p>{t("tasks.archive.pending")}</p>
      <button type="button" disabled={disabled} onClick={onResumeArchive}>{t("tasks.archive.resume")}</button>
      <p className={styles.hint}>{t("tasks.archive.cancelPending")}</p>
    </div>}
    {archiveReview}
    {sort !== "manual" && <p className={styles.hint}>{t("tasks.view.autoHelp")}</p>}
    <div className={styles.actions}>
      {task.archived && <span>{t("tasks.archive.archived")}</span>}
      <button type="button" disabled={disabled || !!archiveReview} aria-label={`${t(task.archived ? "tasks.archive.restore" : "tasks.archive.archive")}: ${task.title}`} onClick={event => onArchive(event.currentTarget)}>{t(task.archived ? "tasks.archive.restore" : "tasks.archive.archive")}</button>
      <button type="button" disabled={disabled || sort !== "manual" || index <= 0} aria-label={`${t("tasks.moveUp")}: ${task.title}`} onClick={() => onMove(task, task.columnId, { before: neighbors[index - 1].id })}>{t("tasks.moveUp")}</button>
      <button type="button" disabled={disabled || sort !== "manual" || index < 0 || index === neighbors.length - 1} aria-label={`${t("tasks.moveDown")}: ${task.title}`} onClick={() => onMove(task, task.columnId, { after: neighbors[index + 1].id })}>{t("tasks.moveDown")}</button>
    </div>
  </div>;
}
