import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { taskOperation } = await jiti.import("./task-operations.ts");
const { AgentSessionWrapper, getRpcSession } = await jiti.import("./rpc-manager.ts");
const { withTaskStore } = await jiti.import("./task-store.ts");
const { copySessionWithTask } = await jiti.import("./task-session-copy.ts");
const { POST: newSession } = await jiti.import("../app/api/agent/new/route.ts");
const { POST: command } = await jiti.import("../app/api/agent/[id]/route.ts");
const { POST: tasksHttp } = await jiti.import("../app/api/tasks/route.ts");
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = text => ({ role: "assistant", content: [{ type: "text", text }], api: "fixture", provider: "fixture", model: "fixture", usage, stopReason: "stop", timestamp: Date.now() });
async function fixture(t) {
  const agentDir = await mkdtemp(join(tmpdir(), "ar12-"));
  assert.notEqual(spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: agentDir }).status, 0);
  const old = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
  const wrappers = [], cwd = join(agentDir, "chat-workspace"); await mkdir(cwd);
  await writeFile(join(cwd, "AGENTS.md"), "Exact isolated instructions");
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "fixture-only-no-network" } }));
  t.after(async () => { for (const w of wrappers) await w.shutdown(); if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; await rm(agentDir, { recursive: true, force: true }); });
  const op = input => taskOperation(input, { agentDir });
  const task = (await op({ action: "create", id: randomUUID(), title: "Archive unfinished", description: "Preserve details", completionCriteria: "User checks", cwd: null })).task;
  const current = async () => (await op({ action: "list" })).tasks.find(x => x.id === task.id);
  const request = async archived => ({ action: "set-archive", id: task.id, archived, expectedArchiveRevision: (await current()).archiveRevision, operationId: randomUUID() });
  const archive = async archived => op(await request(archived));
  const native = () => { const m = SessionManager.create(cwd); m.appendMessage({ role: "user", content: "Synthetic history", timestamp: Date.now() }); const entry = m.appendMessage(assistant("Synthetic response")); return { m, entry }; };
  const link = async id => op({ action: "link", id: task.id, expectedRevision: (await current()).revision, sessionIds: [id] });
  const create = async p => {
    const response = await newSession(new Request("http://localhost/api/agent/new", { method: "POST", body: JSON.stringify({ type: "ensure_session", cwd, taskStart: p?.selection, provider: "anthropic", modelId: "claude-sonnet-4-5", toolNames: [] }) }));
    assert.equal(response.status, 200, await response.clone().text()); const data = await response.json(), w = getRpcSession(data.sessionId); wrappers.push(w); await w.waitUntilReady(); await w.inner.modelRuntime.setRuntimeApiKey("anthropic", "fixture-only-no-network"); return w;
  };
  const post = (w, body) => command(new Request("http://localhost/api/agent/id", { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id: typeof w === "string" ? w : w.sessionId }) });
  return { agentDir, cwd, file: join(agentDir, "tasks/board.json"), task, wrappers, op, current, request, archive, native, link, create, post };
}
function capture(f, w, gate) {
  const requests = [];
  w.inner.agent.streamFunction = (model, context) => {
    requests.push({ model: { provider: model.provider, id: model.id }, context: structuredClone(context), boardAtRequest: JSON.parse(readFileSync(f.file, "utf8")) });
    const stream = createAssistantMessageEventStream();
    void (async () => { if (gate) await gate.promise; const message = { ...assistant("Captured reply"), api: model.api, provider: model.provider, model: model.id }; stream.push({ type: "done", reason: "stop", message }); stream.end(); })();
    return stream;
  };
  return requests;
}
async function idle(w) { await w.inner.waitForIdle(); for (let n = 0; n < 100 && w.isRunning(); n++) await new Promise(r => setTimeout(r, 5)); assert.equal(w.isRunning(), false); }
function controlled(f, m) {
  const state = { prompts: 0, aborts: 0 };
  const inner = { sessionManager: m, sessionId: m.getSessionId(), sessionFile: m.getSessionFile(), isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0,
    extensionRunner: { emit: async () => {} }, settingsManager: { getDefaultTools: () => [], getShellPath: () => undefined }, agent: { state: {} }, getActiveToolNames: () => [], getAllTools: () => [], setActiveToolsByName() {},
    prompt() { state.prompts++; throw new Error("No provider expected"); }, abort: async () => { state.aborts++; }, dispose() {}, clearQueue() { inner.pendingMessageCount = 0; } };
  const w = new AgentSessionWrapper(inner); const registry = globalThis.__piSessions ??= new Map(); registry.set(w.sessionId, w); w.onDestroy(() => { if (registry.get(w.sessionId) === w) registry.delete(w.sessionId); }); f.wrappers.push(w); return { w, inner, state };
}
const fresh = async f => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `import {createJiti} from 'jiti'; const {taskOperation}=await createJiti(import.meta.url).import('./lib/task-operations.ts'); console.log(JSON.stringify(await taskOperation({action:'list'},{agentDir:process.argv[1]})));`, f.agentDir], { cwd: process.cwd(), env: process.env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
};

