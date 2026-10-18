"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { listenForStackedDialogEscape } from "@/lib/stacked-dialog";
import styles from "./TaskSelection.module.css";

export interface TaskPickerItem { id: string; title: string; archived: boolean; status: string; statusKey?: string }

/** Metadata-only picker, shared by the composer command and membership button. */
export function TaskPicker({ tasks, selectedId, onSelect, onClose, loading = false, loadError, onReload, hint }: {
  tasks: TaskPickerItem[]; selectedId: string | null;
  onSelect: (task: TaskPickerItem | null) => Promise<void>; onClose: () => void;
  loading?: boolean; loadError?: string | null; onReload?: () => void; hint?: string;
}) {
  const { t } = useI18n();
  const id = useId();
  const search = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLElement>(null);
  const saving = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [archiveChoice, setShowArchived] = useState<boolean | null>(null);
  const showArchived = archiveChoice ?? tasks.some(task => task.id === selectedId && task.archived);
  const [index, setIndex] = useState<number | null>(null);
  const visible = tasks.filter(task => showArchived || !task.archived);
  const choices: (TaskPickerItem | null)[] = loading || loadError ? [] : query.trim()
    ? visible.filter(task => task.title.toLowerCase().includes(query.trim().toLowerCase()))
    : [null, ...visible];
  const active = Math.min(index ?? Math.max(0, choices.findIndex(task => (task?.id ?? null) === selectedId)), Math.max(0, choices.length - 1));
  useEffect(() => { search.current?.focus(); }, []);
  useLayoutEffect(() => { if (busy) panel.current?.focus({preventScroll: true}); }, [busy]);
  useEffect(() => {
    const containFocus = (event: FocusEvent) => {
      const element = panel.current;
      if (!element || !(event.target instanceof Element) || element.contains(event.target)) return;
      // A higher extension dialog may legitimately take focus from this picker.
      if (event.target.closest('[role="dialog"][aria-modal="true"]')) return;
      element.focus({preventScroll: true});
    };
    document.addEventListener("focusin", containFocus, true);
    return () => document.removeEventListener("focusin", containFocus, true);
  }, []);
  useEffect(() => listenForStackedDialogEscape(document, () => { if (!saving.current) onClose(); }), [onClose]);
  useEffect(() => { document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: "nearest" }); }, [id, active]);
  async function select(task: TaskPickerItem | null) {
    if (saving.current || loading || loadError) return;
    saving.current = true; setBusy(true); setError(null);
    try { await onSelect(task); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { saving.current = false; setBusy(false); requestAnimationFrame(() => search.current?.focus()); }
  }
  return <div className={styles.backdrop} onMouseDown={event => {
    if (event.target === event.currentTarget && !saving.current) onClose();
  }}>
    <section ref={panel} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t("tasks.picker.title")} aria-busy={busy || loading} className={styles.picker}
      onKeyDown={event => {
        if (event.key !== "Tab") return;
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled):not([tabindex="-1"])')];
        const first = controls[0], last = controls.at(-1);
        if (!first) { event.preventDefault(); return; }
        if (document.activeElement === event.currentTarget) { event.preventDefault(); (event.shiftKey ? last : first)?.focus(); }
        else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
      <header className={styles.header}>
        <div className={styles.heading}>
          <h2>{t("tasks.picker.title")}</h2>
          <button type="button" className={styles.iconButton} aria-label={t("sidebar.cancel")} title={t("sidebar.cancel")} disabled={busy} onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6" /></svg>
          </button>
        </div>
        <input ref={search} role="combobox" aria-label={t("tasks.picker.search")} placeholder={t("tasks.picker.search")} aria-expanded="true" aria-controls={id} aria-autocomplete="list"
          aria-activedescendant={choices.length ? `${id}-${active}` : undefined} disabled={busy} value={query} autoComplete="off" spellCheck={false}
          className={styles.search} onChange={event => { setQuery(event.target.value); setIndex(0); }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (choices.length) setIndex((active + (event.key === "ArrowDown" ? 1 : -1) + choices.length) % choices.length);
            } else if (event.key === "Enter") {
              event.preventDefault(); if (choices.length) void select(choices[active]);
            }
          }} />
      </header>
      <div id={id} role="listbox" aria-label={t("tasks.picker.title")} className={styles.list}>
        {choices.map((task, i) => <button key={task?.id ?? "none"} id={`${id}-${i}`} type="button" role="option"
          aria-selected={(task?.id ?? null) === selectedId} tabIndex={-1} disabled={busy} data-active={i === active}
          className={styles.option} onMouseDown={event => event.preventDefault()} onClick={() => void select(task)}>
          <span className={styles.optionTitle}>{task?.title ?? t("tasks.picker.none")}</span>
          {task && <span className={styles.status}>{task.statusKey ? t(`tasks.column.${task.statusKey}`) : task.status}{task.archived ? ` · ${t("tasks.archive.archived")}` : ""}</span>}
          <span className={styles.check} aria-hidden="true">{(task?.id ?? null) === selectedId && <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m5 12 4 4L19 6" /></svg>}</span>
        </button>)}
        {!loading && !loadError && !choices.length && <p role="status" className={styles.message}>{t("tasks.picker.empty")}</p>}
        {loading && <p role="status" className={styles.message}>{t("tasks.loading")}</p>}
      </div>
      {(error || loadError) && <div role="alert" className={styles.error}>
        <div>{error || loadError}</div>
        {onReload && <button type="button" className={styles.retry} disabled={busy || loading} onClick={() => {setError(null); onReload();}}>{t("tasks.picker.reload")}</button>}
      </div>}
      <footer className={styles.footer}>
        <label className={styles.archiveToggle}><input type="checkbox" checked={showArchived} disabled={busy} onChange={event => { setShowArchived(event.target.checked); setIndex(0); }} /> {t("tasks.picker.archived")}</label>
        <span className={styles.keyboardHint}>{t(busy ? "tasks.saving" : "tasks.picker.keys")}</span>
      </footer>
      {hint && <p className={styles.note}>{hint}</p>}
    </section>
  </div>;
}
