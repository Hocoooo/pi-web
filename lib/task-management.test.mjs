// Management-only contract. All storage/native history is synthetic and outside Git.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
import { attachFakeProvider, settle } from "./task-context-updates-fixture.mjs";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { taskOperation } = await jiti.import("./task-operations.ts");
const { withTaskStore } = await jiti.import("./task-store.ts");
const { publishContext } = await jiti.import("./task-context.ts");
const { selectContextUpdate, completeContextUpdate } = await jiti.import("./task-context-updates.ts");
const { AgentSessionWrapper, startRpcSession } = await jiti.import("./rpc-manager.ts");
const { copySessionWithTask } = await jiti.import("./task-session-copy.ts");
const { getTaskReport } = await jiti.import("./task-reports.ts");
const { waitForTaskReportExecutor } = await jiti.import("./task-report-executor.ts");
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = { role: "assistant", content: [{ type: "text", text: "Synthetic reply" }], api: "fixture", provider: "fixture", model: "fixture", usage, stopReason: "stop", timestamp: 1 };
const suspended = ["summary-options", "summary-source", "summary-generate", "summary-cancel", "publish-context", "restore-context", "prepare-start", "admit-start", "context-update-state", "accept-context-update", "clear-context-update", "pending-context-update", "complete-context-update"];
async function fixture(t) {
  const agentDir = await mkdtemp(join(tmpdir(), "manage-"));
  assert.notEqual(spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: agentDir }).status, 0);
  for (let parent = agentDir; ; parent = dirname(parent)) {
    await assert.rejects(access(join(parent, "node_modules")), { code: "ENOENT" });
    if (parent === dirname(parent)) break;
  }
  const old = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
  const cwd = join(agentDir, "chat-workspace"); await mkdir(cwd);
  await writeFile(join(cwd, "AGENTS.md"), "Synthetic management fixture instructions.");
  const wrappers = [];
  t.after(async () => {
    await waitForTaskReportExecutor();
    for (const w of wrappers) { await w.shutdown(); globalThis.__piSessions?.delete(w.sessionId); }
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
    await rm(agentDir, { recursive: true, force: true });
  });
  const op = request => taskOperation(request, { agentDir });
  const create = async (title = "Managed task", project = null) => (await op({ action: "create", id: randomUUID(), title, description: "Details", completionCriteria: "User checks", cwd: project })).task;
  const current = async id => (await op({ action: "list" })).tasks.find(t => t.id === id);
  const archive = async id => op({ action: "set-archive", id, archived: true, expectedArchiveRevision: (await current(id)).archiveRevision, operationId: randomUUID() });
  const native = () => {
    const m = SessionManager.create(cwd);
    m.appendMessage({ role: "user", content: "Synthetic history", timestamp: 0 });
    m.appendCustomMessageEntry("pi-web:task-context", "ALREADY IN NATIVE HISTORY", true, { operationId: randomUUID() });
    m.appendMessage(assistant);
    return m;
  };
  const link = async (id, sessionId) => op({ action: "link", id, expectedRevision: (await current(id)).revision, sessionIds: [sessionId] });
  const controlled = m => {
    const inner = { sessionManager: m, sessionId: m.getSessionId(), sessionFile: m.getSessionFile(), isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0,
      extensionRunner: { emit: async () => {} }, settingsManager: { getDefaultTools: () => [] }, agent: { state: {} }, getActiveToolNames: () => [], getAllTools: () => [], setActiveToolsByName() {}, abortBash() { inner.isBashRunning = false; }, dispose() {} };
    const w = new AgentSessionWrapper(inner); wrappers.push(w); (globalThis.__piSessions ??= new Map()).set(w.sessionId, w);
    return { w, inner };
  };
  return { agentDir, cwd, wrappers, op, create, current, archive, native, link, controlled, file: join(agentDir, "tasks/board.json") };
}
// Seed pre-suspension facts through existing pure validators/committers, not public requests.
async function legacy(f, taskId, sessionId) {
  await withTaskStore(f.agentDir, document => {
    const task = document.tasks.find(t => t.id === taskId);
    publishContext(task.sharedContext, { action: "publish-context", id: taskId, expectedCurrentVersionId: null, operationId: randomUUID(), content: { goal: "LEGACY PENDING MUST NOT INJECT", decisions: "", progress: "", nextSteps: "" } });
    const { receipt, ...version } = task.sharedContext.versions[0]; void receipt;
    task.sessionContexts.push({ sessionId, operationId: sessionId, relationGeneration: 0,
      selection: { taskId, operationId: sessionId, mode: "new", sessionId: null, expectedRevision: 1, expectedCurrentVersionId: version.id, confirmSameCwd: false, expectedRelationGeneration: 0 },
      snapshot: { taskId, title: task.title, description: task.description, completionCriteria: task.completionCriteria, version } });
    const choose = () => ({ action: "accept-context-update", id: taskId, sessionId, operationId: randomUUID(), expectedRevision: task.sessionUpdates[0]?.revision ?? 0, versionId: task.sharedContext.currentVersionId });
    const delivered = choose(); selectContextUpdate(task, delivered);
    completeContextUpdate(task, sessionId, { operationId: delivered.operationId, entryId: "oldentry", inputHash: "a".repeat(64), provider: "fixture", model: "fixture", sentAt: new Date().toISOString(), evidence: "sdk-input-successful-response" });
    selectContextUpdate(task, choose());
    return { value: null, changed: true };
  });
}