test("archive/restore preserves native history, all fields/order/independent receipts and fresh-process reopen; knowledge and status edits never restore", async t => {
  const f = await fixture(t), { m } = f.native(); await f.link(m.getSessionId());
  const publish = { action: "publish-context", id: f.task.id, operationId: randomUUID(), expectedCurrentVersionId: null, content: { goal: "Manual knowledge", decisions: "", progress: "", nextSteps: "" } };
  await f.op(publish);
  const b = await f.op({ action: "list" }), move = { action: "move", id: f.task.id, columnId: "review", expectedRevision: (await f.current()).revision, expectedOrderRevision: b.orderRevision, operationId: randomUUID(), position: { edge: "end" } };
  await f.op(move);
  const before = JSON.parse(await readFile(f.file, "utf8")), history = await readFile(m.getSessionFile()), req = await f.request(true);
  const a = await f.op(req); assert.equal(a.task.archived, true); assert.equal(a.task.columnId, "review");
  const after = JSON.parse(await readFile(f.file, "utf8"));
  const strip = task => { const { archived, archiveRevision, archiveReceipt, ...rest } = task; void archived; void archiveRevision; void archiveReceipt; return rest; };
  assert.deepEqual(after.tasks.map(strip), before.tasks.map(strip));
  for (const key of Object.keys(before).filter(k => k !== "tasks")) assert.deepEqual(after[key], before[key]);
  assert.equal(a.task.archiveReceipt, undefined); assert.deepEqual(await readFile(m.getSessionFile()), history);
  const saved = await readFile(f.file); await f.op(req); assert.deepEqual(await readFile(f.file), saved);
  assert.deepEqual((await fresh(f)).tasks, a.board.tasks);
  await f.op({ ...publish, operationId: randomUUID(), expectedCurrentVersionId: a.task.sharedContext.currentVersionId, content: { ...publish.content, goal: "New version while archived" } });
  assert.equal((await f.current()).archived, true);
  await f.op({ ...move, operationId: randomUUID(), expectedRevision: (await f.current()).revision, expectedOrderRevision: a.board.orderRevision, columnId: "blocked" });
  assert.equal((await f.current()).archived, true); assert.equal((await f.current()).columnId, "blocked", "14 can move archived tasks");
  const restored = await f.archive(false); assert.equal(restored.task.archived, false); assert.equal(restored.task.columnId, "blocked"); assert.equal(restored.task.sharedContext.versions.length, 2);
  await assert.rejects(f.op(req), e => e.code === "conflict", "old archive receipt cannot replay after restore");
});

