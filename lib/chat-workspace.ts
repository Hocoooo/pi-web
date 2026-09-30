import { join } from "path";
import { samePath } from "./paths";

/** Reserved application cwd, persisted in Pi's ordinary session header. */
export function chatWorkspaceCwd(agentDir: string): string {
  return join(agentDir, "chat-workspace");
}

export function isChatWorkspace(cwd: string, agentDir: string): boolean {
  return samePath(cwd, chatWorkspaceCwd(agentDir));
}
