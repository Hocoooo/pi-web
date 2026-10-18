import type { TaskCatalogEntry } from "./task-catalog-types";
import type { SessionInfo } from "./types";

/**
 * Project a complete task catalog onto subagent ancestry without changing links.
 * The nearest explicit owner wins; forks never inherit from their origin.
 * Missing/unowned ancestors and ownerless cycles leave sessions unlinked.
 * Explicit links are retained even when a session is absent from the catalog.
 */
export function taskOwnersForSessions(
  tasks: readonly Pick<TaskCatalogEntry, "id" | "sessionIds">[],
  sessions: readonly Pick<SessionInfo, "id" | "relation">[],
): Map<string, string> {
  const owners = new Map<string, string>();
  for (const task of tasks) for (const sessionId of task.sessionIds) owners.set(sessionId, task.id);
  const byId = new Map(sessions.map(session => [session.id, session]));
  const resolved = new Set(owners.keys());

  for (const session of sessions) {
    if (resolved.has(session.id)) continue;
    const path = new Set<string>();
    let currentId = session.id;
    let owner: string | undefined;
    while (!path.has(currentId)) {
      if (resolved.has(currentId)) {
        owner = owners.get(currentId);
        break;
      }
      path.add(currentId);
      const current = byId.get(currentId);
      if (current?.relation?.kind !== "subagent") break;
      currentId = current.relation.parentSessionId;
    }
    for (const id of path) {
      resolved.add(id);
      if (owner !== undefined) owners.set(id, owner);
    }
  }
  return owners;
}
