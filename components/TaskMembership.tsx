"use client";

import { useI18n } from "@/hooks/useI18n";
import styles from "./TaskSelection.module.css";

/** The same quiet, single-line task control for provisional and saved chats. */
export function TaskMembership({ label, onChoose, onDetails }: {
  label: string; onChoose: () => void; onDetails?: () => void;
}) {
  const { t } = useI18n();
  return <div className={styles.membership} data-session-task>
    <button type="button" className={styles.trigger} onClick={onChoose} aria-label={label} title={label} aria-haspopup="dialog">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="3" /><path d="m8 12 3 3 5-6" /></svg>
      <span className={styles.triggerLabel}>{label}</span>
      <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="m3 4.5 3 3 3-3" /></svg>
    </button>
    {onDetails && <button type="button" className={styles.iconButton} onClick={onDetails} aria-label={t("tasks.picker.details")} title={t("tasks.picker.details")}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M14 4v16M6 8h5M6 12h5" /></svg>
    </button>}
  </div>;
}
