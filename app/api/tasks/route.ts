import { NextResponse } from "next/server";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { taskOperation } from "@/lib/task-operations";
import { TaskOperationError } from "@/lib/task-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
const MAX_REQUEST_BYTES = 256 * 1024;
// Public actions only. Internal admission/delivery/copy actions must never be
// reachable by posting a plausible receipt; parsers still reject extra fields.
const PUBLIC_ACTIONS = new Set(["list", "create", "createFromSession", "edit", "move", "set-columns", "remove-column", "sessions", "link", "change-session-relation",
  "save-view", "set-archive", "publish-context", "restore-context", "prepare-start",
  "summary-options", "summary-source", "summary-generate", "summary-cancel",
  "context-update-state", "accept-context-update", "clear-context-update"]);
function failure(error: unknown) {
  if (error instanceof TaskOperationError) {
    const status = error.code === "invalid-input" ? 400 : error.code === "not-found" ? 404 : error.code === "conflict" ? 409 : 503;
    return NextResponse.json({ error: error.message, code: error.code }, { status, headers });
  }
  return NextResponse.json({ error: "Task operation failed. Retry or reload the board.", code: "storage-unavailable" }, { status: 503, headers });
}
export async function GET() {
  try { return NextResponse.json(await taskOperation({ action: "list" }, { agentDir: getAgentDir() }), { headers }); }
  catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  let input: unknown;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text) > MAX_REQUEST_BYTES) return NextResponse.json({ error: "Task request is too large.", code: "invalid-input" }, { status: 413, headers });
    input = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "A JSON task operation is required.", code: "invalid-input" }, { status: 400, headers });
  }
  if (!input || typeof input !== "object" || Array.isArray(input)
    || !PUBLIC_ACTIONS.has((input as { action?: string }).action ?? "")) {
    return failure(new TaskOperationError("invalid-input", "Unknown or internal task action. Task admission requires the agent prompt path."));
  }
  try { return NextResponse.json(await taskOperation(input, { agentDir: getAgentDir(), signal: request.signal }), { headers }); }
  catch (error) { return failure(error); }
}
