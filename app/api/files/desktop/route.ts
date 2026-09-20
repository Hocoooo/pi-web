import { NextResponse } from "next/server";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { getAllowedFileRoots, isFilePathAllowed, isExistingFilePathAllowed } from "@/lib/file-access";
import { isFilePathReferencedBySession } from "@/lib/session-file-references";
import { hasJsonContentType } from "@/lib/request-security";
import { isLocalDesktopRequest, launchDesktopFile } from "@/lib/desktop-files";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!isLocalDesktopRequest(request)) {
    return NextResponse.json({ error: "Desktop actions require a same-origin localhost request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Expected JSON" }, { status: 415 });
  }
  let body;
  try { body = await request.json(); } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body || typeof body.filePath !== "string" || !path.isAbsolute(body.filePath)
    || /[\x00-\x1f]/.test(body.filePath)
    || (body.action !== "open" && body.action !== "reveal")) {
    return NextResponse.json({ error: "An absolute file path and open/reveal action are required" }, { status: 400 });
  }
  // Reject Windows device/UNC paths and alternate data streams for desktop execution.
  if (process.platform === "win32" && (!/^[a-z]:[\\/]/i.test(body.filePath) || /[:"<>|?*]/.test(body.filePath.slice(2)))) {
    return NextResponse.json({ error: "Only local drive paths are supported" }, { status: 400 });
  }
  const filePath = path.resolve(body.filePath);
  const roots = await getAllowedFileRoots();
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : null;
  const allowedByRoot = isFilePathAllowed(filePath, roots);
  const allowed = allowedByRoot && isExistingFilePathAllowed(filePath, roots);
  // A referenced external file may be opened, but its parent is not thereby authorized.
  const referenced = !allowed && body.action === "open" && await isFilePathReferencedBySession(filePath, sessionId);
  if (!allowedByRoot && !referenced) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  try {
    const info = await stat(filePath);
    if (!allowed && !referenced) return NextResponse.json({ error: "Access denied" }, { status: 403 });
    if (!info.isFile()) return NextResponse.json({ error: "Not a file" }, { status: 400 });
    if (body.action === "reveal" && !isExistingFilePathAllowed(path.dirname(filePath), roots)) {
      return NextResponse.json({ error: "Parent directory access denied" }, { status: 403 });
    }
    const canonical = await realpath(filePath);
    // Do not let a session reference to a symlink authorize an unrelated execution target.
    if (referenced && !await isFilePathReferencedBySession(canonical, sessionId)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    await launchDesktopFile(canonical, body.action);
    return NextResponse.json({ success: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "Desktop action failed" }, { status: 500 });
  }
}
