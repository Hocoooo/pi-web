import { AsyncLocalStorage } from "node:async_hooks";
import { performance as nodePerformance } from "node:perf_hooks";

// Metadata only: callers must use static labels, numeric counts and booleans.
// Never pass bodies, paths, headers, exception messages or credentials.
export type PerfCounts = Record<string, number | boolean>;
export interface ServerPerf {
  readonly requestId: string;
  readonly traceId: string;
  span(name: string, counts?: PerfCounts): void;
  totalMs(): number;
  finish(outcome?: "ok" | "error"): void;
  attach<T extends { headers: Headers }>(response: T): T;
}
const context = new AsyncLocalStorage<ServerPerf>();
const PERF_ENABLED = process.env.PI_WEB_PERF === "1";
export function isServerPerfEnabled(): boolean { return PERF_ENABLED; }
export function currentServerPerf(): ServerPerf | undefined { return context.getStore(); }

export function startServerPerf(route: string, request?: Request): ServerPerf | undefined {
  if (!PERF_ENABLED) return undefined;
  const parent = context.getStore();
  const requestId = crypto.randomUUID().replaceAll("-", "");
  const supplied = request?.headers.get("X-Pi-Perf-Trace");
  const traceId = supplied && /^[a-f0-9]{32}$/.test(supplied) ? supplied : parent?.traceId ?? requestId;
  const startedAt = performance.now();
  const cpu = process.cpuUsage();
  const elu = nodePerformance.eventLoopUtilization();
  let lastMark = startedAt;
  let expected = startedAt + 250;
  let maxEventLoopDelayMs = 0;
  let ended = false;
  let lastPhase = "start";
  const spans = new Map<string, number>();
  const round = (n: number) => Math.round(n * 10) / 10;
  const sample = () => { maxEventLoopDelayMs = Math.max(maxEventLoopDelayMs, performance.now() - expected, 0); };
  const emit = (event: string, extra: object = {}) => {
    try {
      sample();
      const usage = process.cpuUsage(cpu);
      const memorySampleStartedAt = performance.now();
      const memory = process.memoryUsage();
      const memorySampleMs = round(performance.now() - memorySampleStartedAt);
      console.log(JSON.stringify({
        perf: true, route, requestId, traceId, parentRequestId: parent?.requestId,
        timestamp: new Date().toISOString(), event, pid: process.pid, lastPhase,
        totalMs: round(performance.now() - startedAt),
        maxEventLoopDelayMs: round(maxEventLoopDelayMs),
        cpuUserMs: round(usage.user / 1000), cpuSystemMs: round(usage.system / 1000),
        eventLoopUtilization: round(nodePerformance.eventLoopUtilization(elu).utilization * 100) / 100,
        heapUsedMB: round(memory.heapUsed / 1048576), heapTotalMB: round(memory.heapTotal / 1048576),
        rssMB: round(memory.rss / 1048576), memorySampleMs, ...extra,
      }));
    } catch { /* Diagnostics must not break requests. */ }
  };
  // One sampler per operation; no per-file logs. Cleared on success AND failure.
  const sampler = setInterval(() => { sample(); expected = performance.now() + 250; }, 250);
  sampler.unref();
  const waiting = setInterval(() => emit("waiting"), 2000);
  waiting.unref();
  const perf: ServerPerf = {
    requestId, traceId,
    span(name, counts) {
      if (ended) return;
      const now = performance.now();
      const durationMs = now - lastMark;
      spans.set(name, (spans.get(name) ?? 0) + durationMs);
      lastMark = now;
      lastPhase = name;
      emit("phase", { phase: name, durationMs: round(durationMs), counts });
    },
    totalMs: () => performance.now() - startedAt,
    finish(outcome = "ok") {
      if (ended) return;
      clearInterval(sampler);
      clearInterval(waiting);
      emit("end", { outcome, phases: Object.fromEntries([...spans].map(([name, ms]) => [name, round(ms)])) });
      ended = true;
    },
    attach(response) {
      try {
        const timing = [...spans].map(([name, ms]) => `${name};dur=${ms.toFixed(1)}`);
        timing.push(`total;dur=${perf.totalMs().toFixed(1)}`);
        response.headers.set("Server-Timing", timing.join(", "));
        response.headers.set("X-Pi-Perf-Trace", traceId);
        response.headers.set("X-Pi-Perf-Request", requestId);
      } catch { /* Immutable responses are still valid. */ }
      perf.finish("status" in response && typeof response.status === "number" && response.status >= 400 ? "error" : "ok");
      return response;
    },
  };
  emit("start");
  return perf;
}

/** Preserve async context across SDK awaits without adding options to SDK APIs. */
export async function withServerPerf<T>(perf: ServerPerf | undefined, action: () => Promise<T>): Promise<T> {
  if (!perf) return action();
  try { return await context.run(perf, action); }
  catch (error) { perf.finish("error"); throw error; }
  finally { perf.finish(); }
}

/** Route errors/early returns also close samplers and receive correlation headers. */
export function instrumentRoute<A extends unknown[]>(route: string, handler: (req: Request, ...args: A) => Promise<Response>) {
  return async (req: Request, ...args: A): Promise<Response> => {
    const perf = startServerPerf(route, req);
    return withServerPerf(perf, async () => {
      const response = await handler(req, ...args);
      return perf?.attach(response) ?? response;
    });
  };
}