test("suspended operations reject before creating, migrating or reading task storage", async t => {
  const f = await fixture(t);
  for (const action of suspended) await assert.rejects(f.op({ action }), e => e.code === "invalid-input" && /suspended/.test(e.message));
  await assert.rejects(access(join(f.agentDir, "tasks")), { code: "ENOENT" });
  const task = await f.create(), m = f.native(); await f.link(task.id, m.getSessionId()); await legacy(f, task.id, m.getSessionId());
  const document = JSON.parse(await readFile(f.file, "utf8")); document.version = 6; delete document.sessionRelations;
  const bytes = JSON.stringify(document); await writeFile(f.file, bytes);
  for (const action of suspended) {
    await assert.rejects(f.op({ action, id: task.id, sessionId: m.getSessionId() }), /suspended/);
    assert.equal(await readFile(f.file, "utf8"), bytes, "even legacy migration is a forbidden side effect");
  }
  const read = await f.op({ action: "list" });
  assert.deepEqual(read.tasks[0].sessionUpdates, document.tasks[0].sessionUpdates);
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")), { ...document, version: 7, sessionRelations: [] });
});

test("legacy receipt corruption still fails closed without repairing or deleting history", async t => {
  const f = await fixture(t), task = await f.create(), m = f.native(); await f.link(task.id, m.getSessionId()); await legacy(f, task.id, m.getSessionId());
  const good = JSON.parse(await readFile(f.file, "utf8"));
  for (const damage of [
    d => { delete d.tasks[0].sessionContexts; },
    d => { d.tasks[0].sessionContexts[0].relationGeneration = 1; d.tasks[0].sessionContexts[0].selection.expectedRelationGeneration = 1; },
    d => { d.tasks[0].sessionUpdates[0].choices[0].relationGeneration = 1; },
    d => { d.tasks[0].sharedContext.versions[0].receipt.fingerprint = "invalid"; },
  ]) {
    const broken = structuredClone(good); damage(broken); const bytes = JSON.stringify(broken); await writeFile(f.file, bytes);
    await assert.rejects(f.op({ action: "list" }), { code: "storage-unavailable" });
    assert.equal(await readFile(f.file, "utf8"), bytes);
  }
});

