"use client";

import type { ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { sidebarRowKey } from "@/lib/sidebar-keyboard";
import type { SidebarProjectRow } from "@/lib/sidebar-project-rows";

type TaskRow = Extract<SidebarProjectRow, {kind: "task" | "task-more"}>;
export function SidebarTaskGroup({ row, index, nested, tabIndex, onToggle, onDetails, activity }: {
  row: TaskRow; index: number; nested: boolean; tabIndex: number; onToggle: () => void; onDetails: (id: string) => void; activity?: ReactNode;
}) {
  const { t } = useI18n();
  const label = row.kind === "task" ? row.task?.title ?? t("sidebar.unlinkedTask")
    : row.expanded ? t("sidebar.showFewerSessions") : t("sidebar.showMoreSessions", { count: row.remaining });
  const left = (nested ? 12 : 0) + (row.kind === "task-more" ? 12 : 0);
  return <div style={{ position: "absolute", top: index * 54, left, right: 0, height: 54, display: "flex", alignItems: "stretch", borderBottom: "1px solid var(--border)" }}>
    <button type="button" data-sidebar-row={sidebarRowKey(row)} tabIndex={tabIndex} aria-label={label}
      aria-expanded={row.kind === "task" ? !row.collapsed : row.expanded} onClick={onToggle}
      style={row.kind === "task-more" ? { paddingLeft: 16, paddingRight: 16 } : undefined}
      className="min-w-0 flex-1 cursor-pointer px-3 text-left text-xs text-text hover:bg-bg-hover focus:outline-2 focus:outline-accent focus:-outline-offset-2">
      <span className="flex min-w-0 items-center gap-2">
        {row.kind === "task" && <span aria-hidden="true">{row.collapsed ? "▸" : "▾"}</span>}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {row.kind === "task" && <span className="shrink-0 text-[10px] text-text-dim" title={t("sidebar.taskCount", {count:row.count})}>{row.count}</span>}
        {activity}
      </span>
      {row.kind === "task" && row.count === 0 && !row.collapsed
        ? <span className="block truncate pl-4 text-[10px] text-text-dim">{t("sidebar.emptyTask")}</span>
        : row.kind === "task" && row.task?.archived && <span className="block truncate pl-4 text-[10px] text-text-dim">{t("sidebar.taskArchived")}</span>}
    </button>
    {row.kind === "task" && row.task && <button type="button" aria-label={t("sidebar.taskDetails")} title={t("sidebar.taskDetails")}
      className="shrink-0 cursor-pointer px-2 text-xs text-text-muted hover:bg-bg-hover" onClick={() => onDetails(row.task!.id)}>↗</button>}
  </div>;
}
