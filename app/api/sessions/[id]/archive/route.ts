import { lstat } from "node:fs/promises";
import { NextResponse } from "next/server";
import { invalidateSessionListCache, listAllSessions, resolveSessionPath } from "@/lib/session-reader";
import { isSessionArchiveError, isSessionArchiveId, setSessionArchived } from "@/lib/session-archive";

// PUT /api/sessions/[id]/archive — visibility metadata only, including for live persisted sessions.
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isSessionArchiveId(id)) {
    return NextResponse.json({ error: "A valid session UUID is required." }, { status: 400 });
  }
  let body: unknown;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Expected exactly { archived: boolean }." }, { status: 400 }); }
  if (typeof body !== "object" || body === null || Array.isArray(body)
    || Object.keys(body).length !== 1 || !Object.hasOwn(body, "archived")
    || typeof (body as { archived?: unknown }).archived !== "boolean") {
    return NextResponse.json({ error: "Expected exactly { archived: boolean }." }, { status: 400 });
  }
  const archived = (body as { archived: boolean }).archived;
  try {
    const file = await resolveSessionPath(id);
    if (!file || !file.endsWith(".jsonl")) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    try {
      // A live/transient wrapper can have a cached file path without ever flushing a file.
      // Reject links and other nonregular targets too; do not open/migrate a SessionManager.
      const stats = await lstat(file);
      if (!stats.isFile() || stats.isSymbolicLink()) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") return NextResponse.json({ error: "Session not found" }, { status: 404 });
      throw error;
    }
    // Sidebar actions target family roots. A subagent's independent archive would be undiscoverable.
    let session = (await listAllSessions()).find((candidate) => candidate.id === id);
    // A recently persisted subagent can have a cached path before the catalogue includes it.
    if (!session) session = (await listAllSessions({ force: true })).find((candidate) => candidate.id === id);
    if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    if (session.relation?.kind === "subagent") {
      return NextResponse.json({ error: "Archive or restore the parent conversation instead." }, { status: 400 });
    }
    await setSessionArchived(id, archived);
    invalidateSessionListCache();
    return NextResponse.json({ ok: true, sessionId: id, archived });
  } catch (error) {
    if (isSessionArchiveError(error)) {
      const status = error.code === "invalid-input" ? 400 : error.code === "storage-unavailable" ? 503 : 500;
      return NextResponse.json({ error: error.message, code: error.code }, { status });
    }
    return NextResponse.json({ error: "Session archive is unavailable; the operation was not confirmed." }, { status: 500 });
  }
}
