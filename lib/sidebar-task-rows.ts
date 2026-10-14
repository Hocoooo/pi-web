import { CHAT_WORKSPACE_KEY } from "./session-kind";
import { getRecentProjects, type RecentProject } from "./project-groups";
import { listSessionFamilies, type SessionFamily } from "./session-family";
import type { TaskCatalogEntry } from "./task-catalog-types";
import { taskOwnersForSessions } from "./task-membership";
import { PROJECT_SESSION_PREVIEW_LIMIT, type SidebarProjectRow } from "./sidebar-project-rows";
import type { SessionInfo } from "./types";
import { workspaceKeyOf } from "./workspace-memory";

type FamilyRow = Extract<SidebarProjectRow, { kind: "session" }>;
export function sidebarTaskKey(projectKey: string, taskId: string | null): string {
  return JSON.stringify([projectKey, taskId]);
}

/** Keep the resolved ancestry intact, even when a different task owns a middle
 * ancestor. Only matching members supply flags and the activity timestamp. */
function projectTaskFamily(family: SessionFamily, owners: ReadonlyMap<string, string>, taskId: string | null): FamilyRow | null {
  const matching = [family.root, ...family.subagents].filter(member => (owners.get(member.id) ?? null) === taskId);
  if (!matching.length) return null;
  const latestModified = matching.reduce((latest, member) => member.modified > latest ? member.modified : latest, "");
  return { kind: "session", family: { ...family, latestModified }, memberIds: matching.map(member => member.id),
    contextualRoot: (owners.get(family.root.id) ?? null) !== taskId };
}

function projectSessions(sessions: readonly SessionInfo[]): Map<string, SessionInfo[]> {
  const groups = new Map<string, SessionInfo[]>();
  for (const session of sessions) {
    const key = workspaceKeyOf(session), group = groups.get(key) ?? [];
    group.push(session);
    groups.set(key, group);
  }
  return groups;
}

export function taskFilteredFamilyRows(sessions: readonly SessionInfo[], tasks: readonly TaskCatalogEntry[], taskFilter: string): FamilyRow[] {
  const owners = taskOwnersForSessions(tasks, sessions);
  return [...projectSessions(sessions).values()].flatMap(group => listSessionFamilies(group)
    .flatMap(family => projectTaskFamily(family, owners, taskFilter === "unlinked" ? null : taskFilter) ?? []))
    .sort((a, b) => b.family.latestModified.localeCompare(a.family.latestModified));
}

type ProjectOptions = { allProjects: boolean; activeProject: RecentProject | null; archived: boolean; collapsedProjects: readonly string[] };

/** Tree-off filtering projects full families first, rather than deleting middle
 * ancestors and asking listSessionFamilies to reconstruct an incomplete graph. */
export function buildSidebarFilteredRows(sessions: readonly SessionInfo[], tasks: readonly TaskCatalogEntry[], taskFilter: string,
  options: ProjectOptions & { expandedProjects: readonly string[] }): SidebarProjectRow[] {
  const families = taskFilteredFamilyRows(sessions, tasks, taskFilter).filter(row => Boolean(row.family.root.archived) === options.archived);
  if (!options.allProjects) return families.filter(row => !options.activeProject || workspaceKeyOf(row.family.root) === options.activeProject.key);
  const projects = getRecentProjects(families.map(row => ({ ...row.family.root, modified: row.family.latestModified })));
  if (options.activeProject && !projects.some(project => project.key === options.activeProject!.key)) projects.unshift(options.activeProject);
  return projects.flatMap((project): SidebarProjectRow[] => {
    const collapsed = options.collapsedProjects.includes(project.key);
    const rows: SidebarProjectRow[] = [{ kind: "project", project, collapsed }];
    if (collapsed) return rows;
    const group = families.filter(row => workspaceKeyOf(row.family.root) === project.key);
    const expanded = options.expandedProjects.includes(project.key);
    rows.push(...(expanded ? group : group.slice(0, PROJECT_SESSION_PREVIEW_LIMIT)));
    if (group.length > PROJECT_SESSION_PREVIEW_LIMIT) rows.push({kind:"more", project, expanded, remaining:group.length - PROJECT_SESSION_PREVIEW_LIMIT});
    return rows;
  });
}