test("archive CAS, idempotent no-op, real write failure and v5 absence-only migration fail closed", async t => {
  const f = await fixture(t), req = await f.request(true);
  const outcomes = await Promise.allSettled([f.op(req), f.op({ ...req, operationId: randomUUID() })]);
  assert.equal(outcomes.filter(x => x.status === "fulfilled").length, 1);
  assert.equal(outcomes.find(x => x.status === "rejected").reason.code, "conflict");
  await assert.rejects(f.op({ ...req, archived: false }), e => e.code === "conflict");
  const noop = await f.request(true), revision = (await f.current()).archiveRevision; await f.op(noop); assert.equal((await f.current()).archiveRevision, revision);
  const restore = await f.request(false), bytes = await readFile(f.file);
  await chmod(join(f.agentDir, "tasks"), 0o500);
  try { await assert.rejects(f.op(restore), e => e.code === "storage-unavailable"); assert.deepEqual(await readFile(f.file), bytes); }
  finally { await chmod(join(f.agentDir, "tasks"), 0o700); }
  await f.op(restore);
  const document = JSON.parse(await readFile(f.file, "utf8")); document.version = 5; delete document.sessionRelations;
  for (const task of document.tasks) { delete task.archived; delete task.archiveRevision; delete task.archiveReceipt; }
  await writeFile(f.file, JSON.stringify(document)); const migrated = await fresh(f); assert.equal(migrated.tasks[0].archived, false); assert.equal(migrated.tasks[0].archiveRevision, 0);
  for (const bad of [{ archived: true }, { archiveRevision: 1 }, { archived: null, archiveRevision: 0 }, { archived: false, archiveRevision: -1 }, { archived: false, archiveRevision: 0, archiveReceipt: null }]) {
    const broken = structuredClone(document); Object.assign(broken.tasks[0], bad); const text = JSON.stringify(broken); await writeFile(f.file, text);
    await assert.rejects(f.op({ action: "list" }), e => e.code === "storage-unavailable"); assert.equal(await readFile(f.file, "utf8"), text);
  }
});

for (const kind of ["prompt-pending", "streaming", "queue", "UI", "custom-UI", "compaction", "bash", "closing", "deleted-file-busy"]) test(`archive rejects actual wrapper ${kind} lifecycle, never aborts/prompts; idle permits archive`, async t => {
  const f = await fixture(t), { m } = f.native(); await f.link(m.getSessionId()); const { w, inner, state } = controlled(f, m);
  const bytes = await readFile(f.file);
  if (kind === "prompt-pending") w.pendingPromptCount = 1;
  if (kind === "streaming" || kind === "closing" || kind === "deleted-file-busy") inner.isStreaming = true;
  if (kind === "queue") inner.pendingMessageCount = 1;
  if (kind === "UI") w.pendingUiResponses.set("fixture", {});
  if (kind === "custom-UI") w.activeCustomUis.set("fixture", {});
  if (kind === "compaction") inner.isCompacting = true;
  if (kind === "bash") inner.isBashRunning = true;
  if (kind === "closing") w.closing = true;
  if (kind === "deleted-file-busy") await rm(m.getSessionFile());
  await assert.rejects(f.archive(true), e => e.code === "conflict" && /busy/.test(e.message));
  assert.deepEqual(await readFile(f.file), bytes); assert.deepEqual(state, { prompts: 0, aborts: 0 });
  w.pendingPromptCount = 0; inner.isStreaming = false; inner.isCompacting = false; inner.isBashRunning = false; inner.pendingMessageCount = 0; w.pendingUiResponses.clear(); w.activeCustomUis.clear(); w.closing = false;
  assert.equal((await f.archive(true)).task.archived, true);
});

