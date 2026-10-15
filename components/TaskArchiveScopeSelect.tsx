"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import styles from "./TaskDashboard.module.css";

type ArchiveScope = "active" | "archived" | "all";

/** A themed listbox: native select popups use OS colors rather than our palette. */
export function TaskArchiveScopeSelect({ value, archivedCount, disabled, active, onChange }: {
  value: ArchiveScope;
  archivedCount: number;
  disabled: boolean;
  active: boolean;
  onChange: (scope: ArchiveScope) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const options: { value: ArchiveScope; label: string }[] = [
    { value: "active", label: t("tasks.archive.active") },
    { value: "archived", label: `${t("tasks.archive.archived")} (${archivedCount})` },
    { value: "all", label: t("tasks.archive.all") },
  ];
  const selected = options.findIndex(option => option.value === value);
  const visible = open && active && !disabled;

  useEffect(() => {
    if (!active || disabled) setOpen(false);
  }, [active, disabled]);
  useEffect(() => {
    if (!visible) return;
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

  function choose(index: number) {
    onChange(options[index].value);
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  }

  return <div ref={container} className={styles.archiveScope}>
    <button ref={trigger} type="button" role="combobox" className={styles.archiveScopeTrigger}
      aria-label={t("tasks.archive.list")} aria-haspopup="listbox" aria-expanded={visible}
      aria-controls={visible ? id : undefined} aria-activedescendant={visible ? `${id}-${highlighted}` : undefined}
      disabled={disabled} onClick={() => { setHighlighted(selected); setOpen(!open); }} onKeyDown={event => {
        // Escape must never dismiss the enclosing task panel (or stop the agent).
        if (visible && event.key === "Escape") event.stopPropagation();
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Escape" && visible) {
          event.preventDefault();
          setOpen(false);
        } else if (event.key === "Tab") {
          setOpen(false);
        } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          setOpen(true);
          setHighlighted(event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 :
            !visible ? selected : (highlighted + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
        } else if (visible && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          choose(highlighted);
        } else if (visible && event.key.length === 1) {
          const index = options.findIndex(option => option.label.toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase()));
          if (index >= 0) { event.preventDefault(); setHighlighted(index); }
        }
      }}>
      <span>{options[selected].label}</span>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
    </button>
    {visible && <div id={id} role="listbox" aria-label={t("tasks.archive.list")} className={styles.archiveScopeList}>
      {options.map((option, index) => <button key={option.value} id={`${id}-${index}`} type="button" role="option"
        tabIndex={-1} aria-selected={option.value === value} data-highlighted={index === highlighted || undefined}
        onPointerMove={() => setHighlighted(index)} onMouseDown={event => event.preventDefault()} onClick={() => choose(index)}>
        <span>{option.label}</span><span aria-hidden="true">{option.value === value ? "✓" : ""}</span>
      </button>)}
    </div>}
  </div>;
}
