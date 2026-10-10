"use client";

import { useDraggable, useDroppable } from "@dnd-kit/core";
import type { ReactNode } from "react";
import type { TaskColumnId, TaskRecord } from "@/lib/task-types";
import styles from "./TaskDashboard.module.css";

export function TaskDropColumn({ id, label, children }: { id: TaskColumnId; label: string; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: `column:${id}`, data: { columnId: id } });
  return <section ref={setNodeRef} data-task-column={id} data-drop-over={isOver || undefined} className={styles.column} aria-labelledby={`column-${id}`}>
    <h2 id={`column-${id}`}>{label}</h2>{children}
  </section>;
}

export function TaskDragCard({ task, disabled, handleLabel, children }: { task: TaskRecord; disabled: boolean; handleLabel: string; children: ReactNode }) {
  const drag = useDraggable({ id: task.id, disabled });
  const drop = useDroppable({ id: `task:${task.id}`, data: { columnId: task.columnId, taskId: task.id } });
  return <article ref={(node) => { drag.setNodeRef(node); drop.setNodeRef(node); }} data-task-card={task.id}
    data-dragging={drag.isDragging || undefined} data-drop-over={drop.isOver || undefined} className={styles.card}>
    <button ref={drag.setActivatorNodeRef} type="button" className={styles.dragHandle} {...drag.attributes} {...drag.listeners}
      disabled={disabled} aria-label={handleLabel}>⠿</button>
    {children}
  </article>;
}