test("actual SDK/provider: first task Send, original chat, native queues, compact/bash/widget and sleeping HTTP all require restore, failures dispatch nothing", { timeout: 30000 }, async t => {
  const f = await fixture(t), p = await f.op({ action: "prepare-start", id: f.task.id, operationId: randomUUID(), sessionId: null }), w = await f.create(p), requests = capture(f, w);
  await f.archive(true);
  const taskSend = await f.post(w, { type: "prompt", message: "Must not start", taskStart: p.selection }); assert.equal(taskSend.status, 500); assert.equal((await taskSend.json()).accepted, false);
  await assert.rejects(f.op({ action: "prepare-start", id: f.task.id, operationId: randomUUID(), sessionId: null }), /archived/);
  const blockedNew = await newSession(new Request("http://localhost/api/agent/new", { method: "POST", body: JSON.stringify({ type: "prompt", cwd: f.cwd, message: "Must not create", taskStart: p.selection }) })); assert.equal(blockedNew.status, 500); assert.equal((await blockedNew.json()).accepted, false);
  assert.equal(requests.length, 0); assert.equal(w.inner.messages.length, 0); assert.equal((await f.current()).sessionIds.length, 0);
  await f.archive(false);
  assert.equal((await f.post(w, { type: "prompt", message: "Task first Send after explicit restore", taskStart: p.selection })).status, 200); await idle(w);
  assert.equal(requests.length, 1); const selected = (await f.current()).sessionContexts;
  assert.equal(selected[0].sessionId, w.sessionId); await f.archive(true);
  assert.deepEqual((await f.current()).sessionContexts, selected);
  const before = await readFile(f.file);
  for (const type of ["prompt", "steer", "follow_up", "compact", "bash", "extension_ui_input"]) {
    const res = await f.post(w, { type, message: "No dispatch", command: "touch forbidden", id: "fixture", data: "fixture" });
    assert.equal(res.status, 500, type); assert.match((await res.json()).error, /archived/);
  }
  for (const streamingBehavior of ["steer", "followUp"]) assert.equal((await f.post(w, { type: "prompt", message: "No queue", streamingBehavior })).status, 500);
  assert.equal(requests.length, 1); assert.equal(w.inner.pendingMessageCount, 0); assert.deepEqual(await readFile(f.file), before);
  await f.archive(false); assert.equal((await f.post(w, { type: "prompt", message: "Independent Send after restore" })).status, 200); await idle(w); assert.equal(requests.length, 2); assert.equal(requests[0].boardAtRequest.tasks[0].archived, false);
  assert.deepEqual((await f.current()).sessionContexts, selected);
  const file = w.sessionFile; await w.shutdown(); await f.archive(true);
  assert.equal((await f.post(w.sessionId, { type: "prompt", message: "Sleeping chat must refuse" })).status, 500); assert.equal(getRpcSession(w.sessionId), undefined); assert.equal(requests.length, 2);
  assert.ok(await readFile(file));
  if (process.env.TASK_ARCHIVE_ARTIFACT_DIR) await writeFile(join(process.env.TASK_ARCHIVE_ARTIFACT_DIR, "restored-sdk-request.json"), JSON.stringify(requests, null, 2));
});

test("actual SDK/provider start wins before archive; Stop then archive preserves status; queued follow-up prevents early idle archive", { timeout: 30000 }, async t => {
  const f = await fixture(t), w = await f.create(); await f.link(w.sessionId);
  const gate = Promise.withResolvers(), requests = capture(f, w, gate), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const lock = withTaskStore(f.agentDir, async () => { entered.resolve(); await release.promise; return { value: null, changed: false }; }); await entered.promise;
  const submission = f.post(w, { type: "prompt", message: "Start before archive" });
  for (let n = 0; n < 100 && !w.isRunning(); n++) await new Promise(r => setTimeout(r, 5)); assert.equal(w.isRunning(), true);
  const archival = f.op({ action: "set-archive", id: f.task.id, archived: true, expectedArchiveRevision: 0, operationId: randomUUID() });
  const observed = archival.catch(e => e); release.resolve(); await lock;
  assert.equal((await submission).status, 200); assert.equal((await observed).code, "conflict");
  // HTTP preflight acceptance is not provider dispatch. 09 adds an asynchronous
  // authority read without changing the original acceptance boundary.
  for (let n = 0; n < 100 && requests.length === 0; n++) await new Promise(r => setTimeout(r, 5));
  assert.equal(requests.length, 1);
  await w.send({ type: "follow_up", message: "Existing queued work" }); assert.equal(w.inner.pendingMessageCount, 1); await assert.rejects(f.archive(true), /busy/);
  const stop = w.send({ type: "abort" }); gate.resolve(); await stop; await idle(w); w.inner.clearQueue();
  assert.equal((await f.archive(true)).task.archived, true); assert.equal((await f.current()).columnId, "todo");
});

