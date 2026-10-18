// Execute the actual route with the real temp-dir store/IO, and only catalogue/response adapters injected.
// The explicit dependency allowlist fails if the route acquires any AgentSession/rpc-manager dependency.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { createJiti } from "jiti";

const sandbox = await mkdtemp(join(tmpdir(), "pi-web-session-archive-route-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = sandbox;
test.after(async () => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  await rm(sandbox, { recursive: true, force: true });
});
const archive = await createJiti(import.meta.url, { moduleCache: false }).import("../../../../../lib/session-archive.ts");
const routeSource = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(routeSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

async function fixture(t) {
  const root = await mkdtemp(join(sandbox, "case-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = randomUUID(), file = join(root, `${id}.jsonl`), calls = [];
  const history = Buffer.from(`${JSON.stringify({ type: "session", version: 3, id, cwd: "/fixture" })}\n{"type":"message","PRIVATE":"private transcript"}\n`);
  await writeFile(file, history);
  const state = { path: file, catalogue: [{ id, path: file }], freshCatalogue: null, storageError: null, resolveError: null, statError: null };
  const modules = {
    "node:fs/promises": { lstat: async path => { calls.push(["stat", path]); if (state.statError) throw state.statError; return lstat(path); } },
    "next/server": { NextResponse: { json: (value, init) => Response.json(value, init) } },
    "@/lib/session-reader": {
      resolveSessionPath: async sessionId => { calls.push(["resolve", sessionId]); if (state.resolveError) throw state.resolveError; return state.path; },
      listAllSessions: async options => { calls.push(["catalogue", options]); return options?.force && state.freshCatalogue ? state.freshCatalogue : state.catalogue; },
      invalidateSessionListCache: () => calls.push(["invalidate"]),
    },
    "@/lib/session-archive": {
      ...archive,
      setSessionArchived: async (sessionId, archived) => {
        calls.push(["write", sessionId, archived]);
        if (state.storageError) throw state.storageError;
        await archive.setSessionArchived(sessionId, archived, root);
      },
    },
  };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    require(name) { assert.ok(Object.hasOwn(modules, name), `Unexpected route dependency: ${name}`); return modules[name]; },
  });
  const put = (body, sessionId = id) => exports.PUT(new Request(`http://localhost/api/sessions/${sessionId}/archive`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: sessionId }) });
  return { root, id, file, history, calls, state, put, PUT: exports.PUT };
}

test("archive/restore persisted root (including live root) writes metadata then invalidates, never native history", async t => {
  const f = await fixture(t);
  // Running state is intentionally irrelevant to this metadata-only endpoint.
  f.state.catalogue[0].running = true;
  for (const archived of [true, true, false, false]) {
    f.calls.length = 0;
    const response = await f.put({ archived });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, sessionId: f.id, archived });
    assert.deepEqual(f.calls.map(call => call[0]), ["resolve", "stat", "catalogue", "write", "invalidate"]);
    assert.equal((await archive.readArchivedSessionIds(f.root)).has(f.id), archived);
    assert.deepEqual(await readFile(f.file), f.history);
  }
});

test("fork roots may be archived, but persisted subagents must use their parent conversation", async t => {
  const f = await fixture(t);
  f.state.catalogue[0].relation = { kind: "fork", originSessionId: randomUUID() };
  assert.equal((await f.put({ archived: true })).status, 200);
  f.calls.length = 0;
  const bytes = await readFile(archive.getSessionArchivePath(f.root));
  f.state.catalogue[0].relation = { kind: "subagent", parentSessionId: randomUUID() };
  for (const archived of [true, false]) {
    const response = await f.put({ archived });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Archive or restore the parent conversation instead." });
  }
  assert.ok(!f.calls.some(call => ["write", "invalidate"].includes(call[0])));
  assert.deepEqual(await readFile(archive.getSessionArchivePath(f.root)), bytes);
});

test("refreshes a catalogue miss so a newly persisted subagent is not independently archived", async t => {
  const f = await fixture(t);
  f.state.catalogue = [];
  f.state.freshCatalogue = [{ id: f.id, path: f.file, relation: { kind: "subagent", parentSessionId: randomUUID() } }];
  const response = await f.put({ archived: true });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Archive or restore the parent conversation instead." });
  const lookups = f.calls.filter(call => call[0] === "catalogue");
  assert.equal(lookups.length, 2);
  assert.equal(lookups[1][1].force, true);
  assert.ok(!f.calls.some(call => ["write", "invalidate"].includes(call[0])));
});

