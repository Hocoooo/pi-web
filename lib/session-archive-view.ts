import type { SessionInfo } from "./types";

export type SessionArchiveScope = "active" | "archived";

/** Derive visibility from the full catalog before filtering or project grouping.
 * Subagents follow their parent chain; forks remain independent conversations.
 * Copies are returned so the session scanner's cache is never mutated. */
export function withSessionArchiveState(
  sessions: readonly SessionInfo[],
  archivedIds: ReadonlySet<string>,
): SessionInfo[] {
  const byId = new Map(sessions.map(session => [session.id, session]));
  const states = new Map<string, boolean>();
  const archived = (id: string): boolean => {
    const path: string[] = [];
    const visited = new Set<string>();
    let current = id;
    let result = false;
    while (true) {
      if (states.has(current)) { result = states.get(current)!; break; }
      if (archivedIds.has(current)) { result = true; break; }
      if (visited.has(current)) break;
      visited.add(current);
      path.push(current);
      const session = byId.get(current);
      if (session?.relation?.kind !== "subagent") break;
      current = session.relation.parentSessionId;
    }
    for (const member of path) states.set(member, result);
    return result;
  };
  return sessions.map(session => ({ ...session, archived: archived(session.id) }));
}

/** Undefined is active for old clients and transient in-memory sessions. */
export function sessionsInArchiveScope(
  sessions: readonly SessionInfo[],
  scope: SessionArchiveScope,
): SessionInfo[] {
  return sessions.filter(session => Boolean(session.archived) === (scope === "archived"));
}