test("archive wins at actual runtime snapshot barrier: concurrent original Send cannot pass stale state", { timeout: 30000 }, async t => {
  const f = await fixture(t), w = await f.create(); await f.link(w.sessionId); const requests = capture(f, w);
  const original = w.getActivitySnapshot.bind(w); let submission;
  w.getActivitySnapshot = () => { const idleSnapshot = original(); w.getActivitySnapshot = original; submission = f.post(w, { type: "prompt", message: "Races archive after idle check" }); return idleSnapshot; };
  assert.equal((await f.archive(true)).task.archived, true); assert.ok(submission);
  const response = await submission; assert.equal(response.status, 500); assert.equal((await response.json()).accepted, false); assert.equal(requests.length, 0); assert.equal(w.inner.messages.length, 0);
});

test("archived link/SDK fork inheritance reject running child atomically; idle copies inherit archive owner without prompt and exact retry preserves receipt", async t => {
  const f = await fixture(t), source = f.native(); await f.link(source.m.getSessionId()); await f.archive(true);
  const other = f.native(), { inner, state } = controlled(f, other.m); inner.pendingMessageCount = 1;
  const bytes = await readFile(f.file); await assert.rejects(f.link(other.m.getSessionId()), /busy/); assert.deepEqual(await readFile(f.file), bytes); assert.equal(state.prompts, 0);
  inner.pendingMessageCount = 0; await f.link(other.m.getSessionId());
  const request = { type: "fork_branch", entryId: source.entry, operationId: randomUUID() }; let nativeCopies = 0, child, childRuntime;
  const execute = async () => { nativeCopies++; const path = SessionManager.open(source.m.getSessionFile()).createBranchedSession(source.entry); child = SessionManager.open(path); childRuntime = controlled(f, child); childRuntime.inner.pendingMessageCount = 1; return { cancelled: false, newSessionId: child.getSessionId() }; };
  await assert.rejects(copySessionWithTask(f.agentDir, source.m.getSessionId(), request, execute), e => e.taskCode === "conflict" && /busy/.test(e.message));
  assert.equal((await f.current()).sessionIds.includes(child.getSessionId()), false); assert.equal((await f.current()).archived, true);
  childRuntime.inner.pendingMessageCount = 0;
  const result = await copySessionWithTask(f.agentDir, source.m.getSessionId(), request, execute); assert.equal(result.newSessionId, child.getSessionId()); assert.equal(nativeCopies, 1);
  assert.equal((await f.current()).sessionIds.includes(child.getSessionId()), true); assert.equal((await f.current()).archived, true);
  await assert.rejects(childRuntime.w.send({ type: "prompt", message: "Copied archived owner requires restore" }), /archived/); assert.equal(childRuntime.state.prompts, 0);
  const after = await readFile(f.file); assert.deepEqual(await copySessionWithTask(f.agentDir, source.m.getSessionId(), request, execute), result); assert.deepEqual(await readFile(f.file), after);
});

