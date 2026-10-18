import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readTaskStore } from "@/lib/task-store";
import { TASK_ID_PATTERN, TaskOperationError } from "@/lib/task-types";
import { taskOwnersForSessions } from "@/lib/task-membership";
import { listAllSessions } from "@/lib/session-reader";
import { searchSessionContents } from "@/lib/session-search";
import { readArchivedSessionIds } from "@/lib/session-archive";
import { sessionsInArchiveScope, withSessionArchiveState } from "@/lib/session-archive-view";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const query = (params.get("q") ?? "").trim();
  const archiveScope = params.get("archive") ?? "active";
  const taskId = params.get("taskId");
  const headers = { "Cache-Control": "no-store" };
  if (taskId !== null && taskId !== "unlinked" && !TASK_ID_PATTERN.test(taskId)) {
    return NextResponse.json({ error: "Invalid task scope", code: "invalid-input" }, { status: 400, headers });
  }
  if (archiveScope !== "active" && archiveScope !== "archived") {
    return NextResponse.json({ error: "Invalid archive scope" }, { status: 400, headers });
  }
  if (query.length > 200) {
    return NextResponse.json({ error: "Search query exceeds 200 characters" }, { status: 400, headers });
  }
  try {
    // Read complete membership before any search caps, including for empty queries.
    // Global search has no task-store dependency; scoped failures must never widen it.
    const tasks = taskId === null ? undefined : readTaskStore(getAgentDir())?.tasks ?? [];
    if (tasks && taskId !== "unlinked" && !tasks.some(task => task.id === taskId)) {
      return NextResponse.json({ error: "Task not found", code: "not-found" }, { status: 404, headers });
    }
    // Paths come only from the same catalog used by the sidebar. `allowStale`
    // keeps the request off the catalogue rebuild path: agent activity
    // invalidates the scan constantly, and rebuilding it costs hundreds of
    // milliseconds because loadAllSessions() re-reads every forked and subagent
    // session. The trade-off is that a session created in the last couple of
    // seconds is not searched yet; the stale read schedules the rebuild, so the
    // next search sees it.
    const catalog = query && !request.signal.aborted ? await listAllSessions({ allowStale: true }) : [];
    // Resolve ancestry from the complete native catalog, not an archive/task subset:
    // an explicitly owned descendant can override a different task's family root.
    const owners = tasks ? taskOwnersForSessions(tasks, catalog) : undefined;
    const sessions = catalog.length ? sessionsInArchiveScope(
      withSessionArchiveState(catalog, await readArchivedSessionIds()), archiveScope,
    ).filter(session => !owners || (taskId === "unlinked"
      ? !owners.has(session.id) : owners.get(session.id) === taskId)) : [];
    return NextResponse.json(await searchSessionContents(sessions, query, request.signal), { headers });
  } catch (error) {
    if (error instanceof TaskOperationError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: 503, headers });
    }
    return NextResponse.json({ error: String(error) }, { status: 500, headers });
  }
}
