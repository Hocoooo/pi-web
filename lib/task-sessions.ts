import { join, relative, isAbsolute } from "node:path";
import { listSessionMetadata } from "./session-list-scanner";
import { resolveProjectAuthoritatively } from "./worktree";
import { projectIdentityKey } from "./project-identity";
import { isChatWorkspace } from "./chat-workspace";
import { isTaskSessionId, type TaskProject, type TaskSessionInfo } from "./task-types";

export interface TaskSessionMetadata extends TaskSessionInfo { project: TaskProject | null }

/** Native path containment, shared by metadata and the start-time busy gate.
 * Explicit path semantics let tests exercise win32 without pretending to run Windows. */
export function taskSessionPathInScope(agentDir: string, sessionPath: string, paths = { join, relative, isAbsolute }): boolean {
  const path = paths.relative(paths.join(agentDir, "sessions"), sessionPath);
  return !!sessionPath && !path.startsWith("..") && !paths.isAbsolute(path);
}

/** One server catalogue per operation, never one full-history read per card. */
export async function taskSessionCatalogue(agentDir: string): Promise<TaskSessionMetadata[]> {
  const disk = await listSessionMetadata(agentDir);
  const sessions = new Map(disk.map((session) => [session.id, {
    id: session.id, cwd: session.cwd, name: session.name, running: false,
  } as TaskSessionInfo & { cwd: string }]));
  const { getRpcSessionMetadata } = await import("./rpc-manager");
  for (const session of getRpcSessionMetadata()) {
    // Do not mix another agent-dir's registry into isolated callers/data stores.
    if (!taskSessionPathInScope(agentDir, session.path)) continue;
    const { path: sessionPath, ...metadata } = session;
    void sessionPath;
    sessions.set(session.id, { ...sessions.get(session.id), ...metadata });
  }
  const projects = new Map<string, TaskProject | null>();
  await Promise.all([...new Set([...sessions.values()].map((session) => session.cwd))].map(async (cwd) => {
    if (isChatWorkspace(cwd, agentDir)) projects.set(cwd, null);
    else {
      const { projectRoot } = await resolveProjectAuthoritatively(cwd);
      projects.set(cwd, { cwd, projectRoot, projectKey: projectIdentityKey(projectRoot) });
    }
  }));
  return [...sessions.values()].filter((session) => isTaskSessionId(session.id) && !!session.cwd)
    .map((session) => ({ ...session, project: projects.get(session.cwd) ?? null }));
}

export function sameTaskSessionProject(project: TaskProject | null, session: TaskSessionMetadata): boolean {
  return project === null ? session.project === null : session.project?.projectKey === project.projectKey;
}

export function publicTaskSession({ project, ...session }: TaskSessionMetadata): TaskSessionInfo {
  void project;
  // The hidden chat workspace is identity, not a user-facing project path.
  if (project === null) delete session.cwd;
  return session;
}
