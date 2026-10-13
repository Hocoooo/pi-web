import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { taskOperation } = await jiti.import("./task-operations.ts");
const { taskSessionCatalogue, sameTaskSessionProject } = await jiti.import("./task-sessions.ts");
const { projectIdentityKey } = await jiti.import("./project-identity.ts");
const { AgentSessionWrapper, getRunningRpcSessionIds, getRpcSessionActivity } = await jiti.import("./rpc-manager.ts");
const { appendSessionToolSelection } = await jiti.import("./session-tool-selection.ts");
const create = (extra = {}) => ({ action: "create", id: randomUUID(), title: "Task", description: "Original", completionCriteria: "User checks", cwd: null, ...extra });
async function fixture(t) {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-web-task-sessions-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => { process.env.PI_CODING_AGENT_DIR = previous ?? ""; if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; await rm(agentDir, { recursive: true, force: true }); });
  const chat = join(agentDir, "chat-workspace"), project = join(agentDir, "project");
  await mkdir(chat); await mkdir(project);
  const options = { agentDir }, file = join(agentDir, "tasks", "board.json");
  return { agentDir, chat, project, options, file };
}
async function session(f, cwd, name = "Fixture chat") {
  // Let the SDK encode native paths, including Windows drives and separators.
  const manager = SessionManager.create(cwd);
  manager.appendMessage({ role: "user", content: "synthetic history", timestamp: Date.now() });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "synthetic reply" }], api: "test", provider: "test", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
  manager.appendSessionInfo(name);
  return manager;
}
const link = (task, managers) => ({ action: "link", id: task.id, expectedRevision: task.revision, sessionIds: managers.map((manager) => typeof manager === "string" ? manager : manager.getSessionId()) });
function fresh(input, agentDir) {
  const script = `import {createJiti} from 'jiti'; const {taskOperation}=await createJiti(import.meta.url).import('./lib/task-operations.ts'); try {console.log(JSON.stringify({value:await taskOperation(JSON.parse(process.argv[1]),{agentDir:process.argv[2]})}));} catch(e) {console.log(JSON.stringify({code:e.code}));}`;
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" }; for (const key of ["PI_PACKAGE_DIR", "JITI_ALIAS", "JITI_RESOLVE_ALIAS"]) delete env[key];
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(input), agentDir], { cwd: process.cwd(), env });
    let output = "", errors = ""; child.stdout.on("data", (d) => output += d); child.stderr.on("data", (d) => errors += d);
    child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(errors)));
  });
}

test("source create binds real SDK identity atomically, preserves history/loadout and immutable retries after edits/deletion", async (t) => {
  const f = await fixture(t), source = await session(f, f.project);
  source.appendModelChange("fixture", "synthetic-model-no-provider");
  appendSessionToolSelection(source, ["read"]);
  const bytes = await readFile(source.getSessionFile());
  const request = { action: "createFromSession", id: randomUUID(), title: "From source", description: "No inference", completionCriteria: "User approves", sourceSessionId: source.getSessionId() };
  const result = await taskOperation(request, f.options);
  assert.equal(result.task.project.cwd, f.project); assert.deepEqual(result.task.sessionIds, [source.getSessionId()]);
  assert.equal(result.task.columnId, "todo"); assert.deepEqual(await readFile(source.getSessionFile()), bytes);
  const edited = await taskOperation({ action: "edit", id: request.id, expectedRevision: 1, title: "Edited", description: "Later", completionCriteria: "Updated", priority: 3, labels: ["fixture"] }, f.options);
  assert.deepEqual((await fresh(request, f.agentDir)).value, edited);
  await assert.rejects(taskOperation({ ...request, id: randomUUID() }, f.options), { code: "conflict" });
  await assert.rejects(taskOperation({ ...request, sourceSessionId: randomUUID() }, f.options), { code: "conflict" });
  await unlink(source.getSessionFile());
  assert.deepEqual((await fresh(request, f.agentDir)).value, edited);
  await assert.rejects(taskOperation({ ...request, id: randomUUID() }, f.options), { code: "not-found" });
  const detail = await taskOperation({ action: "sessions", id: request.id }, f.options);
  assert.deepEqual(detail.linked, [{ id: source.getSessionId(), missing: true, running: false, relationGeneration: 0, updateRevision: 0 }]);
});

