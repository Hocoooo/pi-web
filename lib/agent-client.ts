// Client-side helper for POST /api/agent/[id].
//
// Every /api/agent/[id] route returns one of:
//   { success: true, data: <result> }
//   { error: string }              (non-2xx)
//
// Call sites previously repeated the same 5-line fetch block 13× in
// hooks/useAgentSession.ts. This helper collapses that down to one line.

import { isTaskSessionId } from "./task-types";

export class AgentCommandError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly accepted?: boolean,
  ) {
    super(message);
    this.name = "AgentCommandError";
  }
}

export function isPromptRejectedError(error: unknown): error is AgentCommandError {
  return error instanceof AgentCommandError
    && error.code === "prompt_rejected"
    && error.accepted === false;
}

const copyAttempts = new Map<string, string>();
function copyAttempt(sessionId: string, command: Record<string, unknown>): { key: string; operationId: string } | undefined {
  if (!["fork", "fork_branch", "clone"].includes(command.type as string) || command.operationId !== undefined) return;
  const key = `pi-web:session-copy:${JSON.stringify([sessionId, command.type, command.entryId ?? null, command.leafId ?? null])}`;
  let operationId = copyAttempts.get(key);
  try { operationId ??= sessionStorage.getItem(key) ?? undefined; } catch { /* Memory still protects retries in this page. */ }
  if (!operationId) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    operationId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  copyAttempts.set(key, operationId);
  try { sessionStorage.setItem(key, operationId); } catch { /* No browser storage dependency. */ }
  return { key, operationId };
}

export async function sendAgentCommand<T = unknown>(
  sessionId: string,
  command: Record<string, unknown>,
): Promise<T> {
  // Every actual copy entry uses this helper; failures retain the exact request UUID.
  const attempt = copyAttempt(sessionId, command);
  const res = await fetch(`/api/agent/${encodeURIComponent(sessionId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(attempt ? { ...command, operationId: attempt.operationId } : command),
  });
  const parsed: unknown = await res.json().catch(() => undefined);
  const body = (parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}) as {
    success?: boolean;
    data?: T;
    error?: string;
    code?: string;
    accepted?: boolean;
  };
  if (!res.ok || body.error) {
    throw new AgentCommandError(
      body.error ?? `HTTP ${res.status}`,
      res.status,
      body.code,
      body.accepted,
    );
  }
  if (["fork", "fork_branch", "clone"].includes(command.type as string)) {
    const data = body.data as { cancelled?: unknown; newSessionId?: unknown } | undefined;
    const validResult = data && typeof data === "object" && !Array.isArray(data)
      && (data.cancelled === true && data.newSessionId === undefined
        || data.cancelled === false && isTaskSessionId(data.newSessionId) && data.newSessionId !== sessionId);
    if (body.success !== true || !validResult) {
      throw new AgentCommandError(
        `Session copy was not confirmed: the server response was incomplete or invalid. Retry the same copy request to confirm its original result; do not start a separate copy. Request: ${attempt?.operationId ?? command.operationId}.`,
        res.status,
        "session_copy_unconfirmed",
      );
    }
  }
  if (attempt) {
    copyAttempts.delete(attempt.key);
    try { sessionStorage.removeItem(attempt.key); } catch { /* Memory fallback. */ }
  }
  return body.data as T;
}
