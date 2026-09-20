import { getRecentProjects, type RecentProject } from "./project-groups";
import { listSessionFamilies, type SessionFamily } from "./session-family";
import type { SessionInfo } from "./types";
import { workspaceKeyOf } from "./workspace-memory";

export type SidebarProjectRow =
  | { kind: "project"; project: RecentProject; collapsed: boolean }
  | { kind: "session"; family: SessionFamily };

/** Flat, fixed-height rows share one virtualized scroll surface. */
export function buildSidebarProjectRows(
  sessions: readonly SessionInfo[],
  collapsedProjects: readonly string[],
  activeProject: RecentProject | null,
): SidebarProjectRow[] {
  const projects = getRecentProjects(sessions);
  // Keep a newly opened, empty workspace visible until its first session exists.
  if (activeProject && !projects.some((project) => project.key === activeProject.key)) {
    projects.unshift(activeProject);
  }
  const sessionsByProject = new Map<string, SessionInfo[]>();
  for (const session of sessions) {
    const key = workspaceKeyOf(session);
    const group = sessionsByProject.get(key) ?? [];
    group.push(session);
    sessionsByProject.set(key, group);
  }
  const collapsed = new Set(collapsedProjects);
  return projects.flatMap((project): SidebarProjectRow[] => {
    const isCollapsed = collapsed.has(project.key);
    const rows: SidebarProjectRow[] = [{ kind: "project", project, collapsed: isCollapsed }];
    if (!isCollapsed) {
      rows.push(...listSessionFamilies(sessionsByProject.get(project.key) ?? [])
        .map((family): SidebarProjectRow => ({ kind: "session", family })));
    }
    return rows;
  });
}
