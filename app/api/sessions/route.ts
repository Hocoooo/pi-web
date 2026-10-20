import { NextResponse } from "next/server";
import { jsonResponse } from "@/lib/json-response";
import {
  attachSessionProjectInfo,
  getSessionListVersion,
  listAllSessions,
  listSessionSummaries,
  mergeSessionLists,
} from "@/lib/session-reader";
import {
  getCompletionNotificationSuppressedRpcSessionIds,
  getRpcSessionInfos,
  getRunningRpcSessionIds,
} from "@/lib/rpc-manager";
import { currentServerPerf, instrumentRoute } from "@/lib/perf";
import { readArchivedSessionIds } from "@/lib/session-archive";
import { withSessionArchiveState } from "@/lib/session-archive-view";

export const dynamic = "force-dynamic";

export const GET = instrumentRoute("GET /api/sessions", async (req: Request) => {
  const perf = currentServerPerf();
  try {
    const searchParams = new URL(req.url).searchParams;
    const force = searchParams.get("force") === "1";
    // `summary=1` serves header/stat metadata so the sidebar can paint without
    // waiting for every session transcript to be parsed.
    const summary = searchParams.get("summary") === "1";
    perf?.span("start", { force, summary });
    const persistedSessionsPromise = summary
      ? listSessionSummaries()
      : listAllSessions({ force });
    // Capture before awaiting: mutations during the scan still require a later refresh.
    const sessionListVersion = getSessionListVersion();
    const [persistedSessions, runtimeSessions] = await Promise.all([
      persistedSessionsPromise,
      attachSessionProjectInfo(getRpcSessionInfos()),
    ]);
    perf?.span("scan+projects", { persisted: persistedSessions.length, runtime: runtimeSessions.length });
    // Keep the canonical catalog complete: tasks, URL restoration and activity
    // tracking still need archived sessions. Only the sidebar/search project it.
    const sessions = withSessionArchiveState(
      mergeSessionLists(persistedSessions, runtimeSessions),
      await readArchivedSessionIds(),
    );
    perf?.span("archive_and_merge", { sessions: sessions.length });
    const response = jsonResponse(
      req,
      {
        sessions,
        sessionListVersion,
        runningSessionIds: getRunningRpcSessionIds(),
        completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
    perf?.span("serialize");
    return response;
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
});
