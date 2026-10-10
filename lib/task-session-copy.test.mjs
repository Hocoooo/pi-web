import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from "node:fs/promises";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { taskOperation } = await jiti.import("./task-operations.ts");
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { copySessionWithTask } = await jiti.import("./task-session-copy.ts");
const { withTaskStore } = await jiti.import("./task-store.ts");
const { publishContext } = await jiti.import("./task-context.ts");
const { appendSessionToolSelection, readSessionToolSelection } = await jiti.import("./session-tool-selection.ts");
const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }], api: "fixture", provider: "fixture", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "copy-"));
  assert.notEqual(spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root }).status, 0);
  const prior = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = root;
  t.after(async () => { if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior; await rm(root, { recursive: true, force: true }); });
  const chat = join(root, "chat-workspace"), project = join(root, "project"); await mkdir(chat); await mkdir(project);
  return { root, chat, project, options: { agentDir: root }, file: join(root, "tasks", "board.json") };
}
function source(f, cwd = f.chat) {
  const manager = SessionManager.create(cwd);
  appendSessionToolSelection(manager, ["read"]);
  manager.appendModelChange("fixture", "source-model");
  const first = manager.appendMessage({ role: "user", content: "synthetic source", timestamp: Date.now() });
  manager.appendMessage(assistant("completed response"));
  // Factual inherited history is not latest task knowledge nor a new model invocation.
  manager.appendCustomMessageEntry("fixture-shared-context", "historical version one", false, { versionId: "v1" });
  const second = manager.appendMessage({ role: "user", content: "fork here", timestamp: Date.now() });
  manager.appendMessage(assistant("second response"));
  return { manager, first, second, leaf: manager.getLeafId() };
}
function wrapper(t, s, running = false) {
  const state = { shutdowns: 0, prompts: 0, navigations: 0 };
  const inner = { sessionId: s.manager.getSessionId(), sessionFile: s.manager.getSessionFile(), sessionManager: s.manager,
    isStreaming: running, isCompacting: false, isBashRunning: false, pendingMessageCount: 0,
    extensionRunner: { emit: async () => {} }, agent: { state: {} }, settingsManager: { getDefaultTools() { return ["read"]; } },
    async navigateTree(id) { state.navigations++; s.manager.branch(id); return { cancelled: false }; },
    getActiveToolNames() { return ["read"]; }, getAllTools() { return [{ name: "read" }]; }, setActiveToolsByName() {},
    async prompt() { state.prompts++; throw new Error("must not prompt"); }, dispose() { state.shutdowns++; },
  };
  const w = new AgentSessionWrapper(inner); t.after(() => w.destroy());
  return { w, state, inner };
}
async function task(f, s) {
  return (await taskOperation({ action: "createFromSession", id: randomUUID(), title: "Linked", description: "", completionCriteria: "", sourceSessionId: s.manager.getSessionId() }, f.options)).task;
}
async function child(f, id) { const list = await SessionManager.listAll(); const found = list.find((s) => s.id === id); assert.ok(found); return SessionManager.open(found.path); }
function fresh(f, request) {
  const script = `import {createJiti} from 'jiti'; const {taskOperation}=await createJiti(import.meta.url).import('./lib/task-operations.ts'); console.log(JSON.stringify(await taskOperation(JSON.parse(process.argv[1]),{agentDir:process.argv[2],sessionCopy:true})));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(request), f.root], { cwd: process.cwd(), env: process.env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
}

for (const kind of ["fork", "fork_branch", "clone"]) {
  for (const project of [false, true]) test(`${kind}: native SDK child inherits exactly one ${project ? "project" : "chat"} task, history/loadout and restart receipt`, async (t) => {
    const f = await fixture(t), s = source(f, project ? f.project : f.chat), linked = await task(f, s), { w, state } = wrapper(t, s, kind !== "clone");
    const oldHistory = await readFile(s.manager.getSessionFile()), oldBoard = await taskOperation({ action: "list" }, f.options);
    // Pre-suspension knowledge remains readable, but public publication is suspended.
    await withTaskStore(f.root, document => {
      publishContext(document.tasks.find(t => t.id === linked.id).sharedContext, { action: "publish-context", id: linked.id, operationId: randomUUID(), expectedCurrentVersionId: null, content: { goal: "latest version two", decisions: "", progress: "", nextSteps: "" } });
      return { value: null, changed: true };
    });
    const command = { type: kind, operationId: randomUUID(), ...(kind === "clone" ? { leafId: s.leaf } : { entryId: s.second }) };
    const result = await w.send(command), copied = await child(f, result.newSessionId);
    assert.equal(result.cancelled, false); assert.equal(copied.getHeader().parentSession, s.manager.getSessionFile());
    assert.equal(copied.getCwd(), s.manager.getCwd()); assert.deepEqual(readSessionToolSelection(copied.getEntries()), ["read"]);
    assert.deepEqual(copied.getEntries(), s.manager.getBranch(kind === "fork" ? s.manager.getEntry(s.second).parentId : kind === "clone" ? s.leaf : s.second));
    assert.ok(copied.getEntries().some((e) => e.customType === "fixture-shared-context"));
    assert.ok(!JSON.stringify(copied.getEntries()).includes("latest version two"));
    assert.deepEqual(await readFile(s.manager.getSessionFile()), oldHistory);
    const board = fresh(f, { action: "list" }), saved = board.tasks.find((x) => x.id === linked.id);
    assert.deepEqual(saved.sessionIds, [s.manager.getSessionId(), result.newSessionId]); assert.equal(saved.revision, linked.revision + 1);
    assert.equal(board.orderRevision, oldBoard.orderRevision); assert.equal(board.columnsRevision, oldBoard.columnsRevision);
    assert.equal(state.prompts, 0); assert.equal(state.shutdowns, kind === "clone" ? 1 : 0);
    const before = await readFile(f.file);
    // New wrapper models an HTTP retry after the source's idle shutdown / server reopen.
    const again = wrapper(t, s, kind !== "clone"); assert.deepEqual(await again.w.send(command), result);
    assert.deepEqual(await readFile(f.file), before); assert.equal((await SessionManager.listAll()).length, 2);
    const detail = await taskOperation({ action: "sessions", id: linked.id }, f.options); assert.equal(detail.linked.length, 2);
  });
}

test("original agent POST route projects actual SDK copy success, exact duplicate and structured relation failure", async (t) => {
  const f = await fixture(t), s = source(f); await task(f, s);
  const { POST } = await jiti.import("../app/api/agent/[id]/route.ts");
  const registry = globalThis.__piSessions ??= new Map(); t.after(() => registry.delete(s.manager.getSessionId()));
  const params = { params: Promise.resolve({ id: s.manager.getSessionId() }) };
  const post = (command) => POST(new Request("http://localhost/api/agent/fixture", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command) }), params);
  for (const type of ["fork", "fork_branch", "clone"]) {
    const { w } = wrapper(t, s); registry.set(s.manager.getSessionId(), w);
    const command = { type, operationId: randomUUID(), ...(type === "clone" ? { leafId: s.leaf } : { entryId: s.second }) };
    const response = await post(command); assert.equal(response.status, 200); const body = await response.json();
    assert.equal(body.success, true); assert.equal(body.data.cancelled, false); assert.ok(body.data.newSessionId);
    const replacement = wrapper(t, s); registry.set(s.manager.getSessionId(), replacement.w);
    assert.deepEqual(await (await post(command)).json(), body);
  }
  assert.equal((await taskOperation({ action: "list" }, f.options)).tasks[0].sessionIds.length, 4);
  const { w } = wrapper(t, s); registry.set(s.manager.getSessionId(), w);
  const original = SessionManager.prototype.createBranchedSession;
  SessionManager.prototype.createBranchedSession = function (leaf) { const file = original.call(this, leaf); chmodSync(join(f.root, "tasks"), 0o500); return file; };
  const command = { type: "fork_branch", operationId: randomUUID(), entryId: s.leaf };
  try {
    const response = await post(command), body = await response.json(); assert.equal(response.status, 500);
    assert.equal(body.success, undefined); assert.equal(body.code, "session_copy_unconfirmed");
    assert.equal(body.operationId, command.operationId); assert.equal(body.taskCode, "storage-unavailable"); assert.ok(body.newSessionId);
  } finally { SessionManager.prototype.createBranchedSession = original; await chmod(join(f.root, "tasks"), 0o700); }
  assert.equal((await post(command)).status, 200); assert.equal((await SessionManager.listAll()).length, 5);
});

test("root fork keeps existing native message-free behavior and task relation", async (t) => {
  const f = await fixture(t), s = source(f), linked = await task(f, s), { w } = wrapper(t, s);
  const result = await w.send({ type: "fork", entryId: s.first, operationId: randomUUID() });
  const copied = await child(f, result.newSessionId);
  assert.equal(copied.getEntries().some((e) => e.type === "message"), false);
  assert.equal((await taskOperation({ action: "list" }, f.options)).tasks[0].sessionIds.length, linked.sessionIds.length + 1);
});

test("unowned source copies and ordinary New remain unowned; same-session navigation changes no relationship", async (t) => {
  const f = await fixture(t), s = source(f), { w, state } = wrapper(t, s);
  await taskOperation({ action: "create", id: randomUUID(), title: "Nearby task", description: "", completionCriteria: "", cwd: null }, f.options);
  const results = [];
  for (const type of ["fork", "fork_branch", "clone"]) {
    const copy = wrapper(t, s);
    results.push(await copy.w.send({ type, operationId: randomUUID(), ...(type === "clone" ? { leafId: s.leaf } : { entryId: s.second }) }));
  }
  source(f); // Ordinary SDK New in the very same cwd is never inferred from task selection.
  assert.equal((await taskOperation({ action: "list" }, f.options)).tasks[0].sessionIds.length, 0);
  await task(f, s); const bytes = await readFile(f.file);
  await w.send({ type: "navigate_tree", targetId: s.first });
  assert.equal(state.navigations, 1); assert.deepEqual(await readFile(f.file), bytes);
  assert.ok(!(await taskOperation({ action: "list" }, f.options)).tasks.some((task) => results.some((result) => task.sessionIds.includes(result.newSessionId))));
});

test("concurrent duplicate requests make one child and one relation; changed payload conflicts", async (t) => {
  const f = await fixture(t), s = source(f); await task(f, s);
  const { w } = wrapper(t, s, true), command = { type: "fork_branch", entryId: s.leaf, operationId: randomUUID() };
  const results = await Promise.all([w.send(command), w.send(command), w.send(command)]);
  assert.deepEqual(results[0], results[1]); assert.deepEqual(results[0], results[2]);
  assert.equal((await SessionManager.listAll()).length, 2);
  await assert.rejects(w.send({ ...command, entryId: s.first }), (e) => e.taskCode === "conflict");
  assert.equal((await taskOperation({ action: "list" }, f.options)).tasks[0].sessionIds.length, 2);
});

test("source ownership CAS rejects unowned->linked race without hanging child on the new task", async (t) => {
  const f = await fixture(t), s = source(f); let copies = 0;
  const command = { type: "fork_branch", entryId: s.leaf, operationId: randomUUID() };
  await assert.rejects(copySessionWithTask(f.root, s.manager.getSessionId(), command, async () => {
    copies++; const path = SessionManager.open(s.manager.getSessionFile()).createBranchedSession(s.leaf);
    await task(f, s);
    return { cancelled: false, newSessionId: SessionManager.open(path).getSessionId() };
  }), (e) => e.taskCode === "conflict" && !!e.newSessionId);
  await assert.rejects(copySessionWithTask(f.root, s.manager.getSessionId(), command, async () => { copies++; throw new Error("duplicate"); }), (e) => e.taskCode === "conflict");
  assert.equal(copies, 1); assert.equal((await taskOperation({ action: "list" }, f.options)).tasks[0].sessionIds.length, 1);
});

test("authority rechecks cached same-path Git replacement and refuses stale task scope", async (t) => {
  const f = await fixture(t); execFileSync("git", ["init", f.project]);
  execFileSync("git", ["-C", f.project, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture"]);
  const worktree = join(f.root, "copytree"); execFileSync("git", ["-C", f.project, "worktree", "add", "-b", "fixture-copy", worktree]);
  const s = source(f, worktree); await task(f, s);
  const { resolveProject } = await jiti.import("./worktree.ts"); await resolveProject(worktree);
  await assert.rejects(copySessionWithTask(f.root, s.manager.getSessionId(), { type: "fork_branch", entryId: s.leaf, operationId: randomUUID() }, async () => {
    const path = SessionManager.open(s.manager.getSessionFile()).createBranchedSession(s.leaf);
    execFileSync("git", ["-C", f.project, "worktree", "remove", worktree]); await mkdir(worktree); execFileSync("git", ["init", worktree]);
    return { cancelled: false, newSessionId: SessionManager.open(path).getSessionId() };
  }), (e) => e.taskCode === "invalid-input" && !!e.newSessionId);
  assert.equal((await taskOperation({ action: "list" }, f.options)).tasks[0].sessionIds.length, 1);
});

test("real storage permission failure after SDK creation retries the exact child without source shutdown or duplication", async (t) => {
  const f = await fixture(t), s = source(f); await task(f, s); let copies = 0;
  const command = { type: "fork_branch", entryId: s.leaf, operationId: randomUUID() };
  try {
    await assert.rejects(copySessionWithTask(f.root, s.manager.getSessionId(), command, async () => {
      copies++; const path = SessionManager.open(s.manager.getSessionFile()).createBranchedSession(s.leaf);
      await chmod(join(f.root, "tasks"), 0o500);
      return { cancelled: false, newSessionId: SessionManager.open(path).getSessionId() };
    }), (e) => e.taskCode === "storage-unavailable" && !!e.newSessionId);
  } finally { await chmod(join(f.root, "tasks"), 0o700); }
  assert.equal((await taskOperation({ action: "list" }, f.options)).tasks[0].sessionIds.length, 1);
  const result = await copySessionWithTask(f.root, s.manager.getSessionId(), command, async () => { copies++; throw new Error("must not recopy"); });
  assert.equal(copies, 1); assert.equal((await SessionManager.listAll()).length, 2);
  assert.ok((await taskOperation({ action: "list" }, f.options)).tasks[0].sessionIds.includes(result.newSessionId));
});

test("runtime clone relation-write failure keeps source alive; exact retry finishes original child then performs only the normal idle shutdown", async (t) => {
  const f = await fixture(t), s = source(f); await task(f, s); const { w, state } = wrapper(t, s);
  const original = SessionManager.prototype.createBranchedSession; let copies = 0;
  SessionManager.prototype.createBranchedSession = function (leaf) { const file = original.call(this, leaf); copies++; chmodSync(join(f.root, "tasks"), 0o500); return file; };
  const command = { type: "clone", leafId: s.leaf, operationId: randomUUID() };
  try {
    await assert.rejects(w.send(command), (e) => e.taskCode === "storage-unavailable" && !!e.newSessionId);
    assert.equal(state.shutdowns, 0); assert.equal(state.prompts, 0); assert.equal(w.isAlive(), true);
  } finally { SessionManager.prototype.createBranchedSession = original; await chmod(join(f.root, "tasks"), 0o700); }
  const result = await w.send(command); assert.equal(copies, 1); assert.equal(state.shutdowns, 1);
  assert.equal((await SessionManager.listAll()).length, 2);
  assert.ok((await taskOperation({ action: "list" }, f.options)).tasks[0].sessionIds.includes(result.newSessionId));
});

test("interrupted prepared outcome after fresh process fails explicitly, never creates a duplicate", async (t) => {
  const f = await fixture(t), s = source(f), command = { type: "fork_branch", entryId: s.leaf, operationId: randomUUID() };
  await assert.rejects(copySessionWithTask(f.root, s.manager.getSessionId(), command, async () => { throw new Error("simulated SDK failure"); }), /simulated SDK failure/);
  let copies = 0;
  await assert.rejects(copySessionWithTask(f.root, s.manager.getSessionId(), command, async () => { copies++; }), /outcome is unknown/);
  const script = `import {createJiti} from 'jiti'; const {copySessionWithTask}=await createJiti(import.meta.url).import('./lib/task-session-copy.ts'); try {await copySessionWithTask(process.argv[1],process.argv[2],JSON.parse(process.argv[3]),()=>{throw new Error('unexpected creation')});} catch(e) { console.log(e.message); }`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script, f.root, s.manager.getSessionId(), JSON.stringify(command)], { env: process.env, encoding: "utf8" });
  assert.equal(r.status, 0); assert.match(r.stdout, /outcome is unknown/); assert.equal(copies, 0);
  assert.equal((await SessionManager.listAll()).length, 1);
});

test("additive receipt migration preserves v4 board, rejects present corruption and hides internal receipts", async (t) => {
  const f = await fixture(t), s = source(f); await task(f, s);
  const board = await taskOperation({ action: "list" }, f.options), raw = JSON.parse(await readFile(f.file)); raw.version = 4; delete raw.sessionRelations; delete raw.sessionCopies;
  await writeFile(f.file, JSON.stringify(raw)); assert.deepEqual(fresh(f, { action: "list" }), board);
  assert.deepEqual(JSON.parse(await readFile(f.file)).sessionCopies, []);
  for (const bad of [null, {}, [{ operationId: randomUUID() }]]) {
    await writeFile(f.file, JSON.stringify({ ...raw, sessionCopies: bad })); const bytes = await readFile(f.file);
    await assert.rejects(taskOperation({ action: "list" }, f.options), { code: "storage-unavailable" }); assert.deepEqual(await readFile(f.file), bytes);
  }
  await assert.rejects(taskOperation({ action: "prepare-session-copy", operationId: randomUUID(), sourceSessionId: s.manager.getSessionId(), fingerprint: "0".repeat(64) }, f.options), { code: "invalid-input" });
});
