"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { focusIfLost, focusModalPanel, listenForStackedDialogEscape } from "@/lib/stacked-dialog";
import { taskMatchesText } from "@/lib/task-view";
import { CHAT_WORKSPACE_KEY } from "@/lib/session-kind";
import { getSessionPanelShortcut, type SessionPanel } from "@/lib/panel-focus-shortcuts";
import type { TaskCatalogEntry } from "@/lib/task-catalog-types";
import type { SessionArchiveScope } from "@/lib/session-archive-view";
import styles from "./SidebarSearchControls.module.css";

type Filters = { query: string; taskId: string | null; archive: SessionArchiveScope };
const activeCount = (filters: Filters) => Number(Boolean(filters.query.trim())) + Number(Boolean(filters.taskId)) + Number(filters.archive !== "active");
function summaryParts(filters: Filters, tasks: readonly TaskCatalogEntry[] | null, t: (key: string) => string): string[] {
  return [filters.taskId ? `${t("sidebar.conditionTask")}: ${filters.taskId === "unlinked" ? t("sidebar.unlinkedTask") : tasks?.find(task => task.id === filters.taskId)?.title ?? filters.taskId}` : "",
    filters.archive === "archived" ? t("sidebar.archiveScopeArchived") : "", filters.query.trim() ? `“${filters.query.trim()}”` : ""].filter(Boolean);
}

export function SidebarFilterSummary({ filters, tasks, onReset }: { filters: Filters; tasks: readonly TaskCatalogEntry[] | null; onReset: () => void }) {
  const { t } = useI18n();
  const parts = summaryParts(filters, tasks, t);
  if (!parts.length) return null;
  return <div className={styles.summary} data-sidebar-filter-summary>
    <span className={styles.summaryText} title={parts.join(" · ")}>{parts.slice(0, 2).join(" · ")}</span>
    {parts.length > 2 && <span style={{flexShrink:0}}>+{parts.length - 2}</span>}
    <button type="button" aria-label={t("sidebar.clearSearchFilters")} title={t("sidebar.clearSearchFilters")} onClick={onReset}>×</button>
  </div>;
}

/** One UI entry owns condition editing. Choosing task metadata never changes
 * chat membership; close and page navigation never reset applied conditions. */
