// Main10×14: real temporary SDK/store/fake Provider; no user history or external models.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createJiti } from "jiti";
import { contextUpdateFixture, settle } from "./task-context-updates-fixture.mjs";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { prepareContextUpdateSend } = await jiti.import("./task-context-update-send.ts");
const { contextUpdateBoundary } = await jiti.import("./task-context-updates.ts");
const { emptyTaskFilter, projectTaskView } = await jiti.import("./task-view.ts");
const { taskColumnRemovalDigest } = await jiti.import("./task-store.ts");
const remove = (board, columnId = "todo", targetColumnId = "done") => ({ action: "remove-column", columnId, targetColumnId,
  expectedColumnsRevision: board.columnsRevision, expectedOrderRevision: board.orderRevision,
  expectedSourceDigest: board.columnRemovalDigests[columnId], confirmCompletion: true, operationId: randomUUID() });
async function target(f) {
  const task = (await f.op({ action: "create", id: randomUUID(), title: "Target B", description: "", completionCriteria: "", cwd: null })).task;
  const board = await f.op({ action: "list" });
  return (await f.op({ action: "move", id: task.id, columnId: "review", expectedRevision: task.revision,
    expectedOrderRevision: board.orderRevision, operationId: randomUUID(), position: { edge: "end" } })).task;
}
async function change(f, targetTaskId) {
  const state = await f.state();
  return { action: "change-session-relation", sessionId: f.w.sessionId, sourceTaskId: state.task.id, targetTaskId,
    expectedGeneration: state.relationGeneration, expectedUpdateRevision: state.state.revision, operationId: randomUUID() };
}
function assertDigests(board) {
  assert.deepEqual(board.columnRemovalDigests, Object.fromEntries(board.columns.map(c => [c.id, taskColumnRemovalDigest(board.tasks, c.id)])));
}
const lateDelivery = operationId => ({ operationId, entryId: "late-entry", inputHash: "a".repeat(64), provider: "fixture", model: "fixture",
  sentAt: new Date().toISOString(), evidence: "sdk-input-successful-response" });

test("pending→reassign invalidates BOTH affected column digests; deleteDONE preserves adoption/generation, old callbacks cannot clear new pending", async t => {
  const f = await contextUpdateFixture(t), b = await target(f), v = await f.publish("OLD UNSENT CHOICE"), oldChoice = await f.accept(v);
  const before = await f.op({ action: "list" }), oldSource = remove(before), oldTarget = remove(before, "review"), relation = await change(f, b.id);
  const moved = await f.op(relation), stored = JSON.parse(await readFile(f.file));
  for (const id of [f.task.id, b.id]) assert.equal(moved.tasks.find(x => x.id === id).revision, before.tasks.find(x => x.id === id).revision + 1);
  for (const key of ["orderRevision", "columnsRevision", "viewsRevision"]) assert.equal(moved[key], before[key]);
  for (const stale of [oldSource, oldTarget]) await assert.rejects(f.op(stale), { code: "conflict" });
  const removal = remove(moved), history = await readFile(f.w.sessionFile), removed = await f.op(removal), after = JSON.parse(await readFile(f.file));
  assert.deepEqual(after.sessionRelations, stored.sessionRelations);
  for (const task of after.tasks) {
    const original = stored.tasks.find(x => x.id === task.id);
    assert.deepEqual(task.sessionUpdates, original.sessionUpdates);
    assert.deepEqual(task.sessionContexts, original.sessionContexts);
  }
  assert.equal(removed.tasks.find(x => x.id === f.task.id).columnId, "done");
  assertDigests(removed); assert.equal("columnRemovalDigests" in after, false);
  const selected = (await f.op({ action: "publish-context", id: b.id, expectedCurrentVersionId: null, operationId: randomUUID(),
    content: { goal: "NEW TARGET PENDING", decisions: "", progress: "", nextSteps: "" } })).task.sharedContext.currentVersionId;
  const choice = { action: "accept-context-update", id: b.id, sessionId: f.w.sessionId, expectedRevision: 0,
    expectedRelationGeneration: 1, operationId: randomUUID(), versionId: selected }; await f.op(choice);
  const current = await f.op({ action: "list" }), stable = await readFile(f.file);
  assert.deepEqual(await f.op(relation), current, "historical relation receipt confirms only, never clears target pending");
  await assert.rejects(f.op({ action: "complete-context-update", id: f.task.id, sessionId: f.w.sessionId,
    relationGeneration: 0, delivery: lateDelivery(oldChoice.operationId) }), { code: "conflict" });
  assert.deepEqual(await readFile(f.file), stable); assert.deepEqual(await readFile(f.w.sessionFile), history);
  assert.equal((await f.state()).state.pendingOperationId, choice.operationId);
  assert.deepEqual(await f.op(removal), current, "exact deletion confirms same latest digest authority");
  await f.send("Independent user Send after deletion"); await settle(f.w);
  const input = JSON.stringify(f.captures.at(-1).context.messages);
  assert.ok(input.includes(selected)); assert.ok(!input.includes(v)); assert.ok(input.includes(f.first));
  assert.equal((await f.state()).state.deliveries.length, 1);
});

