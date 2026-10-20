import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { createJiti } from "jiti";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
const jiti = createJiti(import.meta.url);
const { createRequestPerformanceTracker } = await jiti.import("./request-performance.ts");
const { startLatencyTrace, startNewSessionTrace } = await jiti.import("./latency-trace.ts");
const model = { api: "test", provider: "SECRET_PROVIDER", id: "SECRET_MODEL" };
const message = () => ({ role: "assistant", api: "test", provider: model.provider, model: model.id,
  timestamp: 1, content: [], stopReason: "stop", usage: { input: 0, output: 0, totalTokens: 0,
    cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });

test("request diagnostics separate preparation, headers, raw event and first output without leaking data", async () => {
  let clock = 0;
  const records = [];
  const calls = [];
  const replacement = { secret: "SECRET_REPLACEMENT" };
  const tracker = createRequestPerformanceTracker(() => clock, record => records.push(record));
  const upstream = createAssistantMessageEventStream();
  let captured;
  const controller = new AbortController();
  const options = { apiKey: "SECRET_KEY", signal: controller.signal, temperature: .5,
    onPayload: async payload => { calls.push(payload); return replacement; },
    onResponse: response => { calls.push(response); },
    onProviderStreamEvent: async event => { calls.push(event); },
  };
  const stream = tracker.wrap((_model, _context, opts) => { captured = opts; return upstream; })(model,
    { messages: [{ role: "user", content: "SECRET_PROMPT" }] }, options);
  await tick();
  assert.equal(captured.apiKey, options.apiKey);
  assert.equal(captured.signal, options.signal);
  assert.equal(captured.temperature, options.temperature);
  clock = 100;
  const payload = { prompt: "SECRET_PAYLOAD" };
  assert.equal(await captured.onPayload(payload, model), replacement);
  clock = 9000;
  const response = { status: 200, headers: { authorization: "SECRET_HEADER" } };
  await captured.onResponse(response, model);
  clock = 9500;
  const raw = { text: "SECRET_RAW_EVENT" };
  await captured.onProviderStreamEvent(raw, model);
  await captured.onProviderStreamEvent(raw, model);
  const partial = message();
  upstream.push({ type: "start", partial });
  await tick();
  clock = 11000;
  upstream.push({ type: "text_delta", contentIndex: 0, delta: "SECRET_OUTPUT", partial });
  await tick();
  clock = 12000;
  upstream.push({ type: "done", reason: "stop", message: message() });
  const result = await stream.result();
  assert.equal(result.piWebPerformance.ttftMs, 11000);
  assert.deepEqual(calls, [payload, response, raw, raw]);
  assert.deepEqual(records.map(r => r.stage), ["start", "stream_ready", "payload", "response", "provider_event", "first_event", "first_output", "end"]);
  assert.equal(records.find(r => r.stage === "response").elapsedMs, 9000);
  assert.equal(records.find(r => r.stage === "response").status, 200);
  assert.equal(records.find(r => r.stage === "first_output").elapsedMs, 11000);
  assert.equal(records.at(-1).outcome, "stop");
  assert.equal(new Set(records.map(r => r.traceId)).size, 1);
  assert.ok(!JSON.stringify(records).includes("SECRET"));
});

test("provider/callback failure closes diagnostics without logging the exception", async () => {
  const records = [];
  const stream = createRequestPerformanceTracker(() => 0, r => records.push(r)).wrap(async (_m, _c, options) => {
    await options.onPayload({}, model);
    throw new Error("unreachable");
  })(model, { messages: [] }, { onPayload: () => { throw new Error("SECRET_FAILURE"); } });
  const result = await stream.result();
  assert.equal(result.stopReason, "error");
  assert.equal(result.errorMessage, "SECRET_FAILURE");
  assert.equal(records.at(-1).outcome, "error");
  assert.ok(!JSON.stringify(records).includes("SECRET"));
});

test("observer failures cannot break a stream and each request gets a distinct id", async () => {
  const ids = new Set();
  const tracker = createRequestPerformanceTracker(() => 0, record => { ids.add(record.traceId); throw new Error("sink down"); });
  for (let i = 0; i < 2; i++) {
    const stream = tracker.wrap(() => { const s = createAssistantMessageEventStream(); s.end(message()); return s; })(model, { messages: [] });
    assert.equal((await stream.result()).stopReason, "stop");
  }
  assert.equal(ids.size, 2);
});

test("browser opt-in is read per invocation and unavailable storage is harmless", t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const records = [];
  let enabled = null;
  t.mock.method(console, "info", (_prefix, json) => records.push(JSON.parse(json)));
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    localStorage: { getItem: key => { assert.equal(key, "pi-web:perf"); return enabled; } },
  } });
  try {
    assert.equal(startNewSessionTrace(), undefined);
    enabled = "1";
    const trace = startNewSessionTrace();
    assert.ok(trace);
    trace.end("ok");
    assert.deepEqual(records.map(r => r.stage), ["start", "end"]);
    assert.ok(records.every(r => r.scope === "new_session"));
    enabled = null;
    assert.equal(startNewSessionTrace(), undefined);
    window.localStorage.getItem = () => { throw new Error("blocked storage"); };
    assert.equal(startNewSessionTrace(), undefined);
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else delete globalThis.window;
  }
});

test("heartbeat records event-loop delay and stops on every terminal outcome", t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let clock = 0;
  const records = [];
  const trace = startLatencyTrace("new_session", r => records.push(r), () => clock);
  clock = 10_000;
  t.mock.timers.tick(250);
  assert.equal(records.at(-1).stage, "waiting");
  assert.equal(records.at(-1).maxEventLoopDelayMs, 9750);
  trace.mark("runtime_ready");
  trace.mark("task_ready");
  trace.end("cancelled");
  const length = records.length;
  clock = 30_000;
  t.mock.timers.tick(20_000);
  trace.end("error");
  trace.mark("seed_ready");
  assert.equal(records.length, length);
  assert.equal(records.at(-1).outcome, "cancelled");
});
