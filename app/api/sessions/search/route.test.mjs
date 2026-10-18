import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createTaskTestJiti } from "../../../../lib/__fixtures__/task-jiti.mjs";

const jiti = createTaskTestJiti(import.meta.url);
const { GET } = await jiti.import("./route.ts");
const { GET: list } = await jiti.import("../route.ts");
const { invalidateSessionListCache } = await jiti.import("../../../../lib/session-reader.ts");
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const needle = "task-scoped-search-needle";
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-task-search-http-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  invalidateSessionListCache();
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    invalidateSessionListCache();
    await rm(dir, { recursive: true, force: true });
  });
  const create = async (parent, kind = "subagent") => {
    const manager = SessionManager.create(dir);
    if (parent && kind === "subagent") manager.appendCustomEntry("pi-web:subagent", { version: 1,
      parentSessionId: parent.getSessionId(), parentSessionPath: parent.getSessionFile(), profile: "worker", description: "fixture" });
    manager.appendMessage({ role: "user", content: needle, timestamp: Date.now() });
    if (parent) {
      const file = manager.getSessionFile(), lines = (await readFile(file, "utf8")).split("\n");
      lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), parentSession: parent.getSessionFile() });
      await writeFile(file, lines.join("\n"));
    }
    return manager;
  };
  const file = join(dir, "tasks", "board.json");
  const task = (ids = [], extra = {}) => ({ id: randomUUID(), title: "Task", description: "", completionCriteria: "",
    project: null, columnId: "todo", revision: 1, createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z", sessionIds: ids, ...extra });
  const tasks = async entries => {
    await mkdir(join(dir, "tasks"), { recursive: true });
    await writeFile(file, JSON.stringify({ version: 1, tasks: entries }));
  };
  const prime = async () => {
    invalidateSessionListCache();
    const response = await list(new Request("http://localhost/api/sessions?force=1"));
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).sessions;
  };
  return { dir, file, create, task, tasks, prime };
}
const search = (taskId, options = {}) => {
  const params = new URLSearchParams({ q: options.q ?? needle, ...(options.archive ? { archive: options.archive } : {}) });
  if (taskId !== undefined) params.set("taskId", taskId);
  return GET(new Request(`http://localhost/api/sessions/search?${params}`));
};
async function ids(taskId, options) {
  const response = await search(taskId, options);
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get("cache-control"), "no-store");
  return new Set((await response.json()).results.map(result => result.session.id));
}
const id = manager => manager.getSessionId();

test("task search projects subagent ancestry, respects explicit descendant owners, and never inherits through forks", async t => {
  const f = await fixture(t);
  const root = await f.create(), child = await f.create(root), nested = await f.create(child);
  const override = await f.create(root), overrideChild = await f.create(override);
  const fork = await f.create(root, "fork"), forkChild = await f.create(fork), free = await f.create();
  const a = f.task([id(root)]), b = f.task([id(override)], { archived: true, archiveRevision: 1 });
  await f.tasks([a, b]); await f.prime();
  const bytes = await readFile(f.file), nativeBytes = await Promise.all([root, child, nested, override, overrideChild, fork, forkChild, free].map(m => readFile(m.getSessionFile())));
  assert.deepEqual(await ids(a.id), new Set([root, child, nested].map(id)));
  assert.deepEqual(await ids(b.id), new Set([override, overrideChild].map(id)), "archived tasks are still exact scopes");
  assert.deepEqual(await ids("unlinked"), new Set([fork, forkChild, free].map(id)));
  assert.deepEqual(await ids(), new Set([root, child, nested, override, overrideChild, fork, forkChild, free].map(id)));
  assert.deepEqual(await readFile(f.file), bytes, "legacy task store is not migrated by search");
  assert.deepEqual(await readdir(join(f.dir, "tasks")), ["board.json"]);
  assert.deepEqual(await Promise.all([root, child, nested, override, overrideChild, fork, forkChild, free].map(m => readFile(m.getSessionFile()))), nativeBytes);
});

test("session archive scope intersects task membership and retains the default active scope", async t => {
  const f = await fixture(t), root = await f.create(), child = await f.create(root), active = await f.create();
  const a = f.task([id(root), id(active)]); await f.tasks([a]);
  await writeFile(join(f.dir, "session-archive.json"), JSON.stringify({ version: 1, archivedSessionIds: [id(root)] }));
  await f.prime();
  assert.deepEqual(await ids(a.id), new Set([id(active)]));
  assert.deepEqual(await ids(a.id, { archive: "archived" }), new Set([id(root), id(child)]));
  assert.deepEqual(await ids("unlinked", { archive: "archived" }), new Set());
});

