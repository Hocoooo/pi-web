import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, mkdir, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { contextUpdateFixture, settle } from "./task-context-updates-fixture.mjs";
import { summaryFixture } from "./task-summary-fixture.mjs";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { withTaskStore } = await jiti.import("./task-store.ts");
const { POST: tasksHttp } = await jiti.import("../app/api/tasks/route.ts");
const { copySessionWithTask } = await jiti.import("./task-session-copy.ts");
const { prepareContextUpdateSend } = await jiti.import("./task-context-update-send.ts");
const { contextUpdateBoundary } = await jiti.import("./task-context-updates.ts");
const { resolveProject } = await jiti.import("./worktree.ts");
async function task(f, title = "Target", cwd = null) {
  return (await f.op({ action: "create", id: randomUUID(), title, description: "", completionCriteria: "", cwd })).task;
}
async function relation(f, targetTaskId = null, sourceTaskId = f.task.id) {
  const state = await f.op({ action: "context-update-state", sessionId: f.w.sessionId });
  return { action: "change-session-relation", sessionId: f.w.sessionId, sourceTaskId, targetTaskId,
    expectedGeneration: state.relationGeneration, expectedUpdateRevision: state.state.revision, operationId: randomUUID() };
}
const owner = (board, id) => board.tasks.find(t => t.sessionIds.includes(id));
function controlled(t, agentDir, manager) {
  const inner = { sessionManager: manager, sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0,
    extensionRunner: { emit: async () => {} }, settingsManager: { getDefaultTools: () => [], getShellPath: () => undefined }, agent: { state: {} }, getActiveToolNames: () => [], getAllTools: () => [], setActiveToolsByName() {},
    abort: async () => {}, dispose() {} };
  const w = new AgentSessionWrapper(inner), registry = globalThis.__piSessions ??= new Map(); registry.set(w.sessionId, w);
  w.onDestroy(() => { if (registry.get(w.sessionId) === w) registry.delete(w.sessionId); }); t.after(() => w.shutdown());
  return { w, inner };
}

for (const kind of ["prompt-pending", "streaming", "queue", "UI", "custom-UI", "compaction", "bash", "closing", "deleted-file-busy"]) test(`relation actual wrapper ${kind} rejects without clearing pending or touching history`, async t => {
  const f = await contextUpdateFixture(t), target = await task(f), v2 = await f.publish("OLD PENDING NEVER AUTO SEND"); await f.accept(v2);
  const manager = SessionManager.open(f.w.sessionFile); await f.w.shutdown();
  const { w, inner } = controlled(t, f.agentDir, manager), request = await relation({ ...f, w }, target.id), bytes = await readFile(f.file), history = await readFile(manager.getSessionFile());
  if (kind === "prompt-pending") w.pendingPromptCount = 1;
  if (["streaming", "closing", "deleted-file-busy"].includes(kind)) inner.isStreaming = true;
  if (kind === "queue") inner.pendingMessageCount = 1;
  if (kind === "UI") w.pendingUiResponses.set("test", {});
  if (kind === "custom-UI") w.activeCustomUis.set("test", {});
  if (kind === "compaction") inner.isCompacting = true;
  if (kind === "bash") inner.isBashRunning = true;
  if (kind === "closing") w.closing = true;
  if (kind === "deleted-file-busy") await rm(manager.getSessionFile());
  await assert.rejects(f.op(request), e => e.code === "conflict" && /busy/.test(e.message));
  assert.deepEqual(await readFile(f.file), bytes);
  if (kind !== "deleted-file-busy") assert.deepEqual(await readFile(manager.getSessionFile()), history);
  w.pendingPromptCount = 0; inner.isStreaming = false; inner.isCompacting = false; inner.isBashRunning = false; inner.pendingMessageCount = 0; w.pendingUiResponses.clear(); w.activeCustomUis.clear(); w.closing = false;
  if (kind === "deleted-file-busy") await assert.rejects(f.op(request), { code: "not-found" });
  else assert.equal(owner(await f.op(request), w.sessionId).id, target.id);
});

