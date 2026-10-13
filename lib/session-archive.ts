import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { serializeByKey } from "./key-serializer";
import { readRegularFileText } from "./regular-file";

/** Standalone visibility metadata; native JSONL and task metadata are never edited. */
export const SESSION_ARCHIVE_MAX_BYTES = 1024 * 1024;
const QUEUE_KEY = Symbol.for("pi-web:session-archive-write-queue");
const ERROR_BRAND: unique symbol = Symbol.for("pi-web:session-archive-error");

export type SessionArchiveErrorCode = "invalid-input" | "invalid-storage" | "unsupported-version" | "storage-unavailable" | "scope-changed";
const MESSAGES: Record<SessionArchiveErrorCode, string> = {
  "invalid-input": "A valid session UUID and archived boolean are required.",
  "invalid-storage": "Session archive storage is invalid; no changes were saved.",
  "unsupported-version": "Session archive storage has an unsupported version; no changes were saved.",
  "storage-unavailable": "Session archive storage is unavailable; the operation was not confirmed. Retry after checking access.",
  "scope-changed": "The linked conversation archive scope changed. Review the task archive again before applying it.",
};

/** Fixed, public-safe diagnostics: never contains a path, JSON source, or underlying IO error. */
export class SessionArchiveError extends Error {
  readonly [ERROR_BRAND] = true;
  constructor(public readonly code: SessionArchiveErrorCode) {
    super(MESSAGES[code]);
    this.name = "SessionArchiveError";
  }
}

/** Brand survives hot reload and separately bundled route modules. */
export function isSessionArchiveError(error: unknown): error is SessionArchiveError {
  return typeof error === "object" && error !== null && (error as Record<symbol, unknown>)[ERROR_BRAND] === true;
}

/** Native SDK-generated UUIDs only, not paths, entry IDs or task IDs inferred from ownership. */
export function isSessionArchiveId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

