"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { TaskRelationRequest, TaskSessionInfo } from "@/lib/task-types";
import styles from "./TaskDashboard.module.css";

/** Removal changes membership only. An ambiguous failure keeps the exact CAS request for retry. */
export function TaskSessionMenu({ session, taskId, active, disabled, newOperationId, onRemove }: {
  session: TaskSessionInfo; taskId: string; active: boolean; disabled: boolean;
  newOperationId: () => string; onRemove: (request: TaskRelationRequest) => Promise<void>;
}) {
  const { t } = useI18n();
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const item = useRef<HTMLButtonElement>(null);
  const request = useRef<TaskRelationRequest | null>(null);
  const saving = useRef(false);
  const unavailable = disabled || pending;
  const visible = open && active && !unavailable;

  useEffect(() => {
    if (!active || unavailable) setOpen(false);
  }, [active, unavailable]);
  useEffect(() => {
    if (!visible) return;
    item.current?.focus({ preventScroll: true });
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && container.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("focusin", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("focusin", dismiss);
    };
  }, [visible]);

  async function remove() {
    if (unavailable || saving.current) return;
    saving.current = true;
    setPending(true);
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
    request.current ??= { action: "change-session-relation", sessionId: session.id, sourceTaskId: taskId,
      targetTaskId: null, expectedGeneration: session.relationGeneration ?? 0,
      expectedUpdateRevision: session.updateRevision ?? 0, operationId: newOperationId() };
    try { await onRemove(request.current); }
    catch { /* The list presents the error; retain this exact request for retry. */ }
    finally { saving.current = false; setPending(false); }
  }

  return <div ref={container} className={styles.sessionMenuContainer} onKeyDown={event => {
    if (!visible) return;
    if (event.key === "Escape") {
      event.stopPropagation();
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus({ preventScroll: true });
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      item.current?.focus({ preventScroll: true });
    } else if (event.key === "Tab") {
      // Removing the focused item before native tabbing otherwise drops focus to body.
      setOpen(false);
      trigger.current?.focus({ preventScroll: true });
    }
  }}>
    <button ref={trigger} type="button" className={styles.smallIconButton} aria-label={t("tasks.sessionActions")}
      title={t("tasks.sessionActions")} aria-haspopup="menu" aria-expanded={visible} aria-controls={visible ? menuId : undefined}
      disabled={unavailable} onClick={() => setOpen(!open)} onKeyDown={event => {
        if (!unavailable && ["ArrowDown", "ArrowUp"].includes(event.key)) { event.preventDefault(); setOpen(true); }
      }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>
    </button>
    {visible && <div id={menuId} role="menu" aria-label={t("tasks.sessionActions")} className={styles.sessionMenu}>
      <button ref={item} type="button" role="menuitem" title={t("tasks.removeSessionHint")} onClick={() => void remove()}>{t("tasks.removeSession")}</button>
    </div>}
  </div>;
}
