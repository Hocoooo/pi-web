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

export function TaskDragCard({ task, disabled, expanded, onOpen, children }: {
  task: TaskRecord; disabled: boolean; expanded: boolean; onOpen: () => void; children: ReactNode;
}) {
  const drag = useDraggable({ id: task.id, disabled });
  const drop = useDroppable({ id: `task:${task.id}`, data: { columnId: task.columnId, taskId: task.id } });
  return <article ref={(node) => { drag.setNodeRef(node); drag.setActivatorNodeRef(node); drop.setNodeRef(node); }} data-task-card={task.id}
    data-dragging={drag.isDragging || undefined} data-drop-over={drop.isOver || undefined} className={styles.card}
    {...drag.attributes} {...drag.listeners} role="button" aria-label={task.title} aria-expanded={expanded}
    aria-disabled={undefined}
    // The pointer sensors suppress the release click once a drag activates.
    onClick={() => { if (!drag.isDragging) onOpen(); }}
    onKeyDown={event => {
      if (event.target !== event.currentTarget || event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault(); event.stopPropagation();
        if (!event.repeat && !drag.isDragging) onOpen();
      }
    }}>
    {children}
  </article>;
}
