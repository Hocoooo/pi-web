import { NextResponse } from "next/server";
import { mkdirSync } from "fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { chatWorkspaceCwd } from "@/lib/chat-workspace";
import { CHAT_WORKSPACE_KEY } from "@/lib/session-kind";
import { allowFileRoot } from "@/lib/file-access";

// POST /api/default-cwd
// Resolve/create the single managed workspace for independent chats.
export async function POST() {
  try {
    const dir = chatWorkspaceCwd(getAgentDir());
    mkdirSync(dir, { recursive: true });
    allowFileRoot(dir);
    return NextResponse.json({ cwd: dir, projectRoot: dir, projectKey: CHAT_WORKSPACE_KEY, sessionKind: "chat" });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
