import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createJiti } from "jiti";

process.env.PI_WEB_PERF = "1";
const jiti = createJiti(import.meta.url);
const reader = await jiti.import("./session-reader.ts");
const scanner = await jiti.import("./session-list-scanner.ts");
const { startServerPerf, withServerPerf } = await jiti.import("./perf.ts");
const originalScan = scanner.listSessionsIncremental;
let scan = originalScan;
scanner.listSessionsIncremental = (...args) => scan(...args);

function setup(t) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const root = fs.mkdtempSync(join(tmpdir(), "pi-list-perf-"));
  process.env.PI_CODING_AGENT_DIR = root;
  const reset = () => {
    scanner.resetSessionScanIndexForTests();
    globalThis.__piSessionListCache = undefined;
    globalThis.__piSessionListPromise = undefined;
    globalThis.__piSessionListPromiseGeneration = undefined;
    globalThis.__piSessionListGeneration = 0;
    globalThis.__piSessionPathCache = undefined;
    globalThis.__piPathToSessionIdCache = undefined;
  };
  reset();
  const events = [];
  t.mock.method(console, "log", text => events.push(JSON.parse(text)));
  t.after(() => {
    scan = originalScan;
    reset();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const dir = join(root, "sessions", "private-project");
  fs.mkdirSync(dir, { recursive: true });
  const path = join(dir, "private-session.jsonl");
  fs.writeFileSync(path, [
    { type: "session", version: 3, id: "private-session", cwd: join(root, "chat-workspace"), timestamp: "2026-01-01T00:00:00Z" },
    { type: "message", id: "entry", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "private-body" } },
  ].map(JSON.stringify).join("\n") + "\n");
  return { events, root, path };
}

const phases = (events, route) => events.filter(e => e.route === route && e.event === "phase");
const starts = (events, route) => events.filter(e => e.route === route && e.event === "start");
function assertFinished(events) {
  for (const start of events.filter(e => e.event === "start")) {
    assert.equal(events.filter(e => e.requestId === start.requestId && e.event === "end").length, 1);
  }
}

