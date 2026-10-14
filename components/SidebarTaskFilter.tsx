"use client";

import { useMemo, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { taskMatchesText } from "@/lib/task-view";
import { CHAT_WORKSPACE_KEY } from "@/lib/session-kind";
import type { TaskCatalogEntry } from "@/lib/task-catalog-types";

/** Choosing here filters navigation only; it is never the task membership picker. */
export function SidebarTaskFilter({ tasks, projectKey, selectedId, onSelect, loading, failed, onReload, onDetails }: {
  tasks: readonly TaskCatalogEntry[] | null; projectKey: string | null; selectedId: string | null;
  onSelect: (id: string | null) => void; loading: boolean; failed: boolean; onReload: () => void;
  onDetails: (id: string) => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const choices = useMemo(() => (tasks ?? []).filter(task => (!projectKey || (task.project?.projectKey ?? CHAT_WORKSPACE_KEY) === projectKey)
    && taskMatchesText(task, query)), [tasks, projectKey, query]);
  const selected = tasks?.find(task => task.id === selectedId);
  const selectedMissing = selectedId && selectedId !== "unlinked" && !choices.some(task => task.id === selectedId);
  return <div className="shrink-0 space-y-2 px-3 pt-2" aria-busy={loading}>
    <input type="search" aria-label={t("sidebar.taskSearch")} placeholder={t("sidebar.taskSearch")} maxLength={200}
      value={query} onChange={event => setQuery(event.target.value)}
      className="h-[30px] w-full min-w-0 rounded-[7px] border border-border bg-bg-panel px-2 text-xs text-text focus:outline-2 focus:outline-accent" />
    <div className="flex min-w-0 gap-1">
      <select aria-label={t("sidebar.taskFilter")} value={selectedId ?? ""} disabled={tasks === null}
        onChange={event => onSelect(event.target.value || null)}
        className="h-[30px] min-w-0 flex-1 rounded-[7px] border border-border bg-bg-panel px-2 text-xs text-text focus:outline-2 focus:outline-accent">
        <option value="">{t("sidebar.allTasks")}</option>
        <option value="unlinked">{t("sidebar.unlinkedTask")}</option>
        {selectedMissing && <option value={selectedId}>{selected?.title ?? selectedId}</option>}
        {choices.map(task => <option key={task.id} value={task.id}>{task.title}{!projectKey && task.project ? ` · ${task.project.projectRoot}` : ""}{task.archived ? ` · ${t("sidebar.taskArchived")}` : ""}</option>)}
      </select>
      {selectedId && <button type="button" aria-label={t("sidebar.clearTaskFilter")} title={t("sidebar.clearTaskFilter")}
        className="shrink-0 cursor-pointer rounded px-2 text-text-muted hover:bg-bg-hover" onClick={() => onSelect(null)}>×</button>}
      {selected && <button type="button" aria-label={t("sidebar.taskDetails")} title={t("sidebar.taskDetails")}
        className="shrink-0 cursor-pointer rounded px-2 text-text-muted hover:bg-bg-hover" onClick={() => onDetails(selected.id)}>↗</button>}
    </div>
    {query.trim() && !choices.length && tasks !== null && <p role="status" className="text-xs text-text-muted">{t("sidebar.noTaskMatches")}</p>}
    {loading && tasks === null && <p role="status" className="text-xs text-text-muted">{t("sidebar.tasksLoading")}</p>}
    {failed && <p role="alert" className="text-xs text-red-400">{t("sidebar.tasksUnavailable")} <button type="button" className="cursor-pointer underline" onClick={onReload}>{t("sidebar.tasksReload")}</button></p>}
  </div>;
}