test("missing stores are read-only empty membership: unlinked searches globally but a requested UUID is 404", async t => {
  const f = await fixture(t), root = await f.create(); await f.prime();
  assert.deepEqual(await ids("unlinked"), new Set([id(root)]));
  const response = await search(randomUUID());
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, "not-found");
  await assert.rejects(readFile(f.file), { code: "ENOENT" });
  assert.ok(!(await readdir(f.dir)).includes("tasks"));
});

test("invalid task IDs are rejected, and missing tasks fail closed even for empty queries", async t => {
  const f = await fixture(t); await f.create(); await f.tasks([]); await f.prime();
  for (const taskId of ["", "all", "UNLINKED", "../board.json", "123", `${randomUUID()} `]) {
    const response = await search(taskId);
    assert.equal(response.status, 400, taskId);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  for (const q of [needle, ""]) {
    const response = await search(randomUUID(), { q });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("corrupt or unsupported task stores never widen scoped search, while absent taskId keeps global behavior", async t => {
  const f = await fixture(t), root = await f.create(); await f.tasks([]); await f.prime();
  for (const text of ["{private-corrupt-store", JSON.stringify({ version: 7, tasks: [] }), JSON.stringify({ version: 999, tasks: [] })]) {
    await writeFile(f.file, text);
    for (const taskId of ["unlinked", randomUUID()]) for (const q of [needle, ""]) {
      const response = await search(taskId, { q });
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body = await response.json();
      assert.ok(["storage-unavailable", "unsupported-version"].includes(body.code));
      assert.ok(!JSON.stringify(body).includes("private-corrupt-store"));
    }
    assert.deepEqual(await ids(), new Set([id(root)]));
    assert.equal(await readFile(f.file, "utf8"), text);
    assert.deepEqual(await readdir(join(f.dir, "tasks")), ["board.json"]);
  }
});

test("complete membership filters before both the 500-file scan cap and 30-result cap", async t => {
  const f = await fixture(t), target = await f.create();
  const old = new Date("2020-01-01T00:00:00.000Z"); await utimes(target.getSessionFile(), old, old);
  const directory = join(f.dir, "sessions", "budget-fixture"); await mkdir(directory, { recursive: true });
  const unrelated = [], files = [];
  for (let i = 0; i < 501; i++) {
    const sessionId = randomUUID(); unrelated.push(sessionId);
    const file = join(directory, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`); files.push(file);
    await writeFile(file, [
      { type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd: f.dir },
      { type: "message", id: "message", parentId: null, message: { role: "user", content: needle, timestamp: Date.now() } },
    ].map(entry => JSON.stringify(entry)).join("\n") + "\n");
  }
  const a = f.task([id(target)]), b = f.task(unrelated);
  await f.tasks([...Array.from({ length: 35 }, () => f.task()), b, a]); await f.prime();
  const response = await search(a.id);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.results.map(result => result.session.id), [id(target)]);
  assert.equal(body.truncated, false);
  assert.deepEqual(await ids("unlinked"), new Set(), "all 501 unrelated explicit links must be read before caps");
  // Remove unrelated matches to isolate the file cap from the result cap.
  for (const file of files) await writeFile(file, (await readFile(file, "utf8")).replace(needle, "unrelated nonmatching text"));
  await f.prime();
  const fileCapResponse = await search(a.id);
  assert.equal(fileCapResponse.status, 200);
  const fileCapBody = await fileCapResponse.json();
  assert.deepEqual(fileCapBody.results.map(result => result.session.id), [id(target)]);
  assert.equal(fileCapBody.truncated, false);
});

test("ownerless cycles are unlinked; explicit ownership resolves cycles and descendants without leaking into other scopes", async t => {
  const f = await fixture(t);
  const createCycle = async () => {
    const first = await f.create(), second = await f.create(first);
    const file = first.getSessionFile(), lines = (await readFile(file, "utf8")).trimEnd().split("\n");
    lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), parentSession: second.getSessionFile() });
    lines.splice(1, 0, JSON.stringify({ type: "custom", id: "cycle", parentId: null, timestamp: "2026-01-01T00:00:00.000Z",
      customType: "pi-web:subagent", data: { version: 1, parentSessionId: id(second), parentSessionPath: second.getSessionFile(), profile: "worker", description: "cycle" } }));
    await writeFile(file, lines.join("\n") + "\n");
    return [first, second];
  };
  const freeCycle = await createCycle(), ownedCycle = await createCycle();
  const child = await f.create(ownedCycle[1]), a = f.task([id(ownedCycle[0])]);
  await f.tasks([a]); await f.prime();
  assert.deepEqual(await ids(a.id), new Set([...ownedCycle, child].map(id)));
  assert.deepEqual(await ids("unlinked"), new Set(freeCycle.map(id)));
});