export function SidebarSearchControls({ open, onOpenChange, filters, onQuery, onTask, onArchive, onReset, tasks, projectKey, archivedCount, loading, failed, onReload, onDetails, onFocusPanel }: {
  open: boolean; onOpenChange: (open: boolean) => void; filters: Filters;
  onQuery: (query: string) => void; onTask: (id: string | null) => void; onArchive: (scope: SessionArchiveScope) => void; onReset: () => void;
  tasks: readonly TaskCatalogEntry[] | null; projectKey: string | null; archivedCount: number;
  loading: boolean; failed: boolean; onReload: () => void; onDetails: (id: string) => void;
  onFocusPanel?: (panel: SessionPanel) => void;
}) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), bodyInput = useRef<HTMLInputElement>(null), taskInput = useRef<HTMLInputElement>(null);
  const [page, setPage] = useState<"home" | "task" | "archive" | "add">("home");
  const [taskQuery, setTaskQuery] = useState("");
  const [position, setPosition] = useState<CSSProperties>({ left: 12, top: 60 });
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const previousMobile = useRef(isMobile), dismissedForBreakpoint = useRef(false);
  useEffect(() => {
    // AppShell hides the drawer on a breakpoint change. Do not leave a portal
    // behind, or return focus to its now off-screen sidebar trigger.
    if (previousMobile.current !== isMobile && open) {dismissedForBreakpoint.current = true; close();}
    previousMobile.current = isMobile;
  }, [isMobile, open, close]);
  const selected = tasks?.find(task => task.id === filters.taskId);
  const choices = useMemo(() => (tasks ?? []).filter(task => (!projectKey || (task.project?.projectKey ?? CHAT_WORKSPACE_KEY) === projectKey) && taskMatchesText(task, taskQuery)), [tasks, projectKey, taskQuery]);
  const count = activeCount(filters);
  const conditions = [{ id: "task" as const, label: t("sidebar.conditionTask"), value: filters.taskId === "unlinked" ? t("sidebar.unlinkedTask") : selected?.title ?? filters.taskId ?? t("sidebar.allTasks") },
    { id: "archive" as const, label: t("sidebar.conditionArchive"), value: t(filters.archive === "archived" ? "sidebar.archiveScopeArchived" : "sidebar.activeSessions") }];
  const go = (next: typeof page) => { setTaskQuery(""); setPage(next); };
  useLayoutEffect(() => {
    if (!open) return;
    dismissedForBreakpoint.current = false;
    const positionPanel = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - 372)), top: Math.max(12, rect.bottom + 8), maxHeight: `${Math.max(120, window.innerHeight - rect.bottom - 20)}px` });
    };
    positionPanel();
    window.addEventListener("resize", positionPanel);
    const openedPanel = panel.current, openedTrigger = trigger.current;
    const restore = focusModalPanel(document, openedPanel, { restoreTextEntry: false });
    return () => {
      window.removeEventListener("resize", positionPanel);
      const rect = openedTrigger?.getBoundingClientRect();
      const triggerVisible = !dismissedForBreakpoint.current && openedTrigger?.isConnected && rect && rect.right > 0 && rect.left < window.innerWidth && rect.bottom > 0 && rect.top < window.innerHeight
        && !openedTrigger.closest(".sidebar-closed, [inert]");
      if (triggerVisible) restore();
      else if (document.activeElement === document.body || openedPanel?.contains(document.activeElement)) {
        document.querySelector<HTMLButtonElement>('button[aria-controls="session-sidebar"]')?.focus({preventScroll:true});
      }
    };
  }, [open]);
  useEffect(() => {
    if (!open) { setPage("home"); setTaskQuery(""); return; }
    // Capture only this panel's keys. A higher dialog has its own capture
    // listener and must never also dismiss the lower search panel.
    const stopEscape = panel.current ? listenForStackedDialogEscape(panel.current, close) : () => {};
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target) && !trigger.current?.contains(event.target)) close();
    };
    document.addEventListener("pointerdown", outside);
    const observer = new MutationObserver(() => focusIfLost(document, panel.current));
    if (panel.current) observer.observe(panel.current, {childList:true, subtree:true});
    return () => { stopEscape(); observer.disconnect(); document.removeEventListener("pointerdown", outside); };
  }, [open, close]);
  useEffect(() => {
    if (!open) return;
    if (page === "task") taskInput.current?.focus();
    else if (page === "home" && !isMobile) bodyInput.current?.focus();
    else panel.current?.focus({ preventScroll: true });
  }, [open, page, isMobile]);
  useEffect(() => {
    if (!open) return;
    const manageFocus = (event: FocusEvent) => {
      if (!(event.target instanceof Element) || panel.current?.contains(event.target)) return;
      // Yield to Settings/other higher dialogs rather than intercept their
      // Escape. Desktop also dismisses when an explicit shortcut leaves it.
      if (event.target.closest('[aria-modal="true"], dialog[open]')) {close(); return;}
      if (isMobile) panel.current?.focus({preventScroll:true});
      else if (!trigger.current?.contains(event.target)) close();
    };
    document.addEventListener("focusin", manageFocus, true);
    return () => document.removeEventListener("focusin", manageFocus, true);
  }, [open, isMobile, close]);
  const chooseTask = (taskId: string | null) => { onTask(taskId); go("home"); };
  const navigateChoices = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="option"]:not(:disabled)')];
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    if (!options.length || index < 0) return;
    event.preventDefault(); event.stopPropagation();
    const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : Math.max(0, Math.min(options.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
    options[next].focus();
  };
  const choice = (label: string, selected: boolean, onClick: () => void, attributes?: Record<string, string>, path?: string, archived = false) => {
    const key = attributes?.["data-task-option"] ?? attributes?.["data-archive-option"] ?? label;
    const detailId = path || archived ? `${id}-${key}-description` : undefined;
    return <button key={key} type="button" role="option" aria-label={label} aria-describedby={detailId} aria-selected={selected} className={styles.choice} onClick={onClick} {...attributes}>
      <span className={styles.choiceText}><span className={styles.choiceTitle}>{label}</span>{detailId && <span id={detailId} className={styles.choiceDetail}>
        {path && <span className={styles.choicePath} title={path}>{path}</span>}
        {archived && <span className={styles.archivedMarker} data-task-archived>{t("sidebar.taskArchived")}</span>}
      </span>}</span><span aria-hidden="true">{selected ? "✓" : ""}</span>
    </button>;
  };
  return <>
    <button ref={trigger} type="button" aria-label={t("sidebar.searchFilters")} title={t("sidebar.searchFilters")} aria-expanded={open} aria-controls={id}
      className={styles.trigger} data-active={open || count > 0} onClick={() => onOpenChange(!open)}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5M17 4h5M19.5 1.5v5"/></svg>
      {count > 0 && <span className={styles.badge} aria-label={t("sidebar.activeFilterCount", {count})}>{count}</span>}
    </button>
    {open && createPortal(<div className={styles.layer}>
      <div id={id} ref={panel} role="dialog" aria-modal={isMobile ? true : undefined} aria-label={t("sidebar.searchFilters")} tabIndex={-1} className={styles.panel} style={isMobile ? undefined : position}
        onKeyDown={event => {
          // Only this owned mobile sheet bridges panel shortcuts; retain the
          // global modal guard for Settings and every other dialog.
          const destination = getSessionPanelShortcut(event.nativeEvent);
          if (isMobile && destination && onFocusPanel && !event.defaultPrevented && event.keyCode !== 229) {
            event.preventDefault(); event.stopPropagation(); close(); onFocusPanel(destination); return;
          }
          if (event.key !== "Tab" || event.nativeEvent.isComposing || event.keyCode === 229) return;
          const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')].filter(element => element.getClientRects().length);
          const first = controls[0], last = controls.at(-1);
          const activeIsControl = controls.includes(document.activeElement as HTMLElement);
          if (event.shiftKey && (document.activeElement === first || !activeIsControl)) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && (document.activeElement === last || !activeIsControl)) { event.preventDefault(); first?.focus(); }
        }}>
        <header className={styles.header}>
          {page !== "home" && <button type="button" className={styles.iconButton} aria-label={t("sidebar.filtersBack")} onClick={() => go("home")}>‹</button>}
          <h2 className={styles.heading}>{t(page === "home" ? "sidebar.searchFilters" : page === "task" ? "sidebar.conditionTask" : page === "archive" ? "sidebar.conditionArchive" : "sidebar.addCondition")}</h2>
          <button type="button" className={styles.iconButton} aria-label={t("sidebar.closeFilters")} onClick={close}>×</button>
        </header>
        <div className={styles.body}>
          {page === "home" && <>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>{t("sidebar.contentSearch")}</span>
              <input ref={bodyInput} type="search" aria-label={t("sidebar.contentSearch")} placeholder={t("sidebar.contentSearchPlaceholder")} className={styles.input} maxLength={200} value={filters.query} onChange={event => onQuery(event.target.value)} />
            </label>
            <p className={styles.hint}>{filters.taskId ? t("sidebar.searchScopeTask", {task:conditions[0].value}) : t("sidebar.searchScopeGlobal")}</p>
            {filters.query && <button type="button" className={styles.add} onClick={() => onQuery("")}>{t("sidebar.clearContentSearch")}</button>}
            <h3 className={styles.sectionTitle}>{t("sidebar.filterConditions")}</h3>
            {conditions.map(condition => <div key={condition.id} className={styles.condition}>
              <button type="button" className={styles.conditionButton} aria-label={condition.label} aria-describedby={`${id}-${condition.id}-value`} onClick={() => go(condition.id)}>
                <span className={styles.conditionLabel}>{condition.label}</span><span id={`${id}-${condition.id}-value`} className={styles.conditionValue}>{condition.value}</span><span aria-hidden="true">›</span>
              </button>
              {(condition.id === "task" ? filters.taskId : filters.archive === "archived") && <button type="button" className={styles.iconButton}
                aria-label={t(condition.id === "task" ? "sidebar.clearTaskFilter" : "sidebar.resetArchiveFilter")} onClick={() => condition.id === "task" ? onTask(null) : onArchive("active")}>×</button>}
            </div>)}
            <button type="button" className={styles.add} aria-label={t("sidebar.addCondition")} onClick={() => go("add")}>＋ {t("sidebar.addCondition")}</button>
            {selected && <button type="button" className={styles.add} style={{float:"right"}} onClick={() => {close(); onDetails(selected.id);}}>{t("sidebar.taskDetails")} ↗</button>}
          </>}
          {page === "task" && <>
            <input ref={taskInput} type="search" aria-label={t("sidebar.taskSearch")} placeholder={t("sidebar.taskSearch")} className={styles.input} maxLength={200} value={taskQuery} onChange={event => setTaskQuery(event.target.value)}
              onKeyDown={event => {if (event.key === "ArrowDown" && !event.altKey && !event.ctrlKey && !event.metaKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                event.preventDefault(); panel.current?.querySelector<HTMLButtonElement>('button[role="option"]')?.focus();
              }}} />
            <div role="listbox" aria-label={t("sidebar.taskFilter")} className={styles.choices} onKeyDown={navigateChoices}>
              {choice(t("sidebar.allTasks"), filters.taskId === null, () => chooseTask(null), {"data-task-option":"all"})}
              {tasks !== null && choice(t("sidebar.unlinkedTask"), filters.taskId === "unlinked", () => chooseTask("unlinked"), {"data-task-option":"unlinked"})}
              {choices.map(task => choice(task.title, filters.taskId === task.id, () => chooseTask(task.id), {"data-task-option":task.id}, !projectKey ? task.project?.projectRoot ?? t("tasks.noProject") : undefined, task.archived))}
            </div>
            {loading && tasks === null && <p role="status" className={styles.notice}>{t("sidebar.tasksLoading")}</p>}
            {tasks !== null && taskQuery.trim() && !choices.length && <p role="status" className={styles.notice}>{t("sidebar.noTaskMatches")}</p>}
          </>}
          {page === "archive" && <div role="listbox" aria-label={t("sidebar.conditionArchive")} className={styles.choices} onKeyDown={navigateChoices}>
            {(["active", "archived"] as const).map(scope => choice(t(scope === "active" ? "sidebar.activeSessions" : "sidebar.archivedSessions", {count:archivedCount}), filters.archive === scope,
              () => {onArchive(scope); go("home");}, {"data-archive-option":scope}))}
          </div>}
          {page === "add" && <div className={styles.choices}>{conditions.map(condition => <button key={condition.id} type="button" className={styles.choice} onClick={() => go(condition.id)}>{condition.label}<span style={{marginLeft:"auto"}} aria-hidden="true">›</span></button>)}</div>}
          {failed && <p role="alert" className={`${styles.notice} ${styles.error}`}>{t("sidebar.tasksUnavailable")} <button type="button" className={styles.add} onClick={onReload}>{t("sidebar.tasksReload")}</button></p>}
        </div>
        <footer className={styles.footer}><button type="button" disabled={count === 0} onClick={() => {onReset(); go("home"); panel.current?.focus({preventScroll:true});}}>{t("sidebar.clearSearchFilters")}</button><span className={styles.hint}>{t("sidebar.filtersLive")}</span></footer>
      </div>
    </div>, document.body)}
  </>;
}
