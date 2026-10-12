import { NextResponse } from "next/server";
import { listAllSessions } from "@/lib/session-reader";
import { searchSessionContents } from "@/lib/session-search";
import { readArchivedSessionIds } from "@/lib/session-archive";
import { sessionsInArchiveScope, withSessionArchiveState } from "@/lib/session-archive-view";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const query = (params.get("q") ?? "").trim();
  const archiveScope = params.get("archive") ?? "active";
  const headers = { "Cache-Control": "no-store" };
  if (archiveScope !== "active" && archiveScope !== "archived") {
    return NextResponse.json({ error: "Invalid archive scope" }, { status: 400, headers });
  }
  if (query.length > 200) {
    return NextResponse.json({ error: "Search query exceeds 200 characters" }, { status: 400, headers });
  }
  try {
    // Paths come only from the same catalog used by the sidebar. `allowStale`
    // keeps the request off the catalogue rebuild path: agent activity
    // invalidates the scan constantly, and rebuilding it costs hundreds of
    // milliseconds because loadAllSessions() re-reads every forked and subagent
    // session. The trade-off is that a session created in the last couple of
    // seconds is not searched yet; the stale read schedules the rebuild, so the
    // next search sees it.
    const catalog = query && !request.signal.aborted ? await listAllSessions({ allowStale: true }) : [];
    const sessions = catalog.length ? sessionsInArchiveScope(
      withSessionArchiveState(catalog, await readArchivedSessionIds()), archiveScope,
    ) : [];
    return NextResponse.json(await searchSessionContents(sessions, query, request.signal), { headers });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500, headers });
  }
}