test("actual old SDK observer across reassign→delete→ABA cannot write delivery; fresh same-task choice remains pending", async t => {
  const f = await contextUpdateFixture(t), b = await target(f), v = await f.publish("OLD NATIVE CONTRIBUTION"), choice = await f.accept(v);
  const restore = await prepareContextUpdateSend(f.w.inner, f.agentDir, new AbortController().signal, () => true, contextUpdateBoundary());
  t.after(restore);
  const converted = await f.w.inner.agent.convertToLlm(f.w.inner.sessionManager.buildSessionProjection().messages);
  const gate = Promise.withResolvers(); t.after(() => gate.resolve());
  f.setResponse(async () => { await gate.promise; return { role: "assistant", content: [{ type: "text", text: "Late" }], stopReason: "stop", timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }; });
  const stream = await f.w.inner.agent.streamFunction(f.w.inner.model, { messages: converted, tools: [] }, {});
  await f.op(await change(f, b.id)); await f.op(remove(await f.op({ action: "list" })));
  await f.op(await change(f, f.task.id));
  const state = await f.state(), next = { ...choice, operationId: randomUUID(), expectedRevision: state.state.revision, expectedRelationGeneration: state.relationGeneration };
  await f.op(next); const stable = await readFile(f.file);
  gate.resolve(); await stream.result(); restore(); await new Promise(r => setTimeout(r, 80));
  assert.deepEqual(await readFile(f.file), stable);
  assert.equal((await f.state()).state.pendingOperationId, next.operationId); assert.equal((await f.state()).state.deliveries.length, 0);
  assert.equal(f.w.inner.sessionManager.getEntries().filter(e => e.customType === "pi-web:task-context-send").length, 0);
  await assert.rejects(f.op(choice), { code: "conflict" });
  assertDigests(await f.op({ action: "list" }));
});

test("archiveowner→delete→reassign/newsend remains gated; restore only then reassign clears intent without Stop or target injection", async t => {
  const f = await contextUpdateFixture(t), b = await target(f), v = await f.publish("ARCHIVED CHOICE"); await f.accept(v);
  await f.op({ action: "set-archive", id: f.task.id, archived: true, expectedArchiveRevision: 0, operationId: randomUUID() });
  const board = await f.op({ action: "list" }), relation = await change(f, b.id);
  await f.op(remove(board)); const stable = await readFile(f.file), count = f.captures.length;
  await assert.rejects(f.op(relation), /archived/); await assert.rejects(f.send("No archive bypass"), /archived/);
  await assert.rejects(f.op({ action: "prepare-start", id: f.task.id, operationId: randomUUID(), sessionId: null }), /archived/);
  assert.deepEqual(await readFile(f.file), stable); assert.equal(f.captures.length, count);
  const restore = { action: "set-archive", id: f.task.id, archived: false, expectedArchiveRevision: 1, operationId: randomUUID() };
  await f.op(restore); await f.op(relation);
  assert.equal((await f.state()).task.id, b.id);
  await f.send("User after explicit restore and reassign"); await settle(f.w);
  assert.ok(!JSON.stringify(f.captures.at(-1).context.messages).includes(v));
  assert.equal((await f.op({ action: "list" })).tasks.find(x => x.id === f.task.id).columnId, "done");
});

