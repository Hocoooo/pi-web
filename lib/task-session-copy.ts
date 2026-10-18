import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { serializeByKey } from "./key-serializer";
import { isTaskSessionId, TASK_ID_PATTERN, TaskOperationError, type TaskCopyResult } from "./task-types";

/** Internal durable intent/receipt, not a second session history or an adoption record. */
export interface SessionCopyReceipt {
  operationId: string;
  fingerprint: string;
  sourceSessionId: string;
  sourceRelationGeneration?: number;
  taskId: string | null;
  status: "prepared" | "completed";
  newSessionId: string | null;
}
export function validSessionCopies(value: unknown): value is SessionCopyReceipt[] {
  if (!Array.isArray(value)) return false;
  return value.every((r) => r && typeof r === "object" && !Array.isArray(r)
    && Object.keys(r).length === (r.sourceRelationGeneration === undefined ? 6 : 7)
    && (r.sourceRelationGeneration === undefined || Number.isSafeInteger(r.sourceRelationGeneration) && r.sourceRelationGeneration >= 0) && ["operationId", "fingerprint", "sourceSessionId", "taskId", "status", "newSessionId"].every((k) => Object.hasOwn(r, k))
    && typeof r.operationId === "string" && TASK_ID_PATTERN.test(r.operationId)
    && typeof r.fingerprint === "string" && /^[a-f0-9]{64}$/.test(r.fingerprint)
    && isTaskSessionId(r.sourceSessionId) && (r.taskId === null || typeof r.taskId === "string" && TASK_ID_PATTERN.test(r.taskId))
    && ["prepared", "completed"].includes(r.status)
    && (r.newSessionId === null || isTaskSessionId(r.newSessionId))
    && (r.status !== "prepared" || r.newSessionId === null))
    && new Set(value.map((r) => r.operationId)).size === value.length
    && new Set(value.filter((r) => r.newSessionId !== null).map((r) => r.newSessionId)).size === value.filter((r) => r.newSessionId !== null).length;
}

const COPY_KEY = Symbol.for("pi-web.session-copy");
const PENDING_KEY = Symbol.for("pi-web.session-copy.pending");
const globals = globalThis as typeof globalThis & { [PENDING_KEY]?: Map<string, { fingerprint: string; result: TaskCopyResult }> };
const pending = globals[PENDING_KEY] ??= new Map();
export class SessionCopyError extends Error {
  readonly code = "session_copy_unconfirmed";
  constructor(message: string, public readonly operationId: string, public readonly newSessionId?: string, public readonly taskCode?: string) { super(message); }
}

/** SDK creation stays native. Reserve before creating so a lost response/restart never silently creates a second child. */
export async function copySessionWithTask(
  agentDir: string, sourceSessionId: string, command: Record<string, unknown>,
  create: () => Promise<TaskCopyResult>,
): Promise<TaskCopyResult> {
  const { taskOperation } = await import("./task-operations");
  const operationId = command.operationId === undefined ? randomUUID() : command.operationId;
  if (typeof operationId !== "string" || !TASK_ID_PATTERN.test(operationId)) throw new TaskOperationError("invalid-input", "A copy operation UUID is required.");
  const fingerprint = createHash("sha256").update(JSON.stringify([sourceSessionId, command.type, command.entryId ?? null, command.leafId ?? null])).digest("hex");
  const key = `${resolve(agentDir)}:${operationId}`;
  return serializeByKey(COPY_KEY, key, async () => {
    try {
      const prepared = await taskOperation({ action: "prepare-session-copy", operationId, sourceSessionId, fingerprint }, { agentDir, sessionCopy: true }) as { receipt: SessionCopyReceipt; fresh: boolean };
      if (prepared.receipt.status === "completed") return prepared.receipt.newSessionId === null
        ? { cancelled: true } : { cancelled: false, newSessionId: prepared.receipt.newSessionId };
      const known = pending.get(key);
      if (known && known.fingerprint !== fingerprint) throw new TaskOperationError("conflict", "This copy ID was used for another request.");
      if (!known && !prepared.fresh) throw new SessionCopyError(`The previous copy outcome is unknown after interruption (request ${operationId}). This retry created no second session; the original attempt may have created an unlinked child. First refresh and inspect the sidebar session list and the task's linked chats. If you find the child, open it; do not copy again. Reloading this tab keeps the old request and cannot repair an unknown outcome. Only after inspection, if you explicitly accept the risk of a duplicate or unlinked child, open a new empty tab using the browser + button (not Duplicate tab or an Open in new tab link), paste /?session=${sourceSessionId} on this same site, and explicitly invoke the same copy entry there as a separate attempt. The old intent remains refused and its receipt is retained; no history or parent chain is guessed.`, operationId);
      const result = known?.result ?? await create();
      pending.set(key, { fingerprint, result });
      await taskOperation({ action: "complete-session-copy", operationId, sourceSessionId, fingerprint, newSessionId: result.newSessionId ?? null }, { agentDir, sessionCopy: true });
      pending.delete(key);
      return result;
    } catch (error) {
      if (error instanceof SessionCopyError) throw error;
      const child = pending.get(key)?.result.newSessionId;
      throw new SessionCopyError(`${child ? `Session ${child} was created, but task inheritance is not confirmed.` : "Session copy was not confirmed."} Retry the same copy request; it will not create a duplicate session. ${error instanceof Error ? error.message : String(error)}`, operationId, child, error instanceof TaskOperationError ? error.code : undefined);
    }
  });
}
