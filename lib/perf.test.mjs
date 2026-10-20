import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createJiti } from "jiti";
process.env.PI_WEB_PERF = "1";
const jiti = createJiti(import.meta.url);
const { startServerPerf, currentServerPerf, withServerPerf, instrumentRoute } = await jiti.import("./perf.ts");

test("request correlation reaches nested async operations, headers and metadata-only records", async t => {
  const records = [];
  t.mock.method(console, "log", line => records.push(JSON.parse(line)));
  const traceId = "a".repeat(32);
  const route = instrumentRoute("POST /api/agent/new", async () => {
    const root = currentServerPerf();
    root.span("body_parse", { ensureOnly: true });
    await withServerPerf(startServerPerf("runtime.start"), async () => {
      await Promise.resolve();
      assert.equal(currentServerPerf().traceId, traceId);
      currentServerPerf().span("settings", { entries: 12 });
    });
    assert.equal(currentServerPerf(), root);
    return new Response("SECRET_BODY", { status: 201 });
  });
  const response = await route(new Request("http://localhost/SECRET_PATH?token=SECRET_QUERY", {
    headers: { "X-Pi-Perf-Trace": traceId, Authorization: "SECRET_AUTH" },
  }));
  assert.equal(response.headers.get("X-Pi-Perf-Trace"), traceId);
  assert.match(response.headers.get("X-Pi-Perf-Request"), /^[a-f0-9]{32}$/);
  assert.match(response.headers.get("Server-Timing"), /body_parse;dur=/);
  assert.equal(records.filter(r => r.event === "end").length, 2);
  assert.ok(records.every(r => r.traceId === traceId));
  const child = records.find(r => r.route === "runtime.start");
  assert.equal(child.parentRequestId, response.headers.get("X-Pi-Perf-Request"));
  assert.ok(!JSON.stringify(records).includes("SECRET"));
  assert.equal(currentServerPerf(), undefined);
});

test("invalid client ids are not echoed and overlapping requests keep separate contexts", async t => {
  const records = [];
  t.mock.method(console, "log", line => records.push(JSON.parse(line)));
  const route = instrumentRoute("GET /api/sessions", async () => {
    const before = currentServerPerf();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(currentServerPerf(), before);
    return new Response();
  });
  const responses = await Promise.all(["SECRET_INVALID", "b".repeat(32)].map(id => route(new Request("http://localhost/", { headers: { "X-Pi-Perf-Trace": id } }))));
  assert.notEqual(responses[0].headers.get("X-Pi-Perf-Trace"), responses[1].headers.get("X-Pi-Perf-Trace"));
  assert.equal(responses[1].headers.get("X-Pi-Perf-Trace"), "b".repeat(32));
  assert.ok(!JSON.stringify(records).includes("SECRET"));
});

test("errors and early error responses finish once and stop periodic logs", async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const records = [];
  t.mock.method(console, "log", line => records.push(JSON.parse(line)));
  const failing = instrumentRoute("test.failure", async () => {
    t.mock.timers.tick(2000);
    throw new Error("SECRET_ERROR");
  });
  await assert.rejects(failing(new Request("http://localhost/")), /SECRET_ERROR/);
  assert.equal(records.at(-1).outcome, "error");
  assert.ok(records.some(r => r.event === "waiting"));
  const count = records.length;
  t.mock.timers.tick(10000);
  assert.equal(records.length, count);
  const early = instrumentRoute("test.early", async () => new Response(null, { status: 400 }));
  await early(new Request("http://localhost/"));
  assert.equal(records.at(-1).outcome, "error");
  assert.equal(records.filter(r => r.event === "end").length, 2);
  assert.ok(!JSON.stringify(records).includes("SECRET"));
});

test("broken log sink cannot change response or operation outcome", async t => {
  t.mock.method(console, "log", () => { throw new Error("sink unavailable"); });
  const route = instrumentRoute("test.sink", async () => {
    currentServerPerf().span("work");
    return new Response("ok");
  });
  assert.equal(await (await route(new Request("http://localhost/"))).text(), "ok");
});

test("disabled instrumentation creates no samplers, logs or headers", () => {
  const script = `import {createJiti} from 'jiti';
    const jiti=createJiti(import.meta.url);const m=await jiti.import('./lib/perf.ts');
    globalThis.setInterval=()=>{throw new Error('timer created')};
    console.log=()=>{throw new Error('log created')};
    if(m.startServerPerf('test')!==undefined)throw new Error('enabled');
    const r=await m.instrumentRoute('test',async()=>new Response('ok'))(new Request('http://localhost/'));
    if(r.headers.has('X-Pi-Perf-Trace')||await r.text()!=='ok')throw new Error('response changed');`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, PI_WEB_PERF: "0" } });
  assert.equal(result.status, 0, result.stderr);
});