test("failed relation and removal retries are atomic; saved deleted-column view stays failclosed through later relationship receipts", async t => {
  const f = await contextUpdateFixture(t), b = await target(f), v = await f.publish("RETRY PENDING"); await f.accept(v);
  const filter = { ...emptyTaskFilter(), columnIds: ["todo"] }, view = { action: "save-view", id: randomUUID(), operationId: randomUUID(), expectedViewsRevision: 0,
    name: "Old column", filter, sort: "manual" }; await f.op(view);
  const relation = await change(f, b.id), stable = await readFile(f.file);
  await chmod(join(f.agentDir, "tasks"), 0o500);
  try { await assert.rejects(f.op(relation), { code: "storage-unavailable" }); assert.deepEqual(await readFile(f.file), stable); }
  finally { await chmod(join(f.agentDir, "tasks"), 0o700); }
  const moved = await f.op(relation), removal = remove(moved), original = await readFile(f.file);
  await chmod(join(f.agentDir, "tasks"), 0o500);
  try { await assert.rejects(f.op(removal), { code: "storage-unavailable" }); assert.deepEqual(await readFile(f.file), original); }
  finally { await chmod(join(f.agentDir, "tasks"), 0o700); }
  const removed = await f.op(removal), bytes = await readFile(f.file);
  assert.deepEqual(await f.op(relation), removed); assert.deepEqual(await f.op(removal), removed); assert.deepEqual(await f.op(view), removed);
  assert.deepEqual(await readFile(f.file), bytes); assert.deepEqual(removed.savedViews[0].filter, filter);
  const projected = projectTaskView(removed, filter, "manual", new Set(), false);
  assert.equal(projected.invalid, true); assert.deepEqual(projected.tasks, []); assertDigests(removed);
});

test("already committed delivery and relation receipts after ABA/delete confirm facts without clearing fresh pending or rebind", async t => {
  const f = await contextUpdateFixture(t), b = await target(f), v = await f.publish("COMMITTED OLD FACT"), choice = await f.accept(v);
  await f.send("First successful update"); await settle(f.w);
  const delivery = (await f.state()).state.deliveries[0]; assert.equal(delivery.operationId, choice.operationId);
  await f.op(await change(f, b.id)); const back = await change(f, f.task.id); await f.op(back);
  await f.op(remove(await f.op({ action: "list" })));
  const state = await f.state(), next = { ...choice, operationId: randomUUID(), expectedRevision: state.state.revision, expectedRelationGeneration: state.relationGeneration };
  await f.op(next); const current = await f.op({ action: "list" }), stable = await readFile(f.file);
  const confirmed = await f.op({ action: "complete-context-update", id: f.task.id, sessionId: f.w.sessionId, relationGeneration: 0, delivery });
  assert.deepEqual(confirmed.board, current); assert.deepEqual(await f.op(back), current);
  assert.deepEqual(await readFile(f.file), stable); assert.equal((await f.state()).state.pendingOperationId, next.operationId);
  assert.equal((await f.state()).state.deliveries.length, 1); assertDigests(current);
});

test("v6→v7 migration retains actual14 receipt, choices/start/history/views/archive/order; receipt retry and malformed removal metadata failclosed", async t => {
  const f = await contextUpdateFixture(t), v = await f.publish("MIGRATION PENDING"); await f.accept(v);
  const removal = remove(await f.op({ action: "list" })), board = await f.op(removal), good = JSON.parse(await readFile(f.file));
  const legacy = structuredClone(good); legacy.version = 6; delete legacy.sessionRelations;
  for (const task of legacy.tasks) {
    for (const c of task.sessionContexts) { delete c.relationGeneration; delete c.selection.expectedRelationGeneration; }
    for (const s of task.sessionUpdates) for (const c of s.choices) delete c.relationGeneration;
  }
  await writeFile(f.file, JSON.stringify(legacy)); assert.deepEqual(await f.op({ action: "list" }), board);
  assert.deepEqual(JSON.parse(await readFile(f.file)), good); const bytes = await readFile(f.file);
  assert.deepEqual(await f.op(removal), board); assert.deepEqual(await readFile(f.file), bytes); assertDigests(board);
  for (const receipt of [null, {}, { operationId: randomUUID(), fingerprint: "bad" }]) {
    const bad = { ...good, columnRemovalReceipt: receipt }; await writeFile(f.file, JSON.stringify(bad)); const unchanged = await readFile(f.file);
    await assert.rejects(f.op({ action: "list" }), { code: "storage-unavailable" }); assert.deepEqual(await readFile(f.file), unchanged);
  }
  await writeFile(f.file, bytes);
});
