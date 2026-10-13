import { join, relative, isAbsolute } from "node:path";
import { listSessionMetadata } from "./session-list-scanner";
import { readSessionRelationMetadata } from "./session-reader";
import { resolveProjectAuthoritatively } from "./worktree";
import { projectIdentityKey } from "./project-identity";
import { isChatWorkspace } from "./chat-workspace";
import { isTaskSessionId, type TaskProject, type TaskSessionInfo } from "./task-types";

export interface TaskSessionMetadata extends TaskSessionInfo {
  project: TaskProject | null;
  /** Candidate eligibility only; existing child links must remain visible/manageable. */
  isMainSession: boolean;
}

/** Native path containment, shared by metadata and the start-time busy gate.
 * Explicit path semantics let tests exercise win32 without pretending to run Windows. */
export function taskSessionPathInScope(agentDir: string, sessionPath: string, paths = { join, relative, isAbsolute }): boolean {
  const path = paths.relative(paths.join(agentDir, "sessions"), sessionPath);
  return !!sessionPath && !path.startsWith("..") && !paths.isAbsolute(path);
}

/** One server catalogue per operation, never one full-history read per card. */
export async function taskSessionCatalogue(agentDir: string): Promise<TaskSessionMetadata[]> {
  const disk = await listSessionMetadata(agentDir);
  const sessions = new Map(disk.map((session) => {
    let isMainSession = true;
    try {
      const metadata = readSessionRelationMetadata(session);
      isMainSession = metadata.relation?.kind !== "subagent" && !metadata.relationUnavailable;
    } catch { isMainSession = false; }
    return [session.id, {
      id: session.id, cwd: session.cwd, name: session.name, running: false, isMainSession,
    } as TaskSessionInfo & { cwd: string; isMainSession: boolean }];
  }));
  const { getRpcSessionMetadata } = await import("./rpc-manager");
  for (const session of getRpcSessionMetadata()) {
    // Do not mix another agent-dir's registry into isolated callers/data stores.
    if (!taskSessionPathInScope(agentDir, session.path)) continue;
    const { path: sessionPath, isSubagent, ...metadata } = session;
    void sessionPath;
    const persisted = sessions.get(session.id);
    sessions.set(session.id, { ...persisted, ...metadata,
      isMainSession: persisted?.isMainSession !== false && !isSubagent });
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

export function publicTaskSession({ project, isMainSession, ...session }: TaskSessionMetadata): TaskSessionInfo {
  void isMainSession;
  // The hidden chat workspace is identity, not a user-facing project path.
  if (project === null) delete session.cwd;
  return session;
}
