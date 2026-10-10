"use client";

import { useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { emptyTaskFilter } from "@/lib/task-view";
import { TASK_PRIORITIES, type TaskBoard, type TaskFilter, type TaskRequest, type TaskSort } from "@/lib/task-types";
import { taskColumnName } from "./TaskColumnSettings";
import styles from "./TaskDashboard.module.css";

type Save = Extract<TaskRequest, { action: "save-view" }>;
export function TaskViewControls({ board, filter, sort, disabled, onChange, onSave, newId }: {
  board: TaskBoard; filter: TaskFilter; sort: TaskSort; disabled: boolean;
  onChange: (filter: TaskFilter, sort: TaskSort) => void; onSave: (request: Save) => Promise<void>; newId: () => string;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<{ base: number; filter: TaskFilter; sort: TaskSort; id: string; operationId: string; name: string } | null>(null);
  const [error, setError] = useState("");
  const [selectedViewId, setSelectedViewId] = useState("");
  const locked = disabled || !!draft;
  const projects = new Map(board.tasks.flatMap((task) => task.project ? [[task.project.projectKey, task.project.projectRoot] as const] : []));
  // Retain unavailable selections visibly; never replace them with all projects/labels/columns.
  if (filter.project?.key && !projects.has(filter.project.key)) projects.set(filter.project.key, `${t("tasks.view.unavailable")}: ${filter.project.key}`);
  const labels = [...new Set([...board.tasks.flatMap((task) => task.labels), ...filter.labels])].sort();
  const columns = [...board.columns, ...filter.columnIds.filter((id) => !board.columns.some((column) => column.id === id)).map((id) => ({ id, label: `${t("tasks.view.unavailable")}: ${id}`, isCompletion: false }))];
  const apply = (nextFilter: TaskFilter, nextSort: TaskSort, viewId = "") => {
    setSelectedViewId(viewId); onChange(nextFilter, nextSort);
  };
  const change = (patch: Partial<TaskFilter>) => apply({ ...filter, ...patch }, sort);
  const toggle = <T,>(values: T[], value: T) => values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value];
  const chips: Array<{ key: string; label: string; remove: () => void }> = [];
  if (filter.text) chips.push({ key: "text", label: `${t("tasks.view.text")}: ${filter.text}`, remove: () => change({ text: "" }) });
  if (filter.project) chips.push({ key: "project", label: `${t("tasks.view.project")}: ${filter.project.key === null ? t("tasks.noProject") : projects.get(filter.project.key)}`, remove: () => change({ project: null }) });
  for (const id of filter.columnIds) chips.push({ key: `column:${id}`, label: `${t("tasks.view.status")}: ${taskColumnName(columns.find(column => column.id === id)!, t)}`, remove: () => change({ columnIds: toggle(filter.columnIds, id) }) });
  for (const priority of filter.priorities) chips.push({ key: `priority:${priority}`, label: `${t("tasks.priority")}: ${t(`tasks.priority.${priority}`)}`, remove: () => change({ priorities: toggle(filter.priorities, priority) }) });
  for (const label of filter.labels) chips.push({ key: `label:${label}`, label: `${t("tasks.view.labels")}: ${label}`, remove: () => change({ labels: toggle(filter.labels, label) }) });
  if (filter.activity !== "all") chips.push({ key: "activity", label: t(`tasks.view.${filter.activity}`), remove: () => change({ activity: "all" }) });
  if (sort !== "manual") chips.push({ key: "sort", label: `${t("tasks.view.sort")}: ${t(`tasks.view.sort.${sort}`)}`, remove: () => apply(filter, "manual") });
  const advancedCount = filter.columnIds.length + filter.priorities.length + filter.labels.length + Number(filter.activity !== "all");
  const selectedView = board.savedViews.find(view => view.id === selectedViewId);
  return <section className={`${styles.form} ${styles.viewControls}`} aria-label={t("tasks.view.controls")}>
    <div className={styles.filterBasics}>
      <label>{t("tasks.view.text")}<input type="search" maxLength={200} value={filter.text} disabled={locked} onChange={(event) => change({ text: event.target.value })} /></label>
      <label>{t("tasks.view.project")}<select aria-label={t("tasks.view.project")} disabled={locked} value={JSON.stringify(filter.project)} onChange={(event) => change({ project: JSON.parse(event.target.value) })}>
        <option value="null">{t("tasks.view.allProjects")}</option><option value={'{"key":null}'}>{t("tasks.noProject")}</option>
        {[...projects].map(([key, root]) => <option key={key} value={JSON.stringify({ key })}>{root}</option>)}
      </select></label>
      <label>{t("tasks.view.sort")}<select aria-label={t("tasks.view.sort")} value={sort} disabled={locked} onChange={(event) => apply(filter, event.target.value as TaskSort)}>
        {["manual", "priority", "updated"].map((value) => <option key={value} value={value}>{t(`tasks.view.sort.${value}`)}</option>)}
      </select></label>
    </div>
    <details className={styles.moreFilters}>
      <summary>{t("tasks.view.more")}{advancedCount > 0 && <span> · {advancedCount}</span>}</summary>
      <div className={styles.filterAdvanced}>
        <fieldset disabled={locked}><legend>{t("tasks.view.status")}</legend>{columns.map((column) =>
          <label className={styles.sessionChoice} key={column.id}><input type="checkbox" checked={filter.columnIds.includes(column.id)} onChange={() => change({ columnIds: toggle(filter.columnIds, column.id) })} /><span>{taskColumnName(column, t)}</span></label>)}</fieldset>
        <fieldset disabled={locked}><legend>{t("tasks.priority")}</legend>{TASK_PRIORITIES.map((priority) => <label className={styles.sessionChoice} key={priority}><input type="checkbox" checked={filter.priorities.includes(priority)} onChange={() => change({ priorities: toggle(filter.priorities, priority) })} /><span>{t(`tasks.priority.${priority}`)}</span></label>)}</fieldset>
        <label>{t("tasks.view.activity")}<select aria-label={t("tasks.view.activity")} value={filter.activity} disabled={locked} onChange={(event) => change({ activity: event.target.value as TaskFilter["activity"] })}>
          {["all", "working", "idle"].map((activity) => <option key={activity} value={activity}>{t(`tasks.view.${activity}`)}</option>)}
        </select></label>
        <fieldset disabled={locked} className={styles.filterLabels}><legend>{t("tasks.view.labels")}</legend>{labels.length ? labels.map((label) => <label className={styles.sessionChoice} key={label}><input type="checkbox" checked={filter.labels.includes(label)} onChange={() => change({ labels: toggle(filter.labels, label) })} /><span>{label}</span></label>) : <span className={styles.hint}>{t("tasks.view.noLabels")}</span>}</fieldset>
      </div>
    </details>
    {chips.length > 0 && <div className={styles.filterChips} aria-label={t("tasks.view.active")}>
      {chips.map(chip => <button key={chip.key} type="button" disabled={locked} title={chip.label} aria-label={t("tasks.view.remove", { filter: chip.label })} onClick={chip.remove}><span>{chip.label}</span><span aria-hidden="true">×</span></button>)}
      <button disabled={locked} type="button" className={styles.clearFilters} onClick={() => apply(emptyTaskFilter(), "manual")}>{t("tasks.view.clear")}</button>
    </div>}
    <div className={styles.filterFooter}>
      {board.savedViews.length > 0 && <label>{t("tasks.view.saved")}<select aria-label={t("tasks.view.saved")} disabled={locked} value={selectedView?.id ?? ""} onChange={(event) => {
        const view = board.savedViews.find((view) => view.id === event.target.value);
        if (view) apply(view.filter, view.sort, view.id);
      }}><option value="">{t("tasks.view.open")}</option>{board.savedViews.map((view) => <option key={view.id} value={view.id}>{view.name}</option>)}</select></label>}
      <button disabled={locked} type="button" onClick={() => { setError(""); setDraft({ base: board.viewsRevision, filter, sort, id: newId(), operationId: newId(), name: "" }); }}>{t("tasks.view.save")}</button>
    </div>
    {draft && <form aria-label={t("tasks.view.save")} onSubmit={async (event) => {
      event.preventDefault(); if (disabled) return; setError("");
      try { await onSave({ action: "save-view", id: draft.id, operationId: draft.operationId, expectedViewsRevision: draft.base, name: draft.name, filter: draft.filter, sort: draft.sort }); setSelectedViewId(draft.id); setDraft(null); }
      catch (cause) { setError((cause as Error).message); }
    }}>
      <p className={styles.hint}>{t("tasks.view.saveHint")}</p>
      <label>{t("tasks.view.name")}<input autoFocus required maxLength={100} value={draft.name} disabled={disabled} onChange={(event) => setDraft({ ...draft, name: event.target.value, operationId: newId() })} /></label>
      {error && <p role="alert" className={styles.error}>{error}</p>}
      <div className={styles.actions}><button type="submit" disabled={disabled}>{t("tasks.view.confirm")}</button><button type="button" disabled={disabled} onClick={() => { setDraft(null); setError(""); }}>{t("sidebar.cancel")}</button></div>
    </form>}
  </section>;
}