test("idle reassign is atomic, preserves old native history/model/tools/cwd and clears only intent; next actual provider never gets old pending or target latest", async t => {
  const f = await contextUpdateFixture(t, ["read"]), target = await task(f), v2 = await f.publish("OLD PENDING UNIQUE SECRET"); await f.accept(v2);
  const targetVersion = (await f.op({ action: "publish-context", id: target.id, expectedCurrentVersionId: null, operationId: randomUUID(), content: { goal: "TARGET UNCHOSEN UNIQUE", decisions: "", progress: "", nextSteps: "" } })).task.sharedContext.currentVersionId;
  const history = await readFile(f.w.sessionFile), model = f.w.inner.model, tools = f.w.inner.getActiveToolNames(), cwd = f.w.inner.sessionManager.getCwd();
  const before = await f.op({ action: "list" }), request = await relation(f, target.id), saved = await f.op(request);
  assert.equal(owner(saved, f.w.sessionId).id, target.id); assert.equal(saved.tasks.filter(t => t.sessionIds.includes(f.w.sessionId)).length, 1);
  assert.deepEqual(await readFile(f.w.sessionFile), history); assert.deepEqual(f.w.inner.model, model); assert.deepEqual(f.w.inner.getActiveToolNames(), tools); assert.equal(f.w.inner.sessionManager.getCwd(), cwd);
  const old = saved.tasks.find(t => t.id === f.task.id); assert.equal(old.sessionUpdates[0].pendingOperationId, null); assert.equal(old.sessionUpdates[0].choices.length, 1); assert.equal(old.sessionContexts.length, 1);
  assert.equal(saved.orderRevision, before.orderRevision); assert.equal(saved.columnsRevision, before.columnsRevision);
  const state = await f.state(); assert.equal(state.task.id, target.id); assert.equal(state.task.sharedContext.currentVersionId, targetVersion); assert.equal(state.current, null); assert.equal(state.relationGeneration, 1);
  const bytes = await readFile(f.file); await f.op(request); assert.deepEqual(await readFile(f.file), bytes);
  await f.send("Independent actual input after reassign"); await settle(f.w);
  const input = JSON.stringify(f.captures.at(-1).context.messages);
  assert.ok(input.includes(f.first), "old history is honestly still input, not forgotten");
  assert.ok(!input.includes(v2)); assert.ok(!input.includes("OLD PENDING UNIQUE SECRET")); assert.ok(!input.includes(targetVersion)); assert.ok(!input.includes("TARGET UNCHOSEN UNIQUE"));
  const unlink = await relation(f, null, target.id); await f.op(unlink); assert.equal((await f.state()).task, null); assert.equal(await f.op({ action: "pending-context-update", sessionId: f.w.sessionId }), null);
  const oldCount = f.captures.length; await f.publish("OLD LATEST AFTER UNLINK"); assert.equal((await f.state()).task, null); assert.equal(f.captures.length, oldCount);
  if (process.env.TASK_RELATION_ARTIFACT_DIR) await writeFile(join(process.env.TASK_RELATION_ARTIFACT_DIR, "actual-input.json"), JSON.stringify({ request, saved, captures: f.captures }, null, 2));
});