test("link-first/start-first races into archived task cannot both succeed; source-create cannot rehome an archived owner; HTTP internal guard refuses", async t => {
  const f = await fixture(t); await f.archive(true); const { m } = f.native(), { w, inner, state } = controlled(f, m);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const lock = withTaskStore(f.agentDir, async () => { entered.resolve(); await release.promise; return { value: null, changed: false }; }); await entered.promise;
  inner.prompt = async (_message, options) => { state.prompts++; inner.isStreaming = true; options.preflightResult(); };
  const send = w.send({ type: "prompt", message: "Unowned initial work" });
  const linking = f.op({ action: "link", id: f.task.id, expectedRevision: (f.task.revision), sessionIds: [m.getSessionId()] }).catch(e => e);
  release.resolve(); await lock; await send; assert.equal((await linking).code, "conflict"); assert.equal((await f.current()).sessionIds.length, 0);
  inner.isStreaming = false; await f.link(m.getSessionId());
  await assert.rejects(w.send({ type: "prompt", message: "Link won; no send" }), /archived/); assert.equal(state.prompts, 1);
  await assert.rejects(f.op({ action: "createFromSession", id: randomUUID(), sourceSessionId: m.getSessionId(), title: "Cannot steal", description: "", completionCriteria: "" }), e => e.code === "conflict");
  const bytes = await readFile(f.file);
  for (const action of ["admit-session-work", "admit-start"]) {
    const response = await tasksHttp(new Request("http://localhost/api/tasks", { method: "POST", body: JSON.stringify({ action, sessionId: m.getSessionId() }) })); assert.equal(response.status, 400);
  }
  assert.deepEqual(await readFile(f.file), bytes);
});

for (const type of ["steer", "follow_up", "compact", "bash"]) test(`reserved ${type} dispatch shares archive admission and pending lifecycle before native state settles`, async t => {
  const f = await fixture(t), { m } = f.native(); await f.link(m.getSessionId()); const { w, inner } = controlled(f, m);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const method = { steer: "steer", follow_up: "followUp", compact: "compact", bash: "executeBash" }[type];
  inner[method] = async () => { entered.resolve(); await release.promise; return null; };
  const pending = w.send({ type, message: "Controlled native dispatch", command: "fixture-only" });
  await entered.promise; assert.equal(w.isRunning(), true);
  await assert.rejects(f.archive(true), e => e.code === "conflict" && /busy/.test(e.message));
  release.resolve(); await pending; assert.equal(w.isRunning(), false); assert.equal((await f.archive(true)).task.archived, true);
});

test("07 real SDK provider generation uses the same archive guard/active lifecycle; cancel is independent, finished knowledge publish never restores", async t => {
  const { summaryFixture, content } = await import("./task-summary-fixture.mjs");
  const f = await summaryFixture(); t.after(() => rm(f.agentDir, { recursive: true, force: true }));
  const snapshot = await f.snapshot();
  const archive = archived => f.call({ action: "set-archive", id: f.task.id, archived, expectedArchiveRevision: archived ? 0 : 1, operationId: randomUUID() });
  const gate = Promise.withResolvers(); f.setResponse(async () => { await gate.promise; return content; });
  const generation = f.generate(snapshot);
  for (let n = 0; n < 100 && !f.captures.length; n++) await new Promise(r => setTimeout(r, 5)); assert.equal(f.captures.length, 1);
  await assert.rejects(archive(true), /summary is still working/); gate.resolve(); const result = await generation;
  await archive(true); const before = f.captures.length;
  await assert.rejects(f.generate(snapshot), /archived/); assert.equal(f.captures.length, before);
  await f.call({ action: "publish-context", id: f.task.id, operationId: randomUUID(), expectedCurrentVersionId: null, generationId: result.generationId, content: result.content });
  const task = (await f.call({ action: "list" })).tasks[0]; assert.equal(task.archived, true); assert.equal(task.sharedContext.versions[0].source.kind, "ai");
  await archive(false); assert.equal((await f.call({ action: "list" })).tasks[0].archived, false);
});
