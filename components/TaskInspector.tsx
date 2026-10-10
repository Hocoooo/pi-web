"use client";

import type { ReactNode, RefObject } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { TaskBoard, TaskColumnId, TaskMovePosition, TaskRecord, TaskSort } from "@/lib/task-types";
import { taskColumnName } from "./TaskColumnSettings";
import styles from "./TaskDashboard.module.css";

/** Outside the board projection: filtering, moving and archiving cannot remove an open review. */
export function TaskInspector({ hidden = false, task, board, visibleTasks, sort, disabled, panelRef, onClose, onMove, onArchive, feedback, children }: {
  task: TaskRecord; board: TaskBoard; visibleTasks: TaskRecord[]; sort: TaskSort; disabled: boolean;
  hidden?: boolean; panelRef?: RefObject<HTMLDivElement | null>; onClose: () => void;
  onMove: (task: TaskRecord, columnId: TaskColumnId, position?: TaskMovePosition) => void;
  onArchive: () => void; feedback: ReactNode; children: ReactNode;
}) {
  const { t } = useI18n();
  const neighbors = visibleTasks.filter(item => item.columnId === task.columnId);
  const index = neighbors.findIndex(item => item.id === task.id);
  return <div hidden={hidden} ref={panelRef} tabIndex={-1} className={styles.inspector} data-task-inspector={task.id}
    onKeyDown={event => {
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
      <p className={styles.project}>{task.project?.projectRoot ?? t("tasks.noProject")}</p>
    </div>
    {feedback}
    <label className={styles.move}>{t("tasks.moveTo")}
      <select value={task.columnId} aria-label={`${t("tasks.moveTo")}: ${task.title}`} disabled={disabled} onChange={event => onMove(task, event.target.value as TaskColumnId)}>
        {board.columns.map(target => <option key={target.id} value={target.id}>{taskColumnName(target, t)}</option>)}
      </select>
    </label>
    {sort !== "manual" && <p className={styles.hint}>{t("tasks.view.autoHelp")}</p>}
    <div className={styles.actions}>
      {task.archived && <span>{t("tasks.archive.archived")}</span>}
      <button type="button" disabled={disabled} aria-label={`${t(task.archived ? "tasks.archive.restore" : "tasks.archive.archive")}: ${task.title}`} onClick={onArchive}>{t(task.archived ? "tasks.archive.restore" : "tasks.archive.archive")}</button>
      <button type="button" disabled={disabled || sort !== "manual" || index <= 0} aria-label={`${t("tasks.moveUp")}: ${task.title}`} onClick={() => onMove(task, task.columnId, { before: neighbors[index - 1].id })}>{t("tasks.moveUp")}</button>
      <button type="button" disabled={disabled || sort !== "manual" || index < 0 || index === neighbors.length - 1} aria-label={`${t("tasks.moveDown")}: ${task.title}`} onClick={() => onMove(task, task.columnId, { after: neighbors[index + 1].id })}>{t("tasks.moveDown")}</button>
    </div>
  </div>;
}