test("actual SDK Stop and idle success; stale two-tab relation CAS and changed pending reject byte-for-byte, exact retry never duplicates", async t => {
  const f = await contextUpdateFixture(t), b = await task(f, "B"), c = await task(f, "C"), gate = Promise.withResolvers(), entered = Promise.withResolvers();
  f.setResponse(async () => { entered.resolve(); await gate.promise; return { role: "assistant", content: [{ type: "text", text: "Answer" }], stopReason: "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }; });
  await f.send("Running"); await entered.promise;
  const request = await relation(f, b.id); await assert.rejects(f.op(request), /busy/);
  const stopped = f.w.send({ type: "abort" }); gate.resolve(); await stopped; await settle(f.w);
  const choices = await Promise.allSettled([f.op(request), f.op({ ...request, targetTaskId: c.id, operationId: randomUUID() })]);
  assert.equal(choices.filter(x => x.status === "fulfilled").length, 1); assert.equal(choices.find(x => x.status === "rejected").reason.code, "conflict");
  const board = await f.op({ action: "list" }), chosen = owner(board, f.w.sessionId); assert.equal(board.tasks.filter(t => t.sessionIds.includes(f.w.sessionId)).length, 1);
  const stale = await relation(f, null, chosen.id);
  const v = (await f.op({ action: "publish-context", id: chosen.id, expectedCurrentVersionId: null, operationId: randomUUID(), content: { goal: "new", decisions: "", progress: "", nextSteps: "" } })).task.sharedContext.currentVersionId;
  await f.op({ action: "accept-context-update", id: chosen.id, sessionId: f.w.sessionId, operationId: randomUUID(), expectedRevision: 0, expectedRelationGeneration: 1, versionId: v });
  const bytes = await readFile(f.file); await assert.rejects(f.op(stale), { code: "conflict" }); assert.deepEqual(await readFile(f.file), bytes);
});

test("A→B→A permanently invalidates old09 late completion, pending/prepared send and08 prepare/receipt execution but retains all audits", async t => {
  const f = await contextUpdateFixture(t), b = await task(f), v2 = await f.publish("OLD EPOCH UPDATE"), choice = await f.accept(v2);
  const p = await f.op({ action: "prepare-start", id: f.task.id, operationId: randomUUID(), sessionId: f.w.sessionId });
  const restoreObserver = await prepareContextUpdateSend(f.w.inner, f.agentDir, new AbortController().signal, () => true, contextUpdateBoundary());
  // Real SDK converter/stream observation held across a relation change; no ordinary run in progress.
  const projected = f.w.inner.sessionManager.buildSessionProjection().messages;
  const converted = await f.w.inner.agent.convertToLlm(projected);
  const gate = Promise.withResolvers(); f.setResponse(async () => { await gate.promise; return { role: "assistant", content: [{ type: "text", text: "Late answer" }], stopReason: "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }; });
  const stream = await f.w.inner.agent.streamFunction(f.w.inner.model, { messages: converted, tools: [] }, {});
  await f.op(await relation(f, b.id)); await f.op(await relation(f, f.task.id, b.id));
  gate.resolve(); await stream.result(); restoreObserver(); await new Promise(r => setTimeout(r, 80));
  const state = await f.state(); assert.equal(state.relationGeneration, 2); assert.equal(state.state.pendingOperationId, null); assert.equal(state.state.deliveries.length, 0);
  assert.equal(f.w.inner.sessionManager.getEntries().filter(e => e.customType === "pi-web:task-context-send").length, 0);
  assert.equal(f.w.inner.sessionManager.getEntries().filter(e => e.customType === "pi-web:task-context").length, 2, "native old append is preserved, not retracted");
  const bytes = await readFile(f.file);
  await assert.rejects(f.op(choice), { code: "conflict" });
  await assert.rejects(f.op({ action: "admit-start", id: f.task.id, selection: p.selection, realSessionId: f.w.sessionId }), { code: "conflict" });
  const original = (await f.op({ action: "list" })).tasks.find(t => t.id === f.task.id).sessionContexts[0];
  await assert.rejects(f.send("Old receipt must not execute", { taskStart: original.selection }), /relationship/);
  assert.deepEqual(await readFile(f.file), bytes);
  const fresh = await f.op({ action: "prepare-start", id: f.task.id, operationId: randomUUID(), sessionId: f.w.sessionId });
  assert.equal(fresh.selection.expectedRelationGeneration, 2);
  const calls = f.captures.length; await f.send("Fresh Continue", { taskStart: fresh.selection }); await settle(f.w); assert.equal(f.captures.length, calls + 1);
  assert.equal(f.w.inner.sessionManager.getEntries().filter(e => e.customType === "pi-web:task-context").length, 2, "Continue never resurrects a receipt-only selection");
});

test("08 receipt-only Stop cannot recover original material after reassign ABA; fresh Continue sends only user input", async t => {
  const f = await contextUpdateFixture(t), b = await task(f);
  const raw = JSON.parse(await readFile(f.file)), oldContext = raw.tasks[0].sessionContexts[0];
  // Use a real fresh SDK identity and public admission to make receipt-only selection (no native append).
  const p = await f.op({ action: "prepare-start", id: f.task.id, operationId: randomUUID(), sessionId: null });
  const { startRpcSession } = await jiti.import("./rpc-manager.ts");
  const { attachFakeProvider } = await import("./task-context-updates-fixture.mjs");
  const w = (await startRpcSession(p.selection.operationId, "", f.cwd, { newSessionId: p.selection.operationId, toolNames: [] })).session; t.after(() => w.shutdown()); await w.waitUntilReady(); const fake = await attachFakeProvider(w);
  await f.op({ action: "admit-start", id: f.task.id, selection: p.selection, realSessionId: w.sessionId });
  const other = { ...f, w }; await f.op(await relation(other, b.id)); await f.op(await relation(other, f.task.id, b.id));
  const fresh = await f.op({ action: "prepare-start", id: f.task.id, operationId: randomUUID(), sessionId: w.sessionId });
  await w.send({ type: "prompt", message: "Only user input", taskStart: fresh.selection }); await settle(w);
  assert.equal(w.inner.sessionManager.getEntries().filter(e => e.customType === "pi-web:task-context").length, 0);
  assert.ok(!JSON.stringify(fake.captures[0].context.messages).includes(oldContext.snapshot.description));
});

test("11 prepared copy/late known-child completion rejects ABA; completed exact receipt remains historical fact and never rebinds a moved child", async t => {
  const f = await contextUpdateFixture(t), b = await task(f), request = { type: "fork_branch", entryId: f.w.inner.sessionManager.getLeafId(), operationId: randomUUID() };
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let count = 0, child;
  const execute = async () => { count++; const file = SessionManager.open(f.w.sessionFile).createBranchedSession(request.entryId); child = SessionManager.open(file); entered.resolve(); await release.promise; return { cancelled: false, newSessionId: child.getSessionId() }; };
  const copy = copySessionWithTask(f.agentDir, f.w.sessionId, request, execute).catch(e => e); await entered.promise;
  await f.op(await relation(f, b.id)); await f.op(await relation(f, f.task.id, b.id)); release.resolve(); assert.equal((await copy).taskCode, "conflict");
  await assert.rejects(copySessionWithTask(f.agentDir, f.w.sessionId, request, execute), e => e.taskCode === "conflict"); assert.equal(count, 1);
  assert.equal(owner(await f.op({ action: "list" }), child.getSessionId()), undefined);
  const completedRequest = { ...request, operationId: randomUUID() }, result = await f.w.send(completedRequest);
  const state = await f.op({ action: "context-update-state", sessionId: result.newSessionId });
  await f.op({ action: "change-session-relation", sourceTaskId: f.task.id, targetTaskId: b.id, sessionId: result.newSessionId, expectedGeneration: state.relationGeneration, expectedUpdateRevision: state.state.revision, operationId: randomUUID() });
  const bytes = await readFile(f.file); assert.deepEqual(await f.w.send(completedRequest), result); assert.deepEqual(await readFile(f.file), bytes); assert.equal(owner(await f.op({ action: "list" }), result.newSessionId).id, b.id);
});

for (const phase of ["snapshot", "auth", "late-response", "publish", "repeat-result"]) test(`07 ${phase} rejects relation ABA before new dispatch/publication; exact committed publish only confirms fact`, async t => {
  const f = await summaryFixture(); t.after(() => rm(f.agentDir, { recursive: true, force: true }));
  const op = f.call, target = (await op({ action: "create", id: randomUUID(), title: "B", description: "", completionCriteria: "", cwd: null })).task;
  const move = async () => {
    const state = await op({ action: "context-update-state", sessionId: f.source.getSessionId() });
    await op({ action: "change-session-relation", sessionId: f.source.getSessionId(), sourceTaskId: state.task.id, targetTaskId: state.task.id === f.task.id ? target.id : f.task.id, expectedGeneration: state.relationGeneration, expectedUpdateRevision: state.state.revision, operationId: randomUUID() });
  };
  const s = await f.snapshot(), operationId = randomUUID();
  if (phase === "snapshot") { await move(); await move(); await assert.rejects(f.generate(s), { code: "conflict" }); assert.equal(f.captures.length, 0); return; }
  if (phase === "auth" || phase === "late-response") {
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    if (phase === "auth") { const old = f.runtime.getAuth.bind(f.runtime); f.runtime.getAuth = async (...args) => { entered.resolve(); await release.promise; return old(...args); }; }
    else f.setResponse(async () => { entered.resolve(); await release.promise; return { goal: "late", decisions: "", progress: "", nextSteps: "" }; });
    const g = f.generate(s).catch(e => e); await entered.promise; await move(); await move(); release.resolve(); assert.equal((await g).code, "conflict"); assert.equal(f.captures.length, phase === "auth" ? 0 : 1); return;
  }
  const g = await f.generate(s, { operationId }), publish = { action: "publish-context", id: f.task.id, expectedCurrentVersionId: null, operationId: randomUUID(), generationId: g.generationId, content: g.content };
  if (phase === "publish") {
    await move(); await move(); const bytes = await readFile(f.file); await assert.rejects(op(publish), { code: "conflict" }); assert.deepEqual(await readFile(f.file), bytes);
  } else {
    await op(publish); await move(); await move();
    await assert.rejects(f.generate(s, { operationId }), { code: "conflict" }); const bytes = await readFile(f.file); await op(publish); assert.deepEqual(await readFile(f.file), bytes); assert.equal(f.captures.length, 1);
  }
});

test("cross-project and no-project boundaries, uncached samepath replacement and same-project worktree success", async t => {
  const f = await contextUpdateFixture(t), project = join(f.agentDir, "project"), other = join(f.agentDir, "other"); await mkdir(project); await mkdir(other);
  const foreign = await task(f, "Foreign", project), bytes = await readFile(f.file); await assert.rejects(f.op(await relation(f, foreign.id)), { code: "invalid-input" }); assert.deepEqual(await readFile(f.file), bytes);
  execFileSync("git", ["init", project]); execFileSync("git", ["-C", project, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "fixture"]);
  const wt = join(f.agentDir, "wt"); execFileSync("git", ["-C", project, "worktree", "add", "-b", "fixture", wt]);
  const manager = SessionManager.create(wt, join(f.agentDir, "sessions", "project")); manager.appendMessage({ role: "user", content: "Synthetic", timestamp: Date.now() }); manager.appendMessage({ role: "assistant", content: [], api: "fixture", provider: "fixture", model: "fixture", stopReason: "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const source = (await f.op({ action: "createFromSession", id: randomUUID(), title: "Project source", description: "", completionCriteria: "", sourceSessionId: manager.getSessionId() })).task;
  const target = await task(f, "Same project", project), request = { action: "change-session-relation", sessionId: manager.getSessionId(), sourceTaskId: source.id, targetTaskId: target.id, expectedGeneration: 0, expectedUpdateRevision: 0, operationId: randomUUID() };
  assert.equal(owner(await f.op(request), manager.getSessionId()).id, target.id);
  await resolveProject(wt); execFileSync("git", ["-C", project, "worktree", "remove", wt]); execFileSync("git", ["init", other]); execFileSync("git", ["-C", other, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "other"]); execFileSync("git", ["-C", other, "worktree", "add", "-b", "replacement", wt]);
  const before = await readFile(f.file); await assert.rejects(f.op({ ...request, sourceTaskId: target.id, targetTaskId: source.id, expectedGeneration: 1, operationId: randomUUID() }), { code: "invalid-input" }); assert.deepEqual(await readFile(f.file), before);
});

test("12 archive source/target guards and start/link/reassign races share one lock; write failure preserves original relation and pending", async t => {
  const f = await contextUpdateFixture(t), b = await task(f), v = await f.publish("PENDING"); await f.accept(v);
  const request = await relation(f, b.id), archive = async (id, archived, base) => f.op({ action: "set-archive", id, archived, expectedArchiveRevision: base, operationId: randomUUID() });
  await archive(b.id, true, 0); await assert.rejects(f.op(request), /archived/); await archive(b.id, false, 1);
  await archive(f.task.id, true, 0); await assert.rejects(f.op(request), /archived/); await archive(f.task.id, false, 1);
  const bytes = await readFile(f.file); await chmod(join(f.agentDir, "tasks"), 0o500);
  try { await assert.rejects(f.op(request), { code: "storage-unavailable" }); assert.deepEqual(await readFile(f.file), bytes); } finally { await chmod(join(f.agentDir, "tasks"), 0o700); }
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const lock = withTaskStore(f.agentDir, async () => { entered.resolve(); await release.promise; return { value: null, changed: false }; }); await entered.promise;
  const change = f.op(request).catch(e => e), sending = f.send("Start reserved while relation awaits board lock"); release.resolve(); await lock;
  assert.equal((await change).code, "conflict"); await sending; await settle(f.w); assert.equal(owner(await f.op({ action: "list" }), f.w.sessionId).id, f.task.id);
  const current = await relation(f, b.id), oldTask = (await f.op({ action: "list" })).tasks.find(t => t.id === b.id);
  const race = await Promise.allSettled([f.op(current), f.op({ action: "link", id: b.id, expectedRevision: oldTask.revision, sessionIds: [f.w.sessionId] })]);
  assert.equal(race[0].status, "fulfilled"); assert.equal(owner(await f.op({ action: "list" }), f.w.sessionId).id, b.id);
});

test("all public HTTP operations use internal guards; real route relation success/retry and malformed CAS reject without bytes changing", async t => {
  const f = await contextUpdateFixture(t), b = await task(f), request = await relation(f, b.id);
  const post = input => tasksHttp(new Request("http://localhost/api/tasks", { method: "POST", body: JSON.stringify(input) }));
  for (const action of ["pending-context-update", "complete-context-update", "admit-start", "admit-session-work", "prepare-session-copy", "complete-session-copy"]) assert.equal((await post({ ...request, action })).status, 400);
  const bytes = await readFile(f.file);
  for (const extra of [{ generation: 0 }, { expectedGeneration: null }, { targetTaskId: f.task.id }, { sessionId: "../escape" }, { expectedUpdateRevision: -1 }]) assert.equal((await post({ ...request, ...extra })).status, 400);
  assert.deepEqual(await readFile(f.file), bytes); assert.equal((await post(request)).status, 200); const saved = await readFile(f.file); assert.equal((await post(request)).status, 200); assert.deepEqual(await readFile(f.file), saved);
});

test("v6→v7 explicit absent-generation migration preserves historical facts and fresh-process persistence; v7 missing/invalid epochs reject", async t => {
  const f = await contextUpdateFixture(t), v = await f.publish("Migration choice"); await f.accept(v);
  const good = JSON.parse(await readFile(f.file)); assert.equal(good.version, 7);
  const legacy = structuredClone(good); legacy.version = 6; delete legacy.sessionRelations;
  for (const task of legacy.tasks) { for (const c of task.sessionContexts) { delete c.relationGeneration; delete c.selection.expectedRelationGeneration; } for (const s of task.sessionUpdates) for (const c of s.choices) delete c.relationGeneration; }
  await writeFile(f.file, JSON.stringify(legacy)); await f.op({ action: "list" }); assert.deepEqual(JSON.parse(await readFile(f.file)), good);
  const b = await task(f); await f.op(await relation(f, b.id)); const stable = await readFile(f.file);
  const script = `import {createJiti} from 'jiti';const {taskOperation}=await createJiti(import.meta.url).import('./lib/task-operations.ts');console.log(JSON.stringify(await taskOperation({action:'list'},{agentDir:process.argv[1]})));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, f.agentDir], { env: process.env, encoding: "utf8" }); assert.equal(child.status, 0, child.stderr); assert.equal(owner(JSON.parse(child.stdout), f.w.sessionId).id, b.id); assert.deepEqual(await readFile(f.file), stable);
  const saved = JSON.parse(stable);
  for (const damage of [d => { delete d.sessionRelations; }, d => { d.sessionRelations = null; }, d => { d.sessionRelations[0].generation = -1; }, d => { delete d.tasks[0].sessionContexts[0].relationGeneration; }, d => { delete d.tasks[0].sessionUpdates[0].choices[0].relationGeneration; }]) {
    const bad = structuredClone(saved); damage(bad); const text = JSON.stringify(bad); await writeFile(f.file, text); await assert.rejects(f.op({ action: "list" }), { code: "storage-unavailable" }); assert.equal(await readFile(f.file, "utf8"), text);
  }
  await writeFile(f.file, stable);
});
