"use client";

import { useRef, useState, type FormEvent } from "react";
import { useI18n } from "@/hooks/useI18n";
import { TASK_COLUMN_LIMITS, type TaskBoard, type TaskColumn, type TaskColumnConfig, type TaskRequest } from "@/lib/task-types";
import { ConfigButton, ConfigDetailHeader, ConfigDetailStack, ConfigDetailTitle, ConfigFooter, ConfigFooterStatus, ConfigScopeTag } from "./SettingsUi";
import styles from "./TaskDashboard.module.css";

/** Default names are localized; saved user names are literal and never define completion. */
export function taskColumnName(column: TaskColumnConfig, t: (key: string) => string): string {
  return column.label ?? t(`tasks.column.${column.id}`);
}

export function TaskColumnSettings({ board, disabled, newId, onSave, onCancel }: {
  board: TaskBoard;
  disabled: boolean;
  newId: () => string;
  onSave: (request: Extract<TaskRequest, { action: "set-columns" | "remove-column" }>) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  // This editor is mounted once per open. Reloads update cards, not this draft's base revision.
  const [baseRevision] = useState(board.columnsRevision);
  const [columns, setColumns] = useState<TaskColumn[]>(() => board.columns.map((column) => ({ ...column })));
  const [error, setError] = useState<string | null>(null);
  const [initialColumns] = useState(() => JSON.stringify(board.columns));
  const [removal, setRemoval] = useState<{ board: TaskBoard; column: TaskColumn } | null>(null);
  const [target, setTarget] = useState("");
  const [confirmCompletion, setConfirmCompletion] = useState(false);
  const removalAttempt = useRef<{ payload: string; operationId: string } | null>(null);
  const dirty = JSON.stringify(columns) !== initialColumns || baseRevision !== board.columnsRevision;
  const affected = removal?.board.tasks.filter(task => task.columnId === removal.column.id) ?? [];
  function cancelRemoval() { setRemoval(null); setError(null); removalAttempt.current = null; }
  async function remove() {
    if (disabled || !removal || !target || target === "done" && !confirmCompletion) return;
    const expectedSourceDigest = removal.board.columnRemovalDigests?.[removal.column.id];
    if (typeof expectedSourceDigest !== "string" || expectedSourceDigest.length !== 64 || !/^[0-9a-f]{64}$/.test(expectedSourceDigest)) { setError(t("tasks.removeScopeUnavailable")); return; }
    const input = { action: "remove-column" as const, columnId: removal.column.id, targetColumnId: target,
      expectedColumnsRevision: removal.board.columnsRevision, expectedOrderRevision: removal.board.orderRevision,
      expectedSourceDigest, confirmCompletion };
    const payload = JSON.stringify(input);
    if (removalAttempt.current?.payload !== payload) removalAttempt.current = { payload, operationId: newId() };
    setError(null);
    try { await onSave({ ...input, operationId: removalAttempt.current.operationId }); }
    catch (cause) { setError((cause as Error).message); }
  }
  function reorder(index: number, offset: number) {
    setColumns((current) => {
      const next = [...current];
      [next[index], next[index + offset]] = [next[index + offset], next[index]];
      return next;
    });
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (disabled) return;
    if (removal) { await remove(); return; }
    setError(null);
    try { await onSave({ action: "set-columns", expectedColumnsRevision: baseRevision, columns: columns.map(({ id, label }) => ({ id, label })) }); }
    catch (cause) { setError((cause as Error).message); }
  }
  return <form className={styles.form} aria-label={t("tasks.columnsSettings")} onSubmit={save}>
    <ConfigDetailStack>
      <ConfigDetailHeader>
        <ConfigDetailTitle>{t("tasks.columnsSettings")}</ConfigDetailTitle>
        <ConfigScopeTag scope="global">{t("tasks.columnsGlobal")}</ConfigScopeTag>
      </ConfigDetailHeader>
      {removal ? <>
        <h3 className={styles.removalScope}>{t("tasks.removeColumn")}: {taskColumnName(removal.column, t)}</h3>
        <p>{t("tasks.removeScope")} {affected.length} — {t("tasks.archive.archived")}: {affected.filter(task => task.archived).length}</p>
        <ul className={styles.removalScope} aria-label={t("tasks.affectedTasks")}>
          {affected.map(task => <li key={task.id}>{task.title} — {task.project?.projectRoot ?? t("tasks.noProject")} {task.archived ? `(${t("tasks.archive.archived")})` : ""}</li>)}
        </ul>
        <label>{t("tasks.receivingColumn")}<select aria-label={t("tasks.receivingColumn")} required value={target} disabled={disabled} onChange={event => { setTarget(event.target.value); setConfirmCompletion(false); }}>
          <option value="">{t("tasks.chooseReceivingColumn")}</option>
          {removal.board.columns.filter(column => column.id !== removal.column.id).map(column => <option key={column.id} value={column.id}>{taskColumnName(column, t)}</option>)}
        </select></label>
        {target === "done" && <>
          <p role="alert">{t("tasks.removeCompletes")}</p>
          <label className={styles.sessionChoice}><input type="checkbox" checked={confirmCompletion} disabled={disabled} onChange={event => setConfirmCompletion(event.target.checked)} />{t("tasks.confirmCompletion")}</label>
        </>}
        {error && <div role="alert" className={styles.error}>{error}</div>}
        <ConfigFooter status={<ConfigFooterStatus summary={disabled ? t("tasks.saving") : t("tasks.removeScope")} />}>
          <ConfigButton type="submit" variant="primary" disabled={disabled || !target || target === "done" && !confirmCompletion}>{t(error ? "tasks.retryRemoval" : "tasks.confirmRemoval")}</ConfigButton>
          <ConfigButton disabled={disabled} onClick={cancelRemoval}>{t("sidebar.cancel")}</ConfigButton>
        </ConfigFooter>
      </> : <>
      <p className={styles.hint}>{t("tasks.columnsHelp")}</p>
      <p className={styles.hint}>{t("tasks.removeHelp")}</p>
      {dirty && <p className={styles.hint}>{t("tasks.removeDraftHelp")}</p>}
      <div className={styles.columnSettings}>
        {columns.map((column, index) => <div key={column.id} data-column-setting={column.id} className={styles.columnSetting}>
          <label>{t("tasks.columnName")} {index + 1}
            <input required maxLength={TASK_COLUMN_LIMITS.label} value={taskColumnName(column, t)} disabled={disabled}
              onChange={(event) => setColumns((current) => current.map((item) => item.id === column.id ? { ...item, label: event.target.value } : item))} />
          </label>
          <span className={styles.hint}>{column.isCompletion ? t("tasks.columnCompletion") : t("tasks.columnUnfinished")}</span>
          <div className={styles.actions}>
            <ConfigButton disabled={disabled || index === 0} aria-label={`${t("tasks.columnUp")}: ${taskColumnName(column, t)}`} onClick={() => reorder(index, -1)}>{t("tasks.columnUp")}</ConfigButton>
            <ConfigButton disabled={disabled || index === columns.length - 1} aria-label={`${t("tasks.columnDown")}: ${taskColumnName(column, t)}`} onClick={() => reorder(index, 1)}>{t("tasks.columnDown")}</ConfigButton>
            <ConfigButton disabled={disabled || dirty || column.isCompletion || columns.filter(item => !item.isCompletion).length <= 1}
              aria-label={`${t("tasks.removeColumn")}: ${taskColumnName(column, t)}`} onClick={() => { setRemoval({ board, column }); setTarget(""); setConfirmCompletion(false); setError(null); }}>{t("tasks.removeColumn")}</ConfigButton>
          </div>
        </div>)}
      </div>
      <ConfigButton disabled={disabled || columns.length >= TASK_COLUMN_LIMITS.count}
        onClick={() => setColumns((current) => [...current, { id: newId(), label: "", isCompletion: false }])}>{t("tasks.addColumn")}</ConfigButton>
      {columns.length >= TASK_COLUMN_LIMITS.count && <p className={styles.hint}>{t("tasks.columnsLimit")}</p>}
      {error && <div role="alert" className={styles.error}>{error}</div>}
      <ConfigFooter status={<ConfigFooterStatus summary={disabled ? t("tasks.saving") : t("tasks.columnsDraft")} />}>
        <ConfigButton type="submit" variant="primary" disabled={disabled}>{t("tasks.saveColumns")}</ConfigButton>
        <ConfigButton disabled={disabled} onClick={onCancel}>{t("sidebar.cancel")}</ConfigButton>
      </ConfigFooter>
      </>}
    </ConfigDetailStack>
  </form>;
}
