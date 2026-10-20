import { NextResponse } from "next/server";
import { currentServerPerf, instrumentRoute } from "@/lib/perf";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";

export const GET = instrumentRoute("GET /api/sessions/[id]/state", async (
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) => {
  const perf = currentServerPerf();
  const { id } = await params;
  try {
    const rpc = getRpcSession(id);
    if (rpc?.isAlive()) {
      perf?.span("lookup", { live: true });
      const state = await rpc.send({ type: "get_state" });
      perf?.span("get_state");
      return NextResponse.json({ running: true, state });
    }

    const path = await resolveSessionPath(id);
    perf?.span("lookup", { live: false, found: Boolean(path) });
    if (!path) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    return NextResponse.json({ running: false });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
});
