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

export type SessionArchiveErrorCode = "invalid-input" | "invalid-storage" | "unsupported-version" | "storage-unavailable";
const MESSAGES: Record<SessionArchiveErrorCode, string> = {
  "invalid-input": "A valid session UUID and archived boolean are required.",
  "invalid-storage": "Session archive storage is invalid; no changes were saved.",
  "unsupported-version": "Session archive storage has an unsupported version; no changes were saved.",
  "storage-unavailable": "Session archive storage is unavailable; the operation was not confirmed. Retry after checking access.",
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

function decode(text: string | undefined): Set<string> {
  if (text === undefined) return new Set();
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new SessionArchiveError("invalid-storage"); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new SessionArchiveError("invalid-storage");
  const document = value as Record<string, unknown>;
  if (!Object.hasOwn(document, "version")) throw new SessionArchiveError("invalid-storage");
  if (document.version !== 1) throw new SessionArchiveError("unsupported-version");
  // Refuse unknown fields instead of silently dropping future records during a write.
  if (Object.keys(document).length !== 2 || !Object.hasOwn(document, "archivedSessionIds")
    || !Array.isArray(document.archivedSessionIds) || !document.archivedSessionIds.every(isSessionArchiveId)
    || new Set(document.archivedSessionIds).size !== document.archivedSessionIds.length) {
    throw new SessionArchiveError("invalid-storage");
  }
  return new Set(document.archivedSessionIds as string[]);
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
  try { return decode(readText(getSessionArchivePath(agentDir))); }
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

/** Idempotent boolean set. Every writer re-reads under the same cross-process lock. */
export async function setSessionArchived(sessionId: string, archived: boolean, agentDir = getAgentDir()): Promise<void> {
  if (!isSessionArchiveId(sessionId) || typeof archived !== "boolean") throw new SessionArchiveError("invalid-input");
  try {
    await mkdir(agentDir, { recursive: true, mode: 0o700 });
    // Canonical directory gives aliases of the agent dir one queue and lock identity.
    const file = getSessionArchivePath(await realpath(agentDir));
    await serializeByKey(QUEUE_KEY, file, async () => {
      let compromised = false;
      const assertLock = () => {
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
        const ids = decode(original);
        assertLock();
        if (ids.has(sessionId) === archived) return;
        if (archived) ids.add(sessionId);
        else ids.delete(sessionId);
        const text = `${JSON.stringify({ version: 1, archivedSessionIds: [...ids].sort() })}\n`;
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