export function getSessionArchivePath(agentDir = getAgentDir()): string {
  return join(agentDir, "session-archive.json");
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

interface TaskArchiveBatchReceipt { taskId: string; operationId: string; fingerprint: string }
interface ArchiveDocument { version: 1 | 2; ids: Set<string>; receipts: TaskArchiveBatchReceipt[] }
function decode(text: string | undefined): ArchiveDocument {
  if (text === undefined) return { version: 1, ids: new Set(), receipts: [] };
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new SessionArchiveError("invalid-storage"); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new SessionArchiveError("invalid-storage");
  const document = value as Record<string, unknown>;
  if (!Object.hasOwn(document, "version")) throw new SessionArchiveError("invalid-storage");
  if (document.version !== 1 && document.version !== 2) throw new SessionArchiveError("unsupported-version");
  // Refuse unknown fields instead of silently dropping future records during a write.
  if (Object.keys(document).length !== (document.version === 1 ? 2 : 3) || !Object.hasOwn(document, "archivedSessionIds")
    || !Array.isArray(document.archivedSessionIds) || !document.archivedSessionIds.every(isSessionArchiveId)
    || new Set(document.archivedSessionIds).size !== document.archivedSessionIds.length) {
    throw new SessionArchiveError("invalid-storage");
  }
  const receipts = document.version === 2 ? document.taskArchiveReceipts : [];
  if (!Array.isArray(receipts) || receipts.some(receipt => typeof receipt !== "object" || receipt === null || Array.isArray(receipt)
    || Object.keys(receipt).length !== 3 || !isSessionArchiveId(receipt.taskId) || !isSessionArchiveId(receipt.operationId)
    || typeof receipt.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(receipt.fingerprint))
    || new Set(receipts.map(receipt => receipt.taskId)).size !== receipts.length) throw new SessionArchiveError("invalid-storage");
  return { version: document.version, ids: new Set(document.archivedSessionIds as string[]), receipts };
}

function fileStat(file: string) {
  try {
    const stats = lstatSync(file);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > SESSION_ARCHIVE_MAX_BYTES) {
      throw new SessionArchiveError("invalid-storage");
    }
    return stats;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function readText(file: string): string | undefined {
  const before = fileStat(file);
  if (!before) return undefined;
  // The regular-file helper bounds reads and never blocks on a FIFO/device.
  const text = readRegularFileText(file, SESSION_ARCHIVE_MAX_BYTES);
  const after = fileStat(file);
  if (!after || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || text === undefined) {
    throw new SessionArchiveError("storage-unavailable");
  }
  return text;
}

/** Missing metadata means empty. Reads never mkdir, lock, initialize, repair or migrate anything. */
export async function readArchivedSessionIds(agentDir = getAgentDir()): Promise<Set<string>> {
  try { return decode(readText(getSessionArchivePath(agentDir))).ids; }
  catch (error) {
    if (isSessionArchiveError(error)) throw error;
    throw new SessionArchiveError("storage-unavailable");
  }
}

async function atomicWrite(file: string, text: string, assertUnchanged: () => void): Promise<void> {
  if (Buffer.byteLength(text, "utf8") > SESSION_ARCHIVE_MAX_BYTES) throw new SessionArchiveError("invalid-storage");
  const temporary = join(dirname(file), `.session-archive.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(text, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    assertUnchanged();
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  }
}

/** All visibility writers share one lock, including batch receipts and manual restoration. */
export async function setSessionArchived(sessionId: string, archived: boolean, agentDir = getAgentDir()): Promise<void> {
  if (!isSessionArchiveId(sessionId) || typeof archived !== "boolean") throw new SessionArchiveError("invalid-input");
  await changeArchive(agentDir, document => {
    if (document.ids.has(sessionId) === archived) return false;
    if (archived) document.ids.add(sessionId); else document.ids.delete(sessionId);
    return true;
  });
}

/** Internal task batch. One atomic write records both effects and the latest receipt per task.
 * Retrying a committed batch only confirms it: later manual restores are never overwritten.
 * Caller holds the board lock before this lock; validate runs only before FIRST application. */
export async function archiveSessionBatchOnce(
  input: TaskArchiveBatchReceipt & { sessionIds: readonly string[] },
  agentDir: string,
  validate: () => Promise<boolean>,
  assertAuthority: () => void = () => {},
): Promise<void> {
  if (!isSessionArchiveId(input.taskId) || !isSessionArchiveId(input.operationId)
    || !/^[0-9a-f]{64}$/.test(input.fingerprint) || !Array.isArray(input.sessionIds)
    || !input.sessionIds.every(isSessionArchiveId) || new Set(input.sessionIds).size !== input.sessionIds.length) {
    throw new SessionArchiveError("invalid-input");
  }
  await changeArchive(agentDir, async document => {
    const prior = document.receipts.find(receipt => receipt.taskId === input.taskId);
    if (prior?.operationId === input.operationId) {
      if (prior.fingerprint !== input.fingerprint) throw new SessionArchiveError("invalid-input");
      return false;
    }
    if (!await validate()) throw new SessionArchiveError("scope-changed");
    for (const id of input.sessionIds) document.ids.add(id);
    document.version = 2;
    document.receipts = document.receipts.filter(receipt => receipt.taskId !== input.taskId);
    document.receipts.push({ taskId: input.taskId, operationId: input.operationId, fingerprint: input.fingerprint });
    return true;
  }, assertAuthority);
}

async function changeArchive(agentDir: string, change: (document: ArchiveDocument) => boolean | Promise<boolean>, assertAuthority: () => void = () => {}): Promise<void> {
  try {
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    // Canonical directory gives aliases of the agent dir one queue and lock identity.
    const file = getSessionArchivePath(await realpath(agentDir));
    await serializeByKey(QUEUE_KEY, file, async () => {
      let compromised = false;
      const assertLock = () => {
        assertAuthority();
        if (compromised) throw new SessionArchiveError("storage-unavailable");
      };
      const release = await lockfile.lock(file, {
        realpath: false,
        stale: 30_000,
        retries: { retries: 10, factor: 2, minTimeout: 25, maxTimeout: 500 },
        onCompromised: () => { compromised = true; },
      });
      try {
        const original = readText(file);
        const document = decode(original);
        assertLock();
        const changed = await change(document);
        assertLock();
        if (!changed) return;
        const text = `${JSON.stringify({ version: document.version, archivedSessionIds: [...document.ids].sort(),
          ...(document.version === 2 ? { taskArchiveReceipts: document.receipts.sort((a, b) => a.taskId.localeCompare(b.taskId)) } : {}) })}\n`;
        await atomicWrite(file, text, () => {
          assertLock();
          // Refuse links, malformed replacements and uncooperative external edits that appeared while writing the temp.
          if (readText(file) !== original) throw new SessionArchiveError("storage-unavailable");
        });
        assertLock();
      } finally { await release(); }
    });
  } catch (error) {
    if (isSessionArchiveError(error)) throw error;
    throw new SessionArchiveError("storage-unavailable");
  }
}
