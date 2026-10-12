import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { PUT: setArchive } = await jiti.import("./[id]/archive/route.ts");
const { GET: listSessions } = await jiti.import("./route.ts");
const { GET: sessionDetail } = await jiti.import("./[id]/route.ts");
const { GET: searchSessions } = await jiti.import("./search/route.ts");
const { GET: runningSessions } = await jiti.import("../agent/running/route.ts");
const { taskOperation } = await jiti.import("../../../lib/task-operations.ts");
const { invalidateSessionListCache, invalidateSessionPathCache, invalidateSessionManagerCache } = await jiti.import("../../../lib/session-reader.ts");

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-session-archive-integration-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  invalidateSessionListCache();
  const ids = [];
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    for (const id of ids) invalidateSessionPathCache(id);
    invalidateSessionListCache();
    await rm(dir, { recursive: true, force: true });
  });
  const create = (parent) => {
    const manager = SessionManager.create(dir);
    if (parent) manager.appendCustomEntry("pi-web:subagent", { version: 1, parentSessionId: parent.getSessionId(), parentSessionPath: parent.getSessionFile(), profile: "worker", description: "Archived family fixture" });
    manager.appendMessage({ role: "user", content: "archive-search-needle older history", timestamp: Date.now() });
    manager.appendMessage({ role: "assistant", content: [{ type: "thinking", thinking: "Private preserved thinking" }, { type: "text", text: "Preserved answer" }, { type: "toolCall", id: "read-call", name: "read", arguments: { path: "fixture.md" } }], timestamp: Date.now() });
    manager.appendMessage({ role: "toolResult", toolCallId: "read-call", toolName: "read", content: [{ type: "text", text: "Complete tool output" }], isError: false, timestamp: Date.now() });
    ids.push(manager.getSessionId());
    invalidateSessionListCache();
    return manager;
  };
  return { dir, create };
}
const list = async (summary = false) => {
  const response = await listSessions(new Request(`http://localhost/api/sessions${summary ? "?summary=1" : "?force=1"}`));
  assert.equal(response.status, 200);
  return response.json();
};
const detail = async id => {
  const response = await sessionDetail(new Request(`http://localhost/api/sessions/${id}?tail=1000`), { params: Promise.resolve({ id }) });
  assert.equal(response.status, 200);
  return response.json();
};
const archive = async (id, archived) => {
  const response = await setArchive(new Request(`http://localhost/api/sessions/${id}/archive`, { method: "PUT", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ archived }) }), { params: Promise.resolve({ id }) });
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  return response.json();
};
const search = async scope => {
  const response = await searchSessions(new Request(`http://localhost/api/sessions/search?q=archive-search-needle${scope ? `&archive=${scope}` : ""}`));
  assert.equal(response.status, 200);
  return response.json();
};

test("real API archive/restore preserves JSONL, full history/tree, task metadata, catalog identity and list versions", async t => {
  const f = await fixture(t);
  const manager = f.create(), id = manager.getSessionId(), file = manager.getSessionFile();
  const taskFile = join(f.dir, "tasks", "board.json");
  const linked = await taskOperation({ action: "createFromSession", id: randomUUID(), title: "Archive does not unlink", description: "", completionCriteria: "", sourceSessionId: id }, { agentDir: f.dir });
  const taskBytes = await readFile(taskFile), bytes = await readFile(file);
  const before = await detail(id), initial = await list();
  assert.equal(initial.sessions.find(s => s.id === id).archived, false);
  await archive(id, true);
  const archived = await list();
  assert.equal(archived.sessions.length, 1, "canonical catalog retains archived session for URL/task navigation");
  assert.equal(archived.sessions[0].archived, true);
  assert.ok(archived.sessionListVersion > initial.sessionListVersion);
  assert.equal((await list(true)).sessions[0].archived, true, "cheap summary also carries archive state");
  const poll = await (await runningSessions()).json();
  assert.equal(poll.sessionListVersion, archived.sessionListVersion);
  assert.deepEqual(await readFile(file), bytes);
  assert.deepEqual(await readFile(taskFile), taskBytes);
  const owner = await taskOperation({ action: "session-task", sessionId: id }, { agentDir: f.dir });
  assert.equal(owner.task.id, linked.task.id);
  assert.equal(owner.task.archived, false, "session archive must not archive its task");
  const after = await detail(id);
  assert.deepEqual(after.context, before.context);
  assert.deepEqual(after.tree, before.tree);
  assert.equal(after.sessionId, before.sessionId);
  assert.equal(after.filePath, before.filePath);
  assert.equal(after.leafId, before.leafId);
  assert.equal((await list()).sessions[0].archived, true, "reading does not auto-restore");
  assert.deepEqual((await search()).results, []);
  assert.equal((await search("archived")).results[0].session.id, id);
  await archive(id, false);
  const restored = await list();
  assert.equal(restored.sessions[0].archived, false);
  assert.equal((await search()).results[0].session.id, id);
  assert.deepEqual((await search("archived")).results, []);
  assert.deepEqual(await readFile(file), bytes);
  assert.deepEqual(await readFile(taskFile), taskBytes);
});

