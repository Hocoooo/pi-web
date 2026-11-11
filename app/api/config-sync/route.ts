import { NextResponse } from "next/server";
import { ConfigSyncError, getConfigSyncStatus, saveConfigSyncBinding, syncConfiguration } from "@/lib/config-sync";
import { isRecord } from "@/lib/config-sync-data";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function failure(error: unknown) {
  if (error instanceof ConfigSyncError) return NextResponse.json(
    { error: error.message, code: error.code, ...(error.applied ? { applied: true } : {}) }, { status: error.status },
  );
  // Filesystem/parser/installer errors may contain local paths or credential-bearing source bytes.
  return NextResponse.json({ error: "Configuration sync failed. Check local file permissions and configuration, then retry.", code: "internal" }, { status: 500 });
}
async function body(request: Request): Promise<unknown> {
  if (!isApiRequestAllowed(request)) throw new ConfigSyncError("Untrusted API request", "request-denied", 403);
  if (!hasJsonContentType(request)) throw new ConfigSyncError("Content-Type must be application/json", "content-type", 415);
  try { return await request.json(); }
  catch { throw new ConfigSyncError("Invalid JSON body"); }
}
export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return failure(new ConfigSyncError("Untrusted API request", "request-denied", 403));
  try { return NextResponse.json(getConfigSyncStatus()); }
  catch (error) { return failure(error); }
}
export async function PUT(request: Request) {
  try { return NextResponse.json(await saveConfigSyncBinding(await body(request))); }
  catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    const input = await body(request);
    if (!isRecord(input) || (input.action !== "push" && input.action !== "pull")) throw new ConfigSyncError("Choose push or pull");
    return NextResponse.json(await syncConfiguration(input.action));
  } catch (error) { return failure(error); }
}
