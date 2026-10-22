import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { readSubagentRun } from "./subagents";
import type { SessionEntry } from "./types";
import type { LegacyScanMetrics } from "./session-legacy-scan";

// One cold-scan worker per process, including across Next hot reloads. Each plan
// already limits file concurrency to four. Cache-hit-only plans start no worker.
declare global { var __piLegacyWorkerTail: Promise<void> | undefined; }
async function acquireWorker(): Promise<() => void> {
  const prior = globalThis.__piLegacyWorkerTail ?? Promise.resolve();
  let release!: () => void;
  globalThis.__piLegacyWorkerTail = new Promise<void>(resolve => { release = resolve; });
  await prior;
  return release;
}

/** Read-only scanning in a separate V8 heap. Never fall back to blocking the
 * large server heap on worker failure; deletion fails before removing files. */
export function createLegacyScanWorker() {
  let worker: Worker | undefined;
  let opening: Promise<void> | undefined;
  let release: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let nextKey = 0;
  let failure: Error | undefined;
  let closing = false;
  const pending = new Map<number, {
    resolve: (value: { entry?: SessionEntry; metrics: LegacyScanMetrics }) => void;
    reject: (error: Error) => void;
  }>();
  const fail = (error: Error) => {
    failure ??= error;
    for (const request of pending.values()) request.reject(failure);
    pending.clear();
  };
  const open = () => opening ??= (async () => {
    release = await acquireWorker();
    if (closing) throw new Error("Session relation scan already closed.");
    // Both next dev and the installed launcher run with the package root cwd.
    // bin/ is shipped in npm files; Next standalone tracing includes these files.
    worker = new Worker(join(process.cwd(), "bin", "session-legacy-worker.cjs"), {
      execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    worker.on("message", (result: { key: number; entry?: SessionEntry; metrics: LegacyScanMetrics; error?: { code?: string; message: string } }) => {
      const request = pending.get(result.key);
      if (!request) return;
      pending.delete(result.key);
      if (result.error) request.reject(Object.assign(new Error(result.error.message), { code: result.error.code }));
      else request.resolve(result);
    });
    worker.on("error", () => fail(new Error("Session relation worker failed; retry deletion.")));
    worker.on("exit", () => { if (!closing) fail(new Error("Session relation worker exited before completion.")); });
    timer = setTimeout(() => {
      fail(new Error("Session relation scan exceeded its time budget; no deletion performed."));
      void worker?.terminate();
    }, 120_000);
    timer.unref();
  })();
  return {
    async scan(node: { id: string; path: string }, metrics: LegacyScanMetrics): Promise<string | undefined> {
      await open();
      if (failure) throw failure;
      if (closing) throw new Error("Session relation scan already closed.");
      const key = ++nextKey;
      const result = await new Promise<{ entry?: SessionEntry; metrics: LegacyScanMetrics }>((resolve, reject) => {
        pending.set(key, { resolve, reject });
        try { worker!.postMessage({ key, node: { id: node.id, path: node.path } }); }
        catch (error) { pending.delete(key); reject(error); }
      });
      for (const name of ["bytesRead", "lines", "parsedLines", "candidateLines"] as const) metrics[name] += result.metrics[name];
      if (!result.entry) return undefined;
      const child = readSubagentRun([result.entry], node.id, node.path);
      if (!child) throw new Error("Cannot safely identify a related subagent session.");
      return child.parentSessionId;
    },
    async close(): Promise<void> {
      closing = true;
      try { await opening; } catch { /* preserve the original scan error */ }
      clearTimeout(timer);
      try { if (worker) await worker.terminate(); }
      finally { fail(new Error("Session relation scan closed.")); release?.(); }
    },
  };
}
