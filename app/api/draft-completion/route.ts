import { handleDraftCompletion } from "@/lib/draft-completion-server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  return handleDraftCompletion(req);
}