test("archive is visibility-only even with busy wrappers; preserves CAS, receipts and native history", async t => {
  const f = await fixture(t), task = await f.create(), m = f.native(); await f.link(task.id, m.getSessionId()); await legacy(f, task.id, m.getSessionId());
  const { w, inner } = f.controlled(m); inner.isStreaming = true; inner.isCompacting = true; inner.isBashRunning = true; inner.pendingMessageCount = 2;
  const activitySnapshot = w.getActivitySnapshot.bind(w); let activitySamples = 0;
  w.getActivitySnapshot = () => { activitySamples++; return activitySnapshot(); };
  const before = JSON.parse(await readFile(f.file, "utf8")), history = await readFile(m.getSessionFile());
  const request = { action: "set-archive", id: task.id, archived: true, expectedArchiveRevision: 0, operationId: randomUUID() };
  const archived = await f.op(request); assert.equal(archived.task.archived, true);
  const after = JSON.parse(await readFile(f.file, "utf8"));
  const strip = t => { const { archived, archiveRevision, archiveReceipt, reportIds, ...rest } = t; void archived; void archiveRevision; void archiveReceipt; void reportIds; return rest; };
  assert.deepEqual(after.tasks.map(strip), before.tasks.map(strip));
  assert.equal(after.tasks[0].reportIds.length, 1, "archive adds only the report reference");
  assert.ok(activitySamples > 0, "busy runtime is sampled, never used as an archive gate");
  const report = await getTaskReport(after.tasks[0].reportIds[0], f.agentDir);
  assert.deepEqual(report.sources[0].activity, { id: m.getSessionId(), running: true, waitingForInput: false, compacting: true, bashRunning: true, queued: true });
  const samplesAfterArchive = activitySamples;
  assert.deepEqual(await readFile(m.getSessionFile()), history);
  const bytes = await readFile(f.file); await f.op(request); assert.deepEqual(await readFile(f.file), bytes);
  await assert.rejects(f.op({ ...request, operationId: randomUUID() }), { code: "conflict" });
  await f.op({ ...request, archived: false, expectedArchiveRevision: 1, operationId: randomUUID() });
  const restored = JSON.parse(await readFile(f.file, "utf8"));
  assert.deepEqual(restored.tasks.map(strip), before.tasks.map(strip));
  assert.deepEqual(restored.tasks[0].reportIds, after.tasks[0].reportIds, "restore preserves the committed report");
  assert.equal(activitySamples, samplesAfterArchive, "exact retry, conflict and restore do not recapture sources");
  assert.equal(inner.isStreaming, true); assert.equal(inner.isCompacting, true); assert.equal(inner.isBashRunning, true); assert.equal(inner.pendingMessageCount, 2);
});

test("archived links and busy reassignment/unlink retain one-owner, scope, CAS and epoch checks", async t => {
  const f = await fixture(t), a = await f.create("A"), b = await f.create("B"), m = f.native();
  await f.archive(a.id); await f.archive(b.id);
  const { inner } = f.controlled(m); inner.isStreaming = true; inner.isCompacting = true; inner.isBashRunning = true; inner.pendingMessageCount = 2;
  await f.link(a.id, m.getSessionId()); // Task management never interrupts the run.
  await legacy(f, a.id, m.getSessionId());
  await assert.rejects(f.link(b.id, m.getSessionId()), { code: "conflict" });
  const change = { action: "change-session-relation", sessionId: m.getSessionId(), sourceTaskId: a.id, targetTaskId: b.id, expectedGeneration: 0, expectedUpdateRevision: 3, operationId: randomUUID() };
  const history = await readFile(m.getSessionFile());
  await assert.rejects(f.op({ ...change, expectedUpdateRevision: 2 }), { code: "conflict" });
  const project = join(f.agentDir, "other-project"); await mkdir(project); const outside = await f.create("Other scope", project); await f.archive(outside.id);
  await assert.rejects(f.op({ ...change, targetTaskId: outside.id }), { code: "invalid-input" });
  const board = await f.op(change), oldTask = board.tasks.find(t => t.id === a.id);
  assert.equal(oldTask.sessionUpdates[0].pendingOperationId, null); assert.equal(oldTask.sessionUpdates[0].choices.length, 2); assert.equal(oldTask.sessionUpdates[0].deliveries.length, 1);
  assert.deepEqual(board.tasks.find(t => t.id === b.id).sessionIds, [m.getSessionId()]);
  const stable = await readFile(f.file); await f.op(change); assert.deepEqual(await readFile(f.file), stable);
  await f.op({ ...change, sourceTaskId: b.id, targetTaskId: null, expectedGeneration: 1, expectedUpdateRevision: 0, operationId: randomUUID() });
  assert.ok((await f.op({ action: "list" })).tasks.every(t => !t.sessionIds.includes(m.getSessionId())));
  assert.deepEqual(await readFile(m.getSessionFile()), history);
  assert.equal(inner.isStreaming, true); assert.equal(inner.isBashRunning, true); assert.equal(inner.pendingMessageCount, 2);
  await assert.rejects(f.op({ ...change, operationId: randomUUID() }), { code: "conflict" });
});