test("all branches, images, thinking, tool results, compaction, usage and custom entries remain byte-exact", async t => {
  const f = await fixture(t), manager = f.create();
  const first = manager.getEntries().find(e => e.type === "message");
  manager.branch(first.id);
  const keep = manager.appendMessage({ role: "user", content: [{ type: "text", text: "Independent branch" }, { type: "image", data: "RklYVFVSRQ==", mimeType: "image/png" }], timestamp: Date.now() });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Second branch answer" }], timestamp: Date.now() });
  manager.appendCompaction("Preserved compaction summary", keep, 500);
  manager.appendCustomEntry("fixture:history", { preserved: "arbitrary extension record" });
  manager.appendUsage("cache_warm", "fixture", "fixture", { input: 4, output: 2, cacheRead: 3, cacheWrite: 0, totalTokens: 9, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  const id = manager.getSessionId(), file = manager.getSessionFile(), bytes = await readFile(file);
  invalidateSessionListCache();
  const before = await detail(id);
  for (const archived of [true, false]) {
    await archive(id, archived);
    assert.deepEqual(await readFile(file), bytes);
    const after = await detail(id);
    assert.deepEqual(after.tree, before.tree);
    assert.deepEqual(after.context, before.context);
    assert.deepEqual(after.stats, before.stats);
    assert.equal(after.leafId, before.leafId);
  }
});

test("nested persisted subagents follow archive scope, remain readable, and cannot be independently archived", async t => {
  const f = await fixture(t), root = f.create(), child = f.create(root), nested = f.create(child);
  for (const [manager, parent] of [[child, root], [nested, child]]) {
    const path = manager.getSessionFile();
    const lines = (await readFile(path, "utf8")).split("\n");
    lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), parentSession: parent.getSessionFile() });
    await writeFile(path, lines.join("\n"));
    invalidateSessionManagerCache(path);
  }
  invalidateSessionListCache();
  const bytes = await Promise.all([root, child, nested].map(m => readFile(m.getSessionFile())));
  const before = await detail(nested.getSessionId());
  await archive(root.getSessionId(), true);
  const catalog = await list();
  assert.equal(catalog.sessions.length, 3);
  assert.ok(catalog.sessions.every(s => s.archived), JSON.stringify(catalog.sessions.map(({ id, archived, relation }) => ({ id, archived, relation }))));
  assert.ok((await list(true)).sessions.every(s => s.archived), "summary preserves descendant visibility");
  assert.deepEqual((await search()).results, []);
  assert.deepEqual(new Set((await search("archived")).results.map(r => r.session.id)), new Set([root, child, nested].map(m => m.getSessionId())));
  const after = await detail(nested.getSessionId());
  assert.deepEqual(after.context, before.context);
  assert.deepEqual(after.tree, before.tree);
  const rejected = await setArchive(new Request(`http://localhost/api/sessions/${child.getSessionId()}/archive`, { method: "PUT", body: JSON.stringify({ archived: false }) }), { params: Promise.resolve({ id: child.getSessionId() }) });
  assert.equal(rejected.status, 400);
  await archive(root.getSessionId(), false);
  assert.ok((await list()).sessions.every(s => !s.archived));
  assert.deepEqual(await Promise.all([root, child, nested].map(m => readFile(m.getSessionFile()))), bytes);
});

test("archive flags are fresh over stale search metadata and new fork IDs remain independent", async t => {
  const f = await fixture(t), original = f.create(), fork = f.create();
  const path = fork.getSessionFile();
  const lines = (await readFile(path, "utf8")).split("\n");
  lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), parentSession: original.getSessionFile() });
  await writeFile(path, lines.join("\n"));
  invalidateSessionManagerCache(path);
  invalidateSessionListCache();
  await list();
  await archive(original.getSessionId(), true);
  const catalog = await list();
  assert.equal(catalog.sessions.find(s => s.id === original.getSessionId()).archived, true);
  assert.equal(catalog.sessions.find(s => s.id === fork.getSessionId()).archived, false);
  assert.deepEqual((await search()).results.map(r => r.session.id), [fork.getSessionId()]);
  const invalid = await searchSessions(new Request("http://localhost/api/sessions/search?q=x&archive=oops"));
  assert.equal(invalid.status, 400);
});