test("a regular cached file missing from the fresh catalog is not treated as a valid session", async t => {
  const f = await fixture(t);
  f.state.catalogue = [];
  f.state.freshCatalogue = [];
  assert.equal((await f.put({ archived: true })).status, 404);
  assert.ok(!f.calls.some(call => ["write", "invalidate"].includes(call[0])));
  assert.deepEqual(await readFile(f.file), f.history);
});

test("exact boolean body and safe UUID required before resolving or writing", async t => {
  const f = await fixture(t);
  for (const body of [null, [], true, 1, "true", {}, { archived: null }, { archived: "true" }, { archived: 1 }, { archived: true, extra: 1 }, { sessionId: f.id, archived: true }, { "__proto__": true }]) {
    const response = await f.put(body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  for (const id of ["../escape", "__proto__", "constructor", "not-a-session", f.id + "\n"]) assert.equal((await f.put({ archived: true }, id)).status, 400);
  const invalid = await f.PUT(new Request("http://localhost/archive", { method: "PUT", body: "PRIVATE not JSON" }), { params: Promise.resolve({ id: f.id }) });
  assert.equal(invalid.status, 400);
  assert.doesNotMatch(JSON.stringify(await invalid.json()), /PRIVATE/);
  assert.deepEqual(f.calls, []);
  await assert.rejects(lstat(archive.getSessionArchivePath(f.root)), { code: "ENOENT" });
});

test("404 for nonexistent or cached transient file; cached path/catalogue cannot establish persistence", async t => {
  const f = await fixture(t);
  f.state.path = null;
  assert.equal((await f.put({ archived: true })).status, 404);
  f.state.path = f.file;
  await rm(f.file);
  assert.equal((await f.put({ archived: true })).status, 404);
  await mkdir(f.file);
  assert.equal((await f.put({ archived: false })).status, 404);
  await rm(f.file, { recursive: true });
  const target = join(f.root, "target.jsonl");
  await writeFile(target, f.history);
  try { await symlink(target, f.file); }
  catch (error) { if (process.platform === "win32" && error.code === "EPERM") { t.skip("symlink privilege unavailable"); return; } throw error; }
  assert.equal((await f.put({ archived: true })).status, 404);
  assert.deepEqual(await readFile(target), f.history);
  assert.ok(!f.calls.some(call => ["write", "invalidate", "catalogue"].includes(call[0])));
  await assert.rejects(lstat(archive.getSessionArchivePath(f.root)), { code: "ENOENT" });
});

test("bad/unknown metadata remains untouched and errors never expose its source", async t => {
  const f = await fixture(t);
  const file = archive.getSessionArchivePath(f.root);
  for (const text of ['{"PRIVATE":"secret transcript","version":1,', JSON.stringify({ version: 99, archivedSessionIds: [f.id], PRIVATE: "secret" })]) {
    await writeFile(file, text);
    const response = await f.put({ archived: true });
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.ok(["invalid-storage", "unsupported-version"].includes(body.code));
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE|secret|case-|session-archive-route-/);
    assert.equal(await readFile(file, "utf8"), text);
  }
  assert.ok(!f.calls.some(call => call[0] === "invalidate"));
  assert.deepEqual(await readFile(f.file), f.history);
});

test("typed storage-unavailable is 503; invalid input is 400; all errors skip invalidation", async t => {
  const f = await fixture(t);
  for (const [code, status] of [["storage-unavailable", 503], ["invalid-input", 400]]) {
    f.state.storageError = new archive.SessionArchiveError(code);
    const response = await f.put({ archived: true });
    assert.equal(response.status, status);
    assert.equal((await response.json()).code, code);
  }
  f.state.storageError = new Error("PRIVATE /private/path raw internal error");
  const response = await f.put({ archived: true });
  assert.equal(response.status, 500);
  assert.doesNotMatch(JSON.stringify(await response.json()), /PRIVATE|private\/path|raw internal/);
  assert.ok(!f.calls.some(call => call[0] === "invalidate"));
});

test("filesystem and resolution errors are masked; ENOTDIR is a missing session", async t => {
  const f = await fixture(t);
  for (const field of ["resolveError", "statError"]) {
    f.state[field] = new Error("PRIVATE source JSON /private/path");
    const response = await f.put({ archived: true });
    assert.equal(response.status, 500);
    assert.doesNotMatch(JSON.stringify(await response.json()), /PRIVATE|source JSON|private\/path/);
    f.state[field] = null;
  }
  f.state.statError = Object.assign(new Error("PRIVATE"), { code: "ENOTDIR" });
  assert.equal((await f.put({ archived: true })).status, 404);
  assert.ok(!f.calls.some(call => ["write", "invalidate"].includes(call[0])));
});