test("bulk links use actual main/worktree project identities and no-project chat isolation", async (t) => {
  const f = await fixture(t);
  execFileSync("git", ["init", f.project]);
  execFileSync("git", ["-C", f.project, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "fixture"]);
  const worktree = join(f.agentDir, "worktree"); execFileSync("git", ["-C", f.project, "worktree", "add", "-b", "linked", worktree]);
  const main = await session(f, f.project), branch = await session(f, worktree), chat = await session(f, f.chat);
  const task = (await taskOperation(create({ cwd: f.project }), f.options)).task;
  const linked = await taskOperation(link(task, [main, branch, main]), f.options);
  assert.deepEqual(linked.task.sessionIds, [main.getSessionId(), branch.getSessionId()]);
  assert.equal(linked.task.revision, 2); assert.equal(linked.board.orderRevision, 1);
  const bytes = await readFile(f.file, "utf8");
  assert.deepEqual((await fresh(link(task, [main, branch]), f.agentDir)).value, linked);
  assert.equal(await readFile(f.file, "utf8"), bytes);
  await assert.rejects(taskOperation(link(linked.task, [chat]), f.options), { code: "invalid-input" });
  const free = (await taskOperation(create(), f.options)).task;
  await assert.rejects(taskOperation(link(free, [chat, main]), f.options), { code: "invalid-input" });
  const chatLinked = await taskOperation(link(free, [chat]), f.options);
  assert.equal(chatLinked.task.project, null);
  const sourceChat = await session(f, f.chat);
  const fromChat = await taskOperation({ action: "createFromSession", id: randomUUID(), title: "Independent", description: "", completionCriteria: "", sourceSessionId: sourceChat.getSessionId() }, f.options);
  assert.equal(fromChat.task.project, null);
  assert.deepEqual((await fresh({ action: "list" }, f.agentDir)).value.tasks, [linked.task, chatLinked.task, fromChat.task]);
  const detail = await taskOperation({ action: "sessions", id: fromChat.task.id }, f.options);
  assert.equal(detail.linked[0].cwd, undefined, "hidden chat workspace is not exposed as a project path");
  assert.deepEqual(detail.candidates, []);
});

test("entire illegal/deleted/other-owner batch rejects without partial links or bytes/revision/order changes", async (t) => {
  const f = await fixture(t), a = await session(f, f.chat), b = await session(f, f.chat), gone = await session(f, f.chat);
  const foreign = await session(f, f.project);
  const task = (await taskOperation(create(), f.options)).task;
  const other = (await taskOperation(create({ title: "Other" }), f.options)).task;
  await taskOperation(link(other, [b]), f.options);
  // Prime the scanner's persisted name/details index before deletion, then verify absence.
  const { listSessionsIncremental } = await jiti.import("./session-list-scanner.ts");
  await listSessionsIncremental(); await unlink(gone.getSessionFile());
  const saved = await readFile(f.file, "utf8");
  for (const [ids, code] of [[[a, foreign], "invalid-input"], [[a, b], "conflict"], [[a, gone], "not-found"], [[a, randomUUID()], "not-found"], [[a, "../../sessions"], "invalid-input"]]) {
    await assert.rejects(taskOperation(link(task, ids), f.options), { code }); assert.equal(await readFile(f.file, "utf8"), saved);
  }
  for (const ids of [[], Array(1), [a.getSessionId(), , b.getSessionId()], null, Array(101).fill(a.getSessionId())]) {
    await assert.rejects(taskOperation({ ...link(task, [a]), sessionIds: ids }, f.options), { code: "invalid-input" });
    assert.equal(await readFile(f.file, "utf8"), saved);
  }
  await assert.rejects(taskOperation({ ...link(task, [a]), expectedRevision: 2 }, f.options), { code: "conflict" });
  const candidates = await taskOperation({ action: "sessions", id: task.id }, f.options);
  assert.deepEqual(candidates.candidates.map((s) => s.id), [a.getSessionId()]);
  assert.deepEqual(candidates.linked, []);
});

test("two fresh processes competing for one source yield one owner, including source-create vs link", async (t) => {
  const f = await fixture(t), source = await session(f, f.chat), task = (await taskOperation(create(), f.options)).task;
  const requests = [link(task, [source]), { action: "createFromSession", id: randomUUID(), title: "Contender", description: "", completionCriteria: "", sourceSessionId: source.getSessionId() }];
  const results = await Promise.all(requests.map((input) => fresh(input, f.agentDir)));
  assert.equal(results.filter((r) => r.value).length, 1); assert.equal(results.find((r) => r.code).code, "conflict");
  const board = await taskOperation({ action: "list" }, f.options);
  assert.equal(board.tasks.filter((task) => task.sessionIds.includes(source.getSessionId())).length, 1);
});

