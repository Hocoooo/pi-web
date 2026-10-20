import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { diagnosticFetch, startClientTrace } = await jiti.import("./latency-trace.ts");

function setup(t, enabled = true) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: { getItem: () => enabled ? "1" : null } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "window", previous); else delete globalThis.window; });
  const records = [];
  t.mock.method(console, "info", (_, line) => records.push(JSON.parse(line)));
  return records;
}

test("disabled client measurement preserves fetch arguments exactly", async t => {
  const records = setup(t, false);
  const input = "/api/agent/new";
  const init = { method: "POST", headers: { "Content-Type": "application/json" }, body: "SECRET" };
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, input); assert.equal(options, init); return new Response("ok");
  });
  await diagnosticFetch("new_runtime", input, init);
  assert.equal(records.length, 0);
});

test("client fetch correlates headers without consuming bodies or logging request data", async t => {
  const records = setup(t);
  const signal = new AbortController().signal;
  const init = { method: "POST", signal, headers: { "Content-Type": "application/json", Authorization: "SECRET" }, body: "SECRET_BODY" };
  t.mock.method(globalThis, "fetch", async (input, options) => {
    assert.equal(input, "/SECRET_PATH");
    assert.equal(options.body, init.body); assert.equal(options.signal, signal);
    assert.equal(options.headers.get("Authorization"), "SECRET");
    assert.match(options.headers.get("X-Pi-Perf-Trace"), /^[a-f0-9]{32}$/);
    return new Response('{"secret":"SECRET_RESULT"}', { headers: { "X-Pi-Perf-Request": "c".repeat(32) } });
  });
  const trace = startClientTrace("session_load");
  const response = await diagnosticFetch("session_detail", "/SECRET_PATH", init, trace);
  assert.equal(response.bodyUsed, false);
  assert.equal((await response.json()).secret, "SECRET_RESULT");
  trace.mark("json_ready", { counts: { messages: 2 } });
  trace.mark("state_applied");
  trace.end("ok");
  assert.deepEqual(records.map(r => r.stage), ["start", "response", "json_ready", "state_applied", "end"]);
  assert.equal(new Set(records.map(r => r.traceId)).size, 1);
  assert.equal(records[1].requestId, "c".repeat(32));
  assert.ok(!JSON.stringify(records).includes("SECRET"));
  assert.equal(init.headers["X-Pi-Perf-Trace"], undefined);
});

test("fetch rejection closes the owned trace without logging the error", async t => {
  const records = setup(t);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("SECRET_FAILURE"); });
  await assert.rejects(diagnosticFetch("new_runtime", "/api/agent/new"), /SECRET_FAILURE/);
  assert.equal(records.at(-1).stage, "end");
  assert.equal(records.at(-1).outcome, "error");
  assert.ok(!JSON.stringify(records).includes("SECRET"));
});
