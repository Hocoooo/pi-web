import { NextResponse } from "next/server";
import { existsSync, statSync } from "fs";
import { deleteSessionFiles, SessionDeletionError } from "@/lib/session-deletion";
import {
  attachSessionProjectInfo,
  openSessionManager,
  resolveSessionPath,
  resolveSessionIdByPath,
  getSessionListVersion,
  buildSessionContext,
} from "@/lib/session-reader";
import { getRpcSession, updateSessionTitle } from "@/lib/rpc-manager";
import { readSessionTitleState, isStaleSessionTitleError } from "@/lib/auto-session-title";
import { projectTreeForResponse, toSummaryTree } from "@/lib/project-tree";
import { computeSessionTotalActiveMs } from "@/lib/session-timing";
import { computeSessionStats } from "@/lib/session-stats";
import { currentServerPerf, instrumentRoute } from "@/lib/perf";
import { computeSessionRevision } from "@/lib/session-revision";
import type { SessionEntry } from "@/lib/types";
import { readSubagentRun, readSubagentSessionResources } from "@/lib/subagents";
import { readSessionToolSelection } from "@/lib/session-tool-selection";
import { jsonResponse } from "@/lib/json-response";

export const GET = instrumentRoute("GET /api/sessions/[id]", async (
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) => {
  const perf = currentServerPerf();
  const { id } = await params;
  try {
    perf?.span("resolve");
    const rpc = getRpcSession(id);
    const searchParams = new URL(req.url).searchParams;
    const force = searchParams.get("force") === "1";

    // A live wrapper only reflects the appends pi-web itself made. When another
    // pi process (the TUI) writes the same session file, the in-memory index
    // stays stale. Only probe on ?force=1 (session mount / page refresh): two
    // processes writing one JSONL is unsupported, so post-turn reads must not
    // scan disk. Eviction is idle-only; mid-run the wrapper owns the write path.
    let liveWrapper = rpc?.isAlive() ? rpc : undefined;
    let wrapperRebuilt = false;
    if (force && liveWrapper?.evictIfDiskAhead()) {
      wrapperRebuilt = true;
      liveWrapper = undefined;
    }
    const liveRpc = liveWrapper;
    const resolvedPath = liveRpc ? null : await resolveSessionPath(id);
    if (!liveRpc && !resolvedPath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const sm = liveRpc?.inner.sessionManager ?? openSessionManager(resolvedPath!);
    perf?.span("open", { force, live: Boolean(liveRpc), wrapperRebuilt });
    const filePath = liveRpc?.sessionFile || sm.getSessionFile() || resolvedPath || "";
    const entries = sm.getEntries();
    const leafId = sm.getLeafId();
    const summaryTree = searchParams.get("tree") === "summary";
    const tree = summaryTree
      ? toSummaryTree(projectTreeForResponse(sm.getTree()))
      : projectTreeForResponse(sm.getTree());
    perf?.span("tree", { entries: entries.length, summaryTree });
    const deferThinking = searchParams.has("deferThinking");
    const deferToolResultImages = searchParams.has("deferMedia");
    const rawTail = Number(searchParams.get("tail"));
    const tail = Number.isFinite(rawTail) && rawTail > 0 ? Math.min(rawTail, 1000) : 50;
    const context = buildSessionContext(entries as never, leafId, {
      deferThinking,
      deferToolResultImages,
      tail,
      sessionId: id, // local: lazy URLs for historical tool-result images
    });
    perf?.span("context");
    const totalActiveMs = computeSessionTotalActiveMs(entries);
    // Cumulative usage over ALL entries, including history compacted away —
    // the same aggregation the SDK's getSessionStats() uses. Lets the client
    // keep monotonic token/cost counters across compaction and page reloads.
    const stats = computeSessionStats(entries as unknown as SessionEntry[]);
    perf?.span("stats");
    // Opaque freshness token for the session view cache. Derived from the
    // disk fingerprint and the actual read source; null tells the client the
    // snapshot is unstable and must not be cached as fresh.
    const latestEntry = entries[entries.length - 1] as { id?: string } | undefined;
    const snapshotRevision = computeSessionRevision({
      filePath,
      sourceId: liveRpc ? `runtime:${String(liveRpc.inner.sessionId)}` : "disk",
      entryCount: entries.length,
      latestEntryId: typeof latestEntry?.id === "string" ? latestEntry.id : null,
      leafId: leafId ?? null,
    });
    const sessionName = sm.getSessionName();
    const sessionListVersion = getSessionListVersion();
    const firstUserEntry = entries.find((entry) => entry.type === "message" && entry.message.role === "user");
    const firstUserMessage = firstUserEntry?.type === "message" ? firstUserEntry.message : undefined;

    const header = sm.getHeader();
    let modified = header?.timestamp ?? new Date().toISOString();
    try { modified = statSync(filePath).mtime.toISOString(); } catch { /* use header timestamp */ }
    const parentSessionId = header?.parentSession
      ? await resolveSessionIdByPath(header.parentSession)
      : undefined;
    const subagent = header
      ? readSubagentRun(entries as never, header.id, filePath)
      : null;
    const toolNames = readSubagentSessionResources(entries as never)?.tools
      ?? readSessionToolSelection(entries as never);
    const info = header ? (await attachSessionProjectInfo([{
      path: filePath,
      id: header.id,
      cwd: header.cwd ?? "",
      name: sessionName,
      autoTitleEnabled: !subagent && readSessionTitleState(entries, sessionName).enabled,
      created: header.timestamp,
      modified,
      messageCount: stats.totalMessages,
      firstMessage: firstUserMessage
        ? (() => {
            const c = (firstUserMessage as { content: unknown }).content;
            return typeof c === "string" ? c : (Array.isArray(c) ? (c.find((b: { type: string }) => b.type === "text") as { text: string } | undefined)?.text ?? "" : "") || "(no messages)";
          })()
        : "(no messages)",
      parentSessionId,
      ...(subagent
        ? { relation: { kind: "subagent" as const, parentSessionId: subagent.parentSessionId, profile: subagent.profile, description: subagent.description, status: liveRpc?.isRunning() ? "running" as const : subagent.status } }
        : header.parentSession
          ? { relation: { kind: "fork" as const, ...(parentSessionId ? { originSessionId: parentSessionId } : {}) } }
          : {}),
      transient: !filePath || !existsSync(filePath),
    }]))[0] : null;

    perf?.span("revision_and_project");
    const response = jsonResponse(
      req,
      {
        sessionId: id,
        filePath,
        info,
        leafId,
        tree,
        ...(summaryTree ? { treeFormat: "summary" as const } : {}),
        snapshotRevision,
        context,
        stats,
        totalActiveMs,
        ...(toolNames !== undefined ? { toolNames } : {}),
        ...(wrapperRebuilt ? { wrapperRebuilt: true } : {}),
        sessionListVersion,
      },
    );
    perf?.span("serialize");
    return response;
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
});

// PATCH /api/sessions/[id] body: { name: string } OR { autoTitleEnabled: boolean }
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const body = await req.json().catch(() => null) as { name?: unknown; autoTitleEnabled?: unknown } | null;
    const renaming = typeof body?.name === "string" && body.autoTitleEnabled === undefined;
    const configuring = typeof body?.autoTitleEnabled === "boolean" && body.name === undefined;
    if (!renaming && !configuring) {
      return NextResponse.json({ error: "Provide name OR autoTitleEnabled" }, { status: 400 });
    }
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const state = await updateSessionTitle(id, filePath, renaming
      ? { name: (body!.name as string).trim() }
      : { autoTitleEnabled: body!.autoTitleEnabled as boolean });
    return NextResponse.json({ ok: true, title: state.title, autoTitleEnabled: state.enabled, sessionListVersion: getSessionListVersion() });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: isStaleSessionTitleError(error) ? 409 : 500 });
  }
}

// DELETE /api/sessions/[id]
export const DELETE = instrumentRoute("DELETE /api/sessions/[id]", async (
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) => {
  const { id } = await params;
  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    currentServerPerf()?.span("resolve");
    const deletedSessionIds = await deleteSessionFiles(id, filePath);
    return NextResponse.json({ ok: true, deletedSessionIds, sessionListVersion: getSessionListVersion() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error),
      deletedSessionIds: error instanceof SessionDeletionError ? error.deletedSessionIds : [],
      sessionListVersion: getSessionListVersion(),
    }, { status: 500 });
  }
});
