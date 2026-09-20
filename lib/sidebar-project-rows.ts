import { getRecentProjects, type RecentProject } from "./project-groups";
import { listSessionFamilies, type SessionFamily } from "./session-family";
import type { SessionInfo } from "./types";
import { workspaceKeyOf } from "./workspace-memory";

export const PROJECT_SESSION_PREVIEW_LIMIT = 5;

export type SidebarProjectRow =
  | { kind: "project"; project: RecentProject; collapsed: boolean }
  | { kind: "session"; family: SessionFamily }
  | { kind: "more"; project: RecentProject; expanded: boolean; remaining: number };

/** Flat, fixed-height rows share one virtualized scroll surface. */
export function buildSidebarProjectRows(
  sessions: readonly SessionInfo[],
  collapsedProjects: readonly string[],
  activeProject: RecentProject | null,
  expandedProjects: readonly string[] = [],
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
  const expanded = new Set(expandedProjects);
  return projects.flatMap((project): SidebarProjectRow[] => {
    const isCollapsed = collapsed.has(project.key);
    const rows: SidebarProjectRow[] = [{ kind: "project", project, collapsed: isCollapsed }];
    if (!isCollapsed) {
      const families = listSessionFamilies(sessionsByProject.get(project.key) ?? []);
      const isExpanded = expanded.has(project.key);
      const visibleFamilies = isExpanded ? families : families.slice(0, PROJECT_SESSION_PREVIEW_LIMIT);
      rows.push(...visibleFamilies.map((family): SidebarProjectRow => ({ kind: "session", family })));
      if (families.length > PROJECT_SESSION_PREVIEW_LIMIT) {
        rows.push({
          kind: "more", project, expanded: isExpanded,
          remaining: families.length - PROJECT_SESSION_PREVIEW_LIMIT,
        });
      }
    }
    return rows;
  });
}
