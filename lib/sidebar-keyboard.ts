import type { SidebarProjectRow } from "./sidebar-project-rows";

export function sidebarRowKey(row: SidebarProjectRow): string {
  return row.kind === "session" ? `session:${row.family.root.id}` : `${row.kind}:${row.project.key}`;
}

export type SidebarKeyboardAction =
  | { kind: "focus"; index: number }
  | { kind: "expand"; expanded: boolean }
  | { kind: "activate" }
  | { kind: "none" };

/** Navigation follows the flattened visible rows, not the mounted virtual window. */
export function sidebarKeyboardAction(rows: readonly SidebarProjectRow[], index: number, key: string): SidebarKeyboardAction {
  if (!rows.length) return { kind: "none" };
  if (key === "Home") return { kind: "focus", index: 0 };
  if (key === "End") return { kind: "focus", index: rows.length - 1 };
  if (key === "ArrowDown") return { kind: "focus", index: Math.min(index + 1, rows.length - 1) };
  if (key === "ArrowUp") return { kind: "focus", index: Math.max(index - 1, 0) };
  const row = rows[index];
  if (!row) return { kind: "none" };
  if (key === "Enter") return { kind: "activate" };
  if (key === "ArrowRight") {
    if (row.kind === "project") {
      if (row.collapsed) return { kind: "expand", expanded: true };
      if (rows[index + 1] && rows[index + 1].kind !== "project") return { kind: "focus", index: index + 1 };
    }
    if (row.kind === "more" && !row.expanded) return { kind: "expand", expanded: true };
  }
  if (key === "ArrowLeft") {
    if (row.kind === "project" && !row.collapsed) return { kind: "expand", expanded: false };
    if (row.kind === "more" && row.expanded) return { kind: "expand", expanded: false };
    if (row.kind !== "project") {
      for (let parent = index - 1; parent >= 0; parent--) {
        if (rows[parent].kind === "project") return { kind: "focus", index: parent };
      }
    }
  }
  return { kind: "none" };
}