test("copy into an archived owner inherits one relationship even when the child is busy", async t => {
  const f = await fixture(t), m = f.native(), task = (await f.op({ action: "createFromSession", id: randomUUID(), title: "From session", description: "", completionCriteria: "", sourceSessionId: m.getSessionId() })).task;
  await f.archive(task.id); const history = await readFile(m.getSessionFile());
  const request = { type: "fork_branch", entryId: m.getLeafId(), operationId: randomUUID() }; let copies = 0;
  const run = () => copySessionWithTask(f.agentDir, m.getSessionId(), request, async () => {
    copies++;
    const file = SessionManager.open(m.getSessionFile()).createBranchedSession(m.getLeafId()), child = SessionManager.open(file);
    f.controlled(child).inner.isStreaming = true;
    return { cancelled: false, newSessionId: child.getSessionId() };
  });
  const result = await run(); assert.deepEqual(await run(), result); assert.equal(copies, 1);
  const saved = await f.current(task.id); assert.equal(saved.archived, true); assert.deepEqual(saved.sessionIds, [m.getSessionId(), result.newSessionId]);
  assert.deepEqual(saved.sessionContexts, []); assert.deepEqual(saved.sessionUpdates, []);
  assert.deepEqual(await readFile(m.getSessionFile()), history);
});

test("ordinary SDK prompts retain native history but never inject pending context or install delivery observers", async t => {
  const f = await fixture(t), task = await f.create(), m = f.native(); await f.link(task.id, m.getSessionId()); await legacy(f, task.id, m.getSessionId()); await f.archive(task.id);
  const { session: w } = await startRpcSession(m.getSessionId(), m.getSessionFile(), f.cwd, { toolNames: [] }); f.wrappers.push(w); await w.waitUntilReady();
  // This fixture counts main prompt dispatches; automatic titles have separate coverage.
  w.setAutoTitleEnabled(false);
  const fake = await attachFakeProvider(w), stream = w.inner.agent.streamFunction, convert = w.inner.agent.convertToLlm;
  const history = m.getEntries(), bytes = await readFile(f.file);
  await w.send({ type: "prompt", message: "Ordinary explicit message" }); await settle(w);
  assert.equal(fake.captures.length, 1);
  const input = JSON.stringify(fake.captures[0].context.messages);
  assert.match(input, /ALREADY IN NATIVE HISTORY/); assert.doesNotMatch(input, /LEGACY PENDING MUST NOT INJECT/);
  assert.deepEqual(w.inner.sessionManager.getEntries().slice(0, history.length), history);
  assert.equal(w.inner.sessionManager.getEntries().filter(e => e.customType === "pi-web:task-context").length, 1);
  assert.equal(w.inner.agent.streamFunction, stream); assert.equal(w.inner.agent.convertToLlm, convert);
  assert.deepEqual(await readFile(f.file), bytes, "no selection/delivery/receipt writes on ordinary prompt");
  for (const type of ["prompt", "steer", "follow_up"]) for (const taskStart of [undefined, null, { taskId: task.id }]) {
    await assert.rejects(w.send({ type, message: "Must remain unsent", taskStart }), /suspended/);
  }
  assert.equal(fake.captures.length, 1); assert.deepEqual(await readFile(f.file), bytes);
  await writeFile(f.file, "malformed task storage must not block chat");
  await w.send({ type: "prompt", message: "Still ordinary chat" }); await settle(w);
  assert.equal(fake.captures.length, 2);
  assert.equal(await readFile(f.file, "utf8"), "malformed task storage must not block chat");
  assert.deepEqual(await f.op({ action: "admit-session-work", sessionId: w.sessionId }), { context: null });
});