test("list diagnostics aggregate cold/warm/deferred scans with independent child scopes and no private data", async t => {
  const { events, root } = setup(t);
  await withServerPerf(startServerPerf("test.list"), async () => {
    await reader.listSessionSummaries();
    await reader.listAllSessions();
    await reader.listAllSessions();
    await reader.listSessionSummaries();
  });
  const scans = starts(events, "session_scanner.incremental");
  assert.equal(scans.length, 3);
  for (const scan of scans) {
    assert.deepEqual(events.filter(e => e.requestId === scan.requestId && e.event === "phase").map(e => e.phase),
      ["index_load", "enumerate", "stat", "classify", "hydrate", "sort"]);
    assert.equal(scan.traceId, events[0].traceId);
    assert.notEqual(scan.parentRequestId, scan.requestId);
  }
  const classified = phases(events, "session_scanner.incremental").filter(e => e.phase === "classify");
  assert.deepEqual(classified.map(e => [e.counts.hits, e.counts.misses, e.counts.deferred]), [[0, 1, 1], [0, 1, 0], [1, 0, 0]]);
  assert.equal(starts(events, "session_scanner.index_persist").length, 1);
  const persist = starts(events, "session_scanner.index_persist")[0];
  assert.equal(persist.parentRequestId, scans[1].requestId);
  assert.deepEqual(phases(events, "session_reader.build_list").slice(0, 3).map(e => e.phase), ["path_index", "map_relations", "projects"]);
  assert.ok(phases(events, "session_reader.list_all").some(e => e.phase === "fresh"));
  assert.equal(starts(events, "session_reader.attach_projects").length, 3);
  assertFinished(events);
  const serialized = JSON.stringify(events);
  for (const secret of [root, "private-project", "private-session", "private-body", ".jsonl"]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  for (const event of events) for (const value of Object.values(event.counts ?? {})) {
    assert.ok(typeof value === "number" || typeof value === "boolean");
  }
});

test("join and stale callers have separate wait scopes without additional scans", async t => {
  const { events } = setup(t);
  let release;
  let calls = 0;
  scan = () => { calls++; return new Promise(resolve => { release = resolve; }); };
  const first = reader.listAllSessions();
  const joined = reader.listAllSessions();
  assert.equal(calls, 1);
  release([]);
  assert.deepEqual(await Promise.all([first, joined]), [[], []]);
  assert.deepEqual(phases(events, "session_reader.list_all").filter(e => e.phase.startsWith("join")).map(e => e.phase), ["join", "join_wait"]);
  reader.invalidateSessionListCache();
  assert.deepEqual(await reader.listAllSessions({ allowStale: true }), []);
  assert.equal(calls, 2);
  const stale = phases(events, "session_reader.list_all").find(e => e.phase === "stale");
  assert.ok(events.some(e => e.requestId === stale.requestId && e.event === "end"));
  const pending = globalThis.__piSessionListPromise;
  release([]);
  await pending;
  // Allow the background caller's scope to finish after its tracked promise.
  await new Promise(resolve => setImmediate(resolve));
  assertFinished(events);
});

test("list errors close each scope without logging raw errors", async t => {
  const { events } = setup(t);
  const error = new Error("private-error-body/path");
  scan = async () => { throw error; };
  await assert.rejects(reader.listAllSessions(), e => e === error);
  assertFinished(events);
  assert.ok(events.filter(e => e.event === "end").every(e => e.outcome === "error"));
  assert.equal(JSON.stringify(events).includes(error.message), false);
});

test("parallel summary/full listings keep sibling scopes separate", async t => {
  const { events } = setup(t);
  await withServerPerf(startServerPerf("test.parallel"), () => Promise.all([
    reader.listSessionSummaries(), reader.listAllSessions(), reader.attachSessionProjectInfo([]),
  ]));
  const parent = starts(events, "test.parallel")[0];
  const summary = starts(events, "session_reader.summaries")[0];
  const full = starts(events, "session_reader.list_all")[0];
  assert.equal(summary.parentRequestId, parent.requestId);
  assert.equal(full.parentRequestId, parent.requestId);
  const independentProjects = starts(events, "session_reader.attach_projects").filter(e => e.parentRequestId === parent.requestId);
  assert.equal(independentProjects.length, 1);
  assert.notEqual(summary.requestId, full.requestId);
  const scans = starts(events, "session_scanner.incremental");
  assert.equal(scans.length, 2);
  assert.notEqual(scans[0].parentRequestId, scans[1].parentRequestId);
  for (const event of events) assert.equal(event.traceId, parent.traceId);
  assertFinished(events);
});

test("index persistence failure is best effort and closes its independent scope", async t => {
  const { events, root } = setup(t);
  fs.mkdirSync(join(root, "pi-web-session-index.json"));
  const rows = await originalScan();
  assert.equal(rows.length, 1);
  const persist = starts(events, "session_scanner.index_persist")[0];
  assert.ok(persist);
  assert.equal(events.find(e => e.requestId === persist.requestId && e.event === "end").outcome, "error");
  assert.equal(events.find(e => e.route === "session_scanner.incremental" && e.event === "end").outcome, "ok");
  assertFinished(events);
  assert.equal(JSON.stringify(events).includes(root), false);
});

test("disabled diagnostics produce no logs or timers", () => {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { createJiti } from "jiti";
    const jiti = createJiti(${JSON.stringify(import.meta.url)});
    const reader = await jiti.import("./session-reader.ts");
    console.log = () => { throw new Error("unexpected log"); };
    globalThis.setInterval = () => { throw new Error("unexpected timer"); };
    globalThis.__piSessionListCache = { data: [], ts: Date.now(), generation: 0 };
    await reader.listAllSessions();
    await reader.attachSessionProjectInfo([]);
  `], { encoding: "utf8", env: { ...process.env, PI_WEB_PERF: "0" }, timeout: 30000 });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "");
});