test("v2 migration retains 03 receipt/order and 02 fields; v4 malformed or double ownership refuses byte-for-byte", async (t) => {
  const f = await fixture(t), task = (await taskOperation(create(), f.options)).task;
  const move = { action: "move", id: task.id, expectedRevision: 1, expectedOrderRevision: 1, operationId: randomUUID(), position: { edge: "end" }, columnId: "done" };
  const moved = await taskOperation(move, f.options);
  const old = JSON.parse(await readFile(f.file, "utf8")); old.version = 2; delete old.sessionRelations; delete old.tasks[0].sessionIds;
  await writeFile(f.file, JSON.stringify(old));
  assert.deepEqual((await fresh(move, f.agentDir)).value, moved);
  const migrated = JSON.parse(await readFile(f.file, "utf8")); assert.equal(migrated.version, 7);
  assert.deepEqual(migrated.tasks[0].moveReceipt, old.tasks[0].moveReceipt); assert.equal(migrated.orderRevision, old.orderRevision);
  for (const document of [
    { ...migrated, tasks: [{ ...migrated.tasks[0], sessionIds: null }] },
    { ...migrated, tasks: [{ ...migrated.tasks[0], sessionIds: ["../../sessions"] }] },
    { ...migrated, tasks: [{ ...migrated.tasks[0], sessionIds: ["same", "same"] }] },
    { ...migrated, tasks: [{ ...migrated.tasks[0], sessionIds: ["same"] }, { ...migrated.tasks[0], id: randomUUID(), sessionIds: ["same"] }] },
  ]) {
    const bytes = JSON.stringify(document); await writeFile(f.file, bytes);
    await assert.rejects(taskOperation({ action: "list" }, f.options), { code: "storage-unavailable" });
    assert.equal(await readFile(f.file, "utf8"), bytes);
  }
});

test("metadata-only catalogue and list do not hydrate long transcripts; warm managers never scan entries", async (t) => {
  const f = await fixture(t), cold = await session(f, f.chat);
  await writeFile(cold.getSessionFile(), (await readFile(cold.getSessionFile(), "utf8")) + "x".repeat(8 * 1024 * 1024));
  const warmDir = join(f.agentDir, "sessions", "warm"); await mkdir(warmDir);
  const warm = SessionManager.create(f.chat, warmDir);
  warm.getEntries = () => { throw new Error("No entry scan allowed"); };
  const inner = { sessionId: warm.getSessionId(), sessionFile: warm.getSessionFile(), sessionManager: warm, isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0, agent: { state: {} }, dispose() {} };
  const wrapper = new AgentSessionWrapper(inner);
  const before = globalThis.__piSessions;
  globalThis.__piSessions = new Map([[warm.getSessionId(), wrapper]]);
  t.after(() => { wrapper.destroy(); globalThis.__piSessions = before; });
  const stream = fs.createReadStream, fullRead = fs.readFileSync, read = fs.readSync;
  let bytesRead = 0;
  fs.createReadStream = () => { throw new Error("No body streaming allowed"); };
  fs.readFileSync = (file, ...args) => { if (String(file).endsWith(".jsonl")) throw new Error("No full JSONL reads allowed"); return fullRead(file, ...args); };
  fs.readSync = (...args) => { const count = read(...args); bytesRead += count; return count; };
  try {
    const catalogue = await taskSessionCatalogue(f.agentDir);
    assert.deepEqual(new Set(catalogue.map((s) => s.id)), new Set([cold.getSessionId(), warm.getSessionId()]));
    assert.ok(bytesRead <= 64 * 1024, `bounded header bytes=${bytesRead}`);
    const task = (await taskOperation(create(), f.options)).task;
    const linked = await taskOperation(link(task, [warm]), f.options);
    assert.deepEqual(linked.task.sessionIds, [warm.getSessionId()]);
    const bytesBeforeList = bytesRead;
    await taskOperation({ action: "list" }, f.options);
    assert.equal(bytesRead, bytesBeforeList, "board list never reads session JSONL");
    assert.equal(wrapper.isRunning(), false);
    warm.appendMessage({ role: "user", content: "warm becomes saved", timestamp: Date.now() });
    await taskSessionCatalogue(f.agentDir); // Snapshot observes the real flush.
    await unlink(warm.getSessionFile());
    const detail = await taskOperation({ action: "sessions", id: task.id }, f.options);
    assert.deepEqual(detail.linked, [{ id: warm.getSessionId(), missing: true, running: false, relationGeneration: 0, updateRevision: 0 }]);
    await assert.rejects(taskOperation(link(linked.task, [warm]), f.options), { code: "not-found" });
  } finally { fs.createReadStream = stream; fs.readFileSync = fullRead; fs.readSync = read; }
});

