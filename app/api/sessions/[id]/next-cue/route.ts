import { NextResponse } from "next/server";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { getRpcSession } from "@/lib/rpc-manager";
import { generateNextCue, parseNextCueModelRequest, UnavailableNextCueModelError } from "@/lib/next-cue";
import type { NextCueModelSelection } from "@/lib/next-cue-preference";
import { resolveSessionPath } from "@/lib/session-reader";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let selection: NextCueModelSelection | null;
  try {
    selection = parseNextCueModelRequest(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid model selection" }, { status: 400 });
  }
  // Only run for an already-open session. Starting a dormant wrapper just
  // to display an optional hint would load extensions and change its lifecycle.
  const wrapper = getRpcSession(id);
  if (!wrapper?.isAlive()) {
    if (!await resolveSessionPath(id)) return NextResponse.json({ error: "Session not found" }, { status: 404 });
    return new Response(null, { status: 204 });
  }
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(12_000)]);
  try {
    await wrapper.waitUntilReady();
    if (signal.aborted) return new Response(null, { status: 204 });
    const result = await generateNextCue(wrapper.inner as AgentSession, signal, selection);
    if (!result || !wrapper.isAlive()) return new Response(null, { status: 204 });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof UnavailableNextCueModelError) {
      return NextResponse.json({ error: error.message }, { status: 422 });
    }
    // Suggestions are optional; do not expose provider errors or credentials.
    return new Response(null, { status: 204 });
  }
}
