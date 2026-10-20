export type LatencyStage = "start" | "payload" | "response" | "provider_event" | "stream_ready" | "first_event" | "first_output" | "runtime_ready" | "task_ready" | "seed_ready" | "waiting" | "json_ready" | "state_applied" | "state_ready" | "end";
export type LatencyRecord = {
  scope: "model_request" | "new_session" | "session_load" | "http_request" | "session_list";
  traceId: string;
  timestamp: string;
  stage: LatencyStage;
  elapsedMs: number;
  maxEventLoopDelayMs: number;
  outcome?: "stop" | "toolUse" | "length" | "error" | "aborted" | "other" | "ok" | "cancelled";
  status?: number;
  requestId?: string;
  operation?: "new_runtime" | "session_list" | "session_detail" | "session_state";
  counts?: Record<string, number | boolean>;
};
export type LatencySink = (record: LatencyRecord) => void;

/** Metadata only. Never pass payloads, URLs, headers, paths or error objects here. */
export function startLatencyTrace(
  scope: LatencyRecord["scope"],
  sink: LatencySink,
  now: () => number = () => performance.now(),
) {
  const started = now();
  // getRandomValues also works on plain-HTTP LAN pages (randomUUID may not).
  const traceId = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)),
    byte => byte.toString(16).padStart(2, "0")).join("");
  let expected = started + 250;
  let maxEventLoopDelayMs = 0;
  let nextWaiting = started + 10_000;
  let ended = false;
  const sample = () => {
    maxEventLoopDelayMs = Math.max(maxEventLoopDelayMs, now() - expected, 0);
  };
  const mark = (stage: LatencyStage, extra: Pick<LatencyRecord, "status" | "outcome" | "requestId" | "operation" | "counts"> = {}) => {
    if (ended) return;
    sample();
    // Diagnostics must never break navigation or a provider stream.
    try {
      sink({ scope, traceId, timestamp: new Date().toISOString(), stage,
        elapsedMs: Math.round(Math.max(0, now() - started)),
        maxEventLoopDelayMs: Math.round(maxEventLoopDelayMs), ...extra });
    } catch { /* best effort */ }
  };
  const timer = setInterval(() => {
    sample();
    expected = now() + 250;
    if (now() >= nextWaiting) {
      mark("waiting");
      nextWaiting = now() + 10_000;
    }
  }, 250);
  // Node timers should not keep a headless process alive; browsers return a number.
  if (typeof timer === "object" && "unref" in timer) timer.unref();
  mark("start");
  return {
    traceId,
    mark,
    end(outcome: LatencyRecord["outcome"]) {
      if (ended) return;
      clearInterval(timer);
      mark("end", { outcome });
      ended = true;
    },
  };
}

export function startClientTrace(scope: "new_session" | "session_load" | "http_request" | "session_list") {
  try {
    if (typeof window !== "undefined" && window.localStorage.getItem("pi-web:perf") === "1") {
      return startLatencyTrace(scope, record => console.info("[pi-web:perf]", JSON.stringify(record)));
    }
  } catch { /* localStorage may be unavailable */ }
  return undefined;
}

export function startNewSessionTrace() { return startClientTrace("new_session"); }

/** Headers-only latency; callers measure body/JSON and state application separately. */
export async function diagnosticFetch(
  operation: NonNullable<LatencyRecord["operation"]>,
  input: RequestInfo | URL,
  init?: RequestInit,
  parent?: ReturnType<typeof startClientTrace>,
): Promise<Response> {
  const trace = parent ?? startClientTrace("http_request");
  if (!trace) return fetch(input, init);
  try {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set("X-Pi-Perf-Trace", trace.traceId);
    const response = await fetch(input, { ...init, headers });
    const requestId = response.headers.get("X-Pi-Perf-Request");
    trace.mark("response", { operation, status: response.status,
      ...(requestId && /^[a-f0-9]{32}$/.test(requestId) ? { requestId } : {}) });
    if (!parent) trace.end(response.ok ? "ok" : "error");
    return response;
  } catch (error) {
    if (!parent) trace.end("error");
    throw error;
  }
}