test("Windows project key comparison follows server normalization, never cwd spelling/basename", () => {
  const project = { cwd: "C:\\Repo", projectRoot: "C:\\Repo", projectKey: projectIdentityKey("C:\\Repo", "win32") };
  const session = { project: { cwd: "c:/repo/worktree", projectRoot: "c:/REPO/", projectKey: projectIdentityKey("c:/REPO/", "win32") } };
  assert.equal(sameTaskSessionProject(project, session), true);
  session.project.projectKey = projectIdentityKey("D:\\Repo", "win32");
  assert.equal(sameTaskSessionProject(project, session), false);
  assert.equal(sameTaskSessionProject(null, session), false);
});

test("real wrapper pending/queue/compaction/bash lifecycle snapshots never clear on first agent_end and leave task state unchanged", async (t) => {
  const f = await fixture(t), manager = await session(f, f.chat);
  let release, listener, uiContext;
  const held = new Promise((resolve) => release = resolve);
  const inner = { sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), sessionManager: manager,
    isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0,
    agent: { state: {} }, subscribe(fn) { listener = fn; return () => {}; },
    async bindExtensions(bindings) { uiContext = bindings.uiContext; },
    prompt(_text, options) { options.preflightResult?.("started"); return held; }, dispose() {} };
  const wrapper = new AgentSessionWrapper(inner); wrapper.start();
  const registry = globalThis.__piSessions; globalThis.__piSessions = new Map([[inner.sessionId, wrapper]]);
  t.after(() => { wrapper.destroy(); globalThis.__piSessions = registry; });
  const task = (await taskOperation(create(), f.options)).task;
  await taskOperation(link(task, [manager]), f.options);
  const saved = await readFile(f.file, "utf8");
  wrapper.beginExtensionBinding(); await wrapper.waitUntilReady();
  await wrapper.send({ type: "prompt", message: "fixture" });
  let dialog;
  const unsubscribe = wrapper.onEvent((event) => { if (event.type === "extension_ui_request" && event.method === "input") dialog = event; });
  const input = uiContext.input("Fixture input", "No private data");
  assert.equal(getRpcSessionActivity()[inner.sessionId].waitingForInput, true);
  await wrapper.send({ type: "extension_ui_response", id: dialog.id, value: "fixture" });
  assert.equal(await input, "fixture");
  assert.equal(getRpcSessionActivity()[inner.sessionId].waitingForInput, false); unsubscribe();
  inner.pendingMessageCount = 1;
  listener({ type: "agent_end", messages: [] });
  assert.deepEqual(getRunningRpcSessionIds(), [inner.sessionId]); assert.equal(getRpcSessionActivity()[inner.sessionId].queued, true);
  inner.isCompacting = true; listener({ type: "compaction_start" });
  assert.equal(getRpcSessionActivity()[inner.sessionId].compacting, true);
  inner.isCompacting = false; inner.pendingMessageCount = 0;
  listener({ type: "agent_end", messages: [] });
  assert.deepEqual(getRunningRpcSessionIds(), [inner.sessionId], "accepted prompt still unresolved between automatic runs");
  release(); await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(getRunningRpcSessionIds(), []);
  inner.isBashRunning = true; assert.equal(getRpcSessionActivity()[inner.sessionId].bashRunning, true); assert.deepEqual(getRunningRpcSessionIds(), [inner.sessionId]);
  inner.isBashRunning = false; inner.isCompacting = true; assert.deepEqual(getRunningRpcSessionIds(), [inner.sessionId]);
  inner.isCompacting = false; assert.deepEqual(getRunningRpcSessionIds(), []);
  inner.prompt = (_text, options) => { options.preflightResult?.("started"); return Promise.reject(new Error("fixture provider failure")); };
  await wrapper.send({ type: "prompt", message: "failing fixture" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(getRunningRpcSessionIds(), [], "failed prompt settles the real pending counter");
  assert.equal(await readFile(f.file, "utf8"), saved, "AI lifecycle never writes task status/revision/time");
});
