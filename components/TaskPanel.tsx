"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { TaskPanelNavigation } from "./task-panel-navigation";
import { focusIfLost, focusModalPanel, listenForPanelEscape } from "@/lib/stacked-dialog";
import { useI18n } from "@/hooks/useI18n";
import { TaskDashboard } from "./TaskDashboard";
import styles from "./TaskDashboard.module.css";

/** Kept mounted after first opening: dismissing the panel never discards task drafts. */
export function TaskPanel({ open, onClose, sessionId, onNavigate, requestedTask }: { open: boolean; onClose: () => void; sessionId: string | null; onNavigate: (href: string) => Promise<void>; requestedTask?: { id: string; request: number } | null }) {
  const { t } = useI18n();
  const panel = useRef<HTMLDivElement>(null);
  const containActive = useRef(false);
  useLayoutEffect(() => {
    if (!open) return;
    containActive.current = true;
    const restore = focusModalPanel(document, panel.current, { restoreTextEntry: !window.matchMedia("(pointer: coarse)").matches });
    return () => {
      // Layout cleanup restores the opener before passive listeners detach.
      // Do not let containment pull that legitimate return focus back inside.
      containActive.current = false;
      restore();
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    return listenForPanelEscape(document, onClose);
  }, [open, onClose]);
  useEffect(() => {
    const element = panel.current;
    if (!open || !element) return;
    // Child-local transitions (Cancel, preview/back, disabled controls) need
    // recovery even when TaskDashboard itself did not render.
    const recover = () => { if (containActive.current && element.getClientRects().length) focusIfLost(document, element); };
    const observer = new MutationObserver(recover);
    observer.observe(element, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "hidden"] });
    const containFocus = (event: FocusEvent) => {
      if (!containActive.current || !element.getClientRects().length || !(event.target instanceof Element) || element.contains(event.target)) return;
      // DirectoryPicker and other higher dialogs portal to document.body.
      if (event.target.closest('[role="dialog"][aria-modal="true"]')) return;
      element.focus({ preventScroll: true });
    };
    document.addEventListener("focusin", containFocus, true);
    return () => { observer.disconnect(); document.removeEventListener("focusin", containFocus, true); };
  }, [open]);
  return <div hidden={!open} className={styles.backdrop} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={panel} role={open ? "dialog" : undefined} aria-modal={open ? true : undefined} aria-label={t("tasks.dashboard")} tabIndex={-1} className={styles.panel}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        // On phones the inspector covers the board completely; its keyboard
        // order must not include visually covered cards or header controls.
        const portalDialog = (event.target as HTMLElement).closest<HTMLElement>('[role="dialog"]');
        const scope = portalDialog && portalDialog !== event.currentTarget ? portalDialog
          : event.currentTarget.querySelector<HTMLElement>('[data-task-inspector]:not([hidden])') ?? event.currentTarget;
        const controls = [...scope.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, summary, [tabindex="0"]')]
          .filter((element) => !element.matches(":disabled") && element.getClientRects().length > 0);
        const first = controls[0], last = controls.at(-1);
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && (document.activeElement === first || !scope.contains(document.activeElement) || document.activeElement === scope)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !scope.contains(document.activeElement) || document.activeElement === scope)) { event.preventDefault(); first.focus(); }
      }}>
      <TaskPanelNavigation.Provider value={onNavigate}>
        <TaskDashboard active={open} onClose={onClose} currentSessionId={sessionId} requestedTask={requestedTask} />
      </TaskPanelNavigation.Provider>
    </div>
  </div>;
}
