import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { contextUpdateFixture, attachFakeProvider, settle } from "./task-context-updates-fixture.mjs";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { startRpcSession } = await jiti.import("./rpc-manager.ts");
const { copySessionWithTask } = await jiti.import("./task-session-copy.ts");
async function target(f) { return (await f.op({ action: "create", id: randomUUID(), title: "B", description: "", completionCriteria: "", cwd: null })).task; }
async function change(f, targetTaskId) {
  const state = await f.state();
  return f.op({ action: "change-session-relation", sourceTaskId: state.task.id, targetTaskId, sessionId: f.w.sessionId, expectedGeneration: state.relationGeneration, expectedUpdateRevision: state.state.revision, operationId: randomUUID() });
}
const delivery = operationId => ({ operationId, entryId: "synthetic-late-entry", inputHash: "a".repeat(64), provider: "fixture", model: "fixture", sentAt: new Date().toISOString(), evidence: "sdk-input-successful-response" });

test("09 old completion fails after one-way A→B and after ABA; already committed delivery confirms fact without re-pending or writing", async t => {
  const f = await contextUpdateFixture(t), b = await target(f), v = await f.publish("DELIVERED FACT");
  const choice = await f.accept(v); await f.send("Actual successful choice"); await settle(f.w);
  const recorded = (await f.state()).state.deliveries[0]; assert.equal(recorded.operationId, choice.operationId);
  const late = await f.accept(v); await change(f, b.id);
  const bytes = await readFile(f.file);
  await assert.rejects(f.op({ action: "complete-context-update", id: f.task.id, sessionId: f.w.sessionId, relationGeneration: 0, delivery: delivery(late.operationId) }), { code: "conflict" }); assert.deepEqual(await readFile(f.file), bytes);
  await change(f, f.task.id); const stable = await readFile(f.file);
  await f.op({ action: "complete-context-update", id: f.task.id, sessionId: f.w.sessionId, relationGeneration: 0, delivery: recorded }); assert.deepEqual(await readFile(f.file), stable);
  await assert.rejects(f.op({ action: "complete-context-update", id: f.task.id, sessionId: f.w.sessionId, relationGeneration: 0, delivery: delivery(late.operationId) }), { code: "conflict" });
  assert.equal((await f.state()).state.pendingOperationId, null); assert.equal((await f.state()).state.deliveries.length, 1);
});

test("11 unowned→owned→unowned ABA invalidates null-owner copy intent and known-child retry", async t => {
  const f = await contextUpdateFixture(t); await change(f, null);
  const request = { type: "fork_branch", entryId: f.w.inner.sessionManager.getLeafId(), operationId: randomUUID() }, entered = Promise.withResolvers(), release = Promise.withResolvers(); let copies = 0, childId;
  const execute = async () => { copies++; const file = SessionManager.open(f.w.sessionFile).createBranchedSession(request.entryId); childId = SessionManager.open(file).getSessionId(); entered.resolve(); await release.promise; return { cancelled: false, newSessionId: childId }; };
  const pending = copySessionWithTask(f.agentDir, f.w.sessionId, request, execute).catch(e => e); await entered.promise;
  const task = (await f.op({ action: "list" })).tasks.find(t => t.id === f.task.id);
  await f.op({ action: "link", id: task.id, expectedRevision: task.revision, sessionIds: [f.w.sessionId] }); await change(f, null);
  release.resolve(); assert.equal((await pending).taskCode, "conflict");
  await assert.rejects(copySessionWithTask(f.agentDir, f.w.sessionId, request, execute), e => e.taskCode === "conflict"); assert.equal(copies, 1);
  assert.equal((await f.op({ action: "list" })).tasks.some(t => t.sessionIds.includes(childId)), false);
});

test("archive-first vs reassign-first vs task-start: target cannot run hidden and source cannot be silently restored", async t => {
  const f = await contextUpdateFixture(t), b = await target(f), state = await f.state();
  const request = { action: "change-session-relation", sourceTaskId: f.task.id, targetTaskId: b.id, sessionId: f.w.sessionId, expectedGeneration: state.relationGeneration, expectedUpdateRevision: state.state.revision, operationId: randomUUID() };
  const archive = { action: "set-archive", id: b.id, archived: true, expectedArchiveRevision: 0, operationId: randomUUID() };
  // Deterministic actual idle-snapshot barrier, not an assumption that async mkdir queues in call order.
  const p = await f.op({ action: "prepare-start", id: b.id, operationId: randomUUID(), sessionId: null });
  const targetWrapper = (await startRpcSession(p.selection.operationId, "", f.cwd, { newSessionId: p.selection.operationId, toolNames: [] })).session;
  t.after(() => targetWrapper.shutdown()); await targetWrapper.waitUntilReady(); await attachFakeProvider(targetWrapper);
  await targetWrapper.send({ type: "prompt", message: "Target synthetic history", taskStart: p.selection }); await settle(targetWrapper);
  const original = targetWrapper.getActivitySnapshot.bind(targetWrapper); let reassign;
  targetWrapper.getActivitySnapshot = () => { const idle = original(); targetWrapper.getActivitySnapshot = original; reassign = f.op(request).catch(e => e); return idle; };
  await f.op(archive); assert.ok(reassign); assert.equal((await reassign).code, "conflict"); assert.equal((await f.state()).task.id, f.task.id);
  await f.op({ ...archive, archived: false, expectedArchiveRevision: 1, operationId: randomUUID() }); await f.op(request);
  const prepared = await f.op({ action: "prepare-start", id: b.id, operationId: randomUUID(), sessionId: f.w.sessionId });
  await f.op({ ...archive, expectedArchiveRevision: 2, operationId: randomUUID() }); const count = f.captures.length;
  await assert.rejects(f.send("Prepared before archive", { taskStart: prepared.selection }), /archived/); await assert.rejects(f.send("Original chat bypass"), /archived/); assert.equal(f.captures.length, count);
  assert.equal((await f.state()).task.archived, true);
});

test("actual pending snapshot vs relation race observes reservation, not stale cached UI; relation wins before next eligible Send sees only target", async t => {
  const f = await contextUpdateFixture(t), b = await target(f), v = await f.publish("NEVER AUTO PENDING"); await f.accept(v);
  // Change fully commits before ordinary admission; no taskStart metadata can accidentally recover old08 selection.
  await change(f, b.id); const count = f.captures.length; await f.send("Next actual input"); await settle(f.w);
  assert.equal(f.captures.length, count + 1); const input = JSON.stringify(f.captures.at(-1).context.messages);
  assert.ok(!input.includes(v)); assert.ok(input.includes(f.first), "old native history is not erased or forgotten"); assert.equal((await f.state()).task.id, b.id);
});