/** Explicit owner maps always precede archive/Task/project filters. Historical
 * cross-task families can provide a labeled contextual root in several groups. */
export function buildSidebarTaskRows(sessions: readonly SessionInfo[], tasks: readonly TaskCatalogEntry[], options: ProjectOptions & {
  expandedTasks: ReadonlySet<string>; expandedPreviews: ReadonlySet<string>; taskFilter: string | null;
}): SidebarProjectRow[] {
  const owners = taskOwnersForSessions(tasks, sessions);
  const taskById = new Map(tasks.map(task => [task.id, task]));
  const sessionsByProject = projectSessions(sessions);
  const projects = getRecentProjects(sessions.filter(session => Boolean(session.archived) === options.archived));
  const selectedTask = options.taskFilter ? taskById.get(options.taskFilter) : undefined;
  if (selectedTask) {
    const key = selectedTask.project?.projectKey ?? CHAT_WORKSPACE_KEY;
    if (!projects.some(project => project.key === key)) projects.push({key, root:selectedTask.project?.projectRoot ?? ""});
  }
  if (options.activeProject && !projects.some(project => project.key === options.activeProject!.key)) projects.unshift(options.activeProject);
  const rows: SidebarProjectRow[] = [];
  for (const project of projects) {
    if (!options.allProjects && options.activeProject && project.key !== options.activeProject.key) continue;
    const families = listSessionFamilies(sessionsByProject.get(project.key) ?? []).filter(family => Boolean(family.root.archived) === options.archived);
    const groups = new Map<string | null, FamilyRow[]>();
    for (const family of families) {
      for (const taskId of new Set([family.root, ...family.subagents].map(member => owners.get(member.id) ?? null))) {
        if (options.taskFilter && taskId !== (options.taskFilter === "unlinked" ? null : options.taskFilter)) continue;
        const group = groups.get(taskId) ?? [];
        group.push(projectTaskFamily(family, owners, taskId)!);
        groups.set(taskId, group);
      }
    }
    // Empty tasks remain searchable without inflating the daily navigation tree.
    if (selectedTask && (selectedTask.project?.projectKey ?? CHAT_WORKSPACE_KEY) === project.key && !groups.has(selectedTask.id)) groups.set(selectedTask.id, []);
    if (options.taskFilter && !groups.size) continue;
    const collapsed = options.collapsedProjects.includes(project.key);
    if (options.allProjects) rows.push({kind:"project", project, collapsed});
    if (options.allProjects && collapsed) continue;
    for (const group of groups.values()) group.sort((a, b) => b.family.latestModified.localeCompare(a.family.latestModified));
    const sorted = [...groups].sort(([a, af], [b, bf]) => {
      if (a === null) return 1;
      if (b === null) return -1;
      return (bf[0]?.family.latestModified ?? taskById.get(b)?.updatedAt ?? "").localeCompare(af[0]?.family.latestModified ?? taskById.get(a)?.updatedAt ?? "") || a.localeCompare(b);
    });
    for (const [taskId, group] of sorted) {
      const taskKey = sidebarTaskKey(project.key, taskId), isCollapsed = !options.expandedTasks.has(taskKey);
      rows.push({kind:"task", project, task:taskId ? taskById.get(taskId)! : null, taskKey, collapsed:isCollapsed, count:group.length});
      if (isCollapsed) continue;
      const expanded = options.expandedPreviews.has(taskKey);
      rows.push(...(expanded ? group : group.slice(0, PROJECT_SESSION_PREVIEW_LIMIT)).map(row => ({...row, taskKey})));
      if (group.length > PROJECT_SESSION_PREVIEW_LIMIT) rows.push({kind:"task-more", project, taskKey, expanded, remaining:group.length - PROJECT_SESSION_PREVIEW_LIMIT});
    }
  }
  return rows;
}
