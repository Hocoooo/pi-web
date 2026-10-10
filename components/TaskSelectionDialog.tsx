"use client";

import { TaskPicker } from "./TaskPicker";
import { useI18n } from "@/hooks/useI18n";
import type { useTaskSelection } from "@/hooks/useTaskSelection";
import styles from "./TaskSelection.module.css";

/** Both mouse and /task entrances use the same loading/error and save path. */
export function TaskSelectionDialog({ selection, onClose }: {
  selection: ReturnType<typeof useTaskSelection>; onClose: () => void;
}) {
  const { t } = useI18n();
  return <>
    {selection.bindingError && !selection.isOpen && <div role="alert" className={styles.bindingError}>
      <span>{t("tasks.picker.bindFailed")} {selection.bindingError}</span>
      <button type="button" onClick={() => { void selection.open(); }}>{t("tasks.picker.title")}</button>
    </div>}
    {selection.isOpen && <TaskPicker tasks={selection.snapshot?.tasks ?? []} selectedId={selection.selectedId}
    loading={!selection.snapshot && !selection.loadError} loadError={selection.loadError}
    hint={selection.snapshot?.relation === null ? t("tasks.picker.draftHint") : undefined}
    onReload={() => { void selection.open(); }} onClose={onClose}
    onSelect={async task => { await selection.choose(task); onClose(); }} />}
  </>;
}
