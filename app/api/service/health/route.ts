import { NextResponse } from "next/server";
import { serviceHealth } from "@/lib/service-health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Existing web authentication applies. Inputs are host configuration, never request parameters.
export async function GET() {
  const health = await serviceHealth();
  return NextResponse.json(health, {
    status: health.status === "unhealthy" ? 503 : 200,
    headers: { "Cache-Control": "no-store" },
  });
}
