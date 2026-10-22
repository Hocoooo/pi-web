import { readFileSync } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { dirname, join } from "node:path";
import { getAgentDir, invalidateSessionListCache, invalidateSessionManagerCache,
  invalidateSessionPathCache, readSessionHeader, readSessionRelationMetadata } from "./session-reader";
import { listSessionMetadata } from "./session-list-scanner";
import { abortSubagent, getRpcSession, getRpcSessionInfos } from "./rpc-manager";
import { SUBAGENT_META_TYPE } from "./subagents";
import { sessionPathKey } from "./session-path";
import { currentServerPerf } from "./perf";
import { createLegacyScanMetrics } from "./session-legacy-scan";
import { createLegacyScanWorker } from "./session-legacy-worker";

type LegacyScanStats = ReturnType<typeof createLegacyScanMetrics> & { cacheHits: number; cacheMisses: number; unstableFiles: number };

type Node = { id: string; path: string; parentSessionPath?: string; parentId?: string; checkedLegacy?: boolean };
type LegacyIdentity = { fingerprint: string; parentId?: string };
declare global { var __piDeletionLegacyCache: Map<string, LegacyIdentity> | undefined; }

async function cachedLegacyParent(node: Node, metrics: LegacyScanStats, scanner: ReturnType<typeof createLegacyScanWorker>): Promise<string | undefined> {
  const cache = (globalThis.__piDeletionLegacyCache ??= new Map<string, LegacyIdentity>());
  const key = sessionPathKey(node.path);
  const fingerprint = async () => {
    const value = await stat(node.path);
    return `${node.id}:${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
  };
  const before = await fingerprint();
  const cached = cache.get(key);
  if (cached?.fingerprint === before) {
    metrics.cacheHits++;
    return cached.parentId;
  }
  metrics.cacheMisses++;
  const parentId = await scanner.scan(node, metrics);
  // Never publish a relation derived while another writer changed the file.
  if (await fingerprint() === before) {
    cache.delete(key); cache.set(key, { fingerprint: before, parentId });
    while (cache.size > 2048) cache.delete(cache.keys().next().value!);
  } else {
    metrics.unstableFiles++;
  }
  return parentId;
}
export class SessionDeletionError extends Error {
  constructor(error: unknown, public readonly deletedSessionIds: string[]) {
    super(error instanceof Error ? error.message : String(error));
  }
}

/** Only headers and bounded relation prefixes form the plan. No display
 * catalogue, project resolution, transcript hydration or subagent-result tails. */
async function deletionPlan(id: string, filePath: string) {
  const scanner = createLegacyScanWorker();
  try { return await deletionPlanWithScanner(id, filePath, scanner); }
  finally { await scanner.close(); }
}

async function deletionPlanWithScanner(id: string, filePath: string, scanner: ReturnType<typeof createLegacyScanWorker>) {
  const perf = currentServerPerf();
  const legacyMetrics: LegacyScanStats = { ...createLegacyScanMetrics(), cacheHits: 0, cacheMisses: 0, unstableFiles: 0 };
  const nodes = new Map<string, Node>();
  const add = (node: Node, probeParentless = false) => {
    try {
      const relation = readSessionRelationMetadata(node, { probeParentless }).relation;
      if (relation?.kind === "subagent") node.parentId = relation.parentSessionId;
      nodes.set(sessionPathKey(node.path), node);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
  const metadata = await listSessionMetadata(getAgentDir());
  perf?.span("metadata_scan", { files: metadata.length });
  for (const row of metadata) {
    add({ id: row.id, path: row.path, parentSessionPath: row.parentSessionPath });
  }
  perf?.span("relation_prefix");
  // Preserve local-file discovery for manually moved files / sessions outside
  // the standard catalogue layout, without loading their histories.
  const localNames = await readdir(dirname(filePath)).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  for (const name of localNames) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dirname(filePath), name);
    try {
      const header = readSessionHeader(path);
      if (header) add({ id: header.id, path, parentSessionPath: header.parentSession }, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  perf?.span("local_headers", { files: localNames.length });
  // Old DELETE discovered local late markers regardless of header.parentSession.
  // Keep that compatibility, including header/marker disagreement, without two
  // synchronous full-file reads and JSON parsing of every unrelated message.
  const localLegacy = [...nodes.values()].filter(node => node.id !== id && !node.parentId
    && sessionPathKey(dirname(node.path)) === sessionPathKey(dirname(filePath)));
  let nextLegacy = 0;
  const checks = await Promise.allSettled(Array.from({ length: Math.min(4, localLegacy.length) }, async () => {
    for (;;) {
      const node = localLegacy[nextLegacy++];
      if (!node) return;
      node.checkedLegacy = true;
      try { node.parentId = await cachedLegacyParent(node, legacyMetrics, scanner); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }));
  const failed = checks.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) throw failed.reason;
  perf?.span("legacy_scan", { candidates: localLegacy.length, ...legacyMetrics });
  const paths = new Map<string, string>();
  const edges: { id: string; parentId: string }[] = [];
  for (const node of nodes.values()) {
    paths.set(node.id, node.path);
    if (node.parentId) edges.push({ id: node.id, parentId: node.parentId });
  }
  for (const runtime of getRpcSessionInfos({ includeTransient: true })) {
    if (!paths.has(runtime.id) && runtime.path) paths.set(runtime.id, runtime.path);
    if (runtime.relation?.kind === "subagent") edges.push({ id: runtime.id, parentId: runtime.relation.parentSessionId });
  }
  perf?.span("runtime_relations");
  paths.set(id, filePath);
  const ids = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      if (ids.has(edge.parentId) && !ids.has(edge.id)) { ids.add(edge.id); changed = true; }
    }
    const familyPaths = new Set([...ids].flatMap(key => paths.has(key) ? [sessionPathKey(paths.get(key)!)] : []));
    for (const node of nodes.values()) {
      if (ids.has(node.id) || node.parentId || node.checkedLegacy || !node.parentSessionPath
        || !familyPaths.has(sessionPathKey(node.parentSessionPath))) continue;
      node.checkedLegacy = true;
      try { node.parentId = await cachedLegacyParent(node, legacyMetrics, scanner); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (node.parentId) {
        edges.push({ id: node.id, parentId: node.parentId });
        if (ids.has(node.parentId)) { ids.add(node.id); changed = true; }
      }
    }
  }
  const rootKey = sessionPathKey(filePath);
  const forks = [...nodes.values()].filter(node => !ids.has(node.id) && node.parentSessionPath
    && sessionPathKey(node.parentSessionPath) === rootKey
    && sessionPathKey(dirname(node.path)) === sessionPathKey(dirname(filePath)));
  perf?.span("family_graph", { ...legacyMetrics });
  return { ids: [...ids], paths, forks };
}

/** Returns only confirmed removals. Root is unlinked last so partial failure
 * leaves a retryable root and never falsely reports the whole family gone. */
export async function deleteSessionFiles(id: string, filePath: string): Promise<string[]> {
  const deleted: string[] = [];
  let changed = false;
  const perf = currentServerPerf();
  try {
    let parentSessionPath: string | undefined;
    try {
      const header = readSessionHeader(filePath);
      if (header && header.id !== id) throw new Error("Session file identity changed. Refresh before deleting.");
      parentSessionPath = header?.parentSession;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let parentSessionId: string | undefined;
    if (parentSessionPath) {
      try { parentSessionId = readSessionHeader(parentSessionPath)?.id; } catch { /* parent already absent */ }
    }
    const plan = await deletionPlan(id, filePath);
    perf?.span("discover", { sessions: plan.ids.length, forks: plan.forks.length });
    for (const key of [...plan.ids].reverse()) {
      try {
        const pending = abortSubagent(key);
        perf?.span("abort_dispatch");
        await pending;
      } catch { /* ordinary/idle session */ }
      perf?.span("abort_wait");
      const runtime = getRpcSession(key);
      if (runtime) {
        const pending = runtime.shutdown();
        perf?.span("shutdown_dispatch");
        await pending;
        changed = true;
      }
    }
    perf?.span("shutdown");
    for (const fork of plan.forks) {
      let source: string;
      // No await between the snapshot and atomic replacement: an independent
      // live fork may append in this process and must not lose those entries.
      try { source = readFileSync(fork.path, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      const lines = source.split("\n");
      const header = JSON.parse(lines[0]) as { type?: string; id?: string; parentSession?: string };
      if (header.type !== "session" || header.id !== fork.id) throw new Error("Fork file identity changed. Refresh before deleting.");
      // Recheck the current snapshot before changing the header.
      if (!header.parentSession || sessionPathKey(header.parentSession) !== sessionPathKey(filePath)) continue;
      header.parentSession = parentSessionPath;
      lines[0] = JSON.stringify(header);
      if (parentSessionPath && parentSessionId) {
        for (let index = 1; index < lines.length; index++) {
          let entry: { type?: string; customType?: string; data?: Record<string, unknown> };
          try { entry = JSON.parse(lines[index]); } catch { continue; }
          if (entry?.type !== "custom" || entry.customType !== SUBAGENT_META_TYPE || !entry.data || Array.isArray(entry.data) || typeof entry.data !== "object") continue;
          entry.data = { ...entry.data, parentSessionId, parentSessionPath };
          lines[index] = JSON.stringify(entry); break;
        }
      }
      changed = true;
      try { writePrivateFileAtomicSync(fork.path, lines.join("\n")); }
      finally { invalidateSessionManagerCache(fork.path); }
    }
    perf?.span("reparent", { forks: plan.forks.length });
    for (const key of [...plan.ids].reverse()) {
      const path = plan.paths.get(key) ?? getRpcSession(key)?.sessionFile;
      if (path) {
        try {
          const header = readSessionHeader(path);
          if (header && header.id !== key) throw new Error("Session file identity changed during deletion. Refresh before retrying.");
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        try { await unlink(path); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        invalidateSessionManagerCache(path);
        globalThis.__piDeletionLegacyCache?.delete(sessionPathKey(path));
      }
      invalidateSessionPathCache(key);
      deleted.push(key); changed = true;
    }
    perf?.span("unlink", { deleted: deleted.length });
    return deleted;
  } catch (error) { throw new SessionDeletionError(error, deleted); }
  finally { if (changed) invalidateSessionListCache(); }
}
