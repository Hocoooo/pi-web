// R1/R2: deliberate damaged-store probes, not a demonstrated normal-flow ABA bypass.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { contextUpdateFixture, settle } from "./task-context-updates-fixture.mjs";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { taskOperation } = await jiti.import("./task-operations.ts");
const { emptyTaskFilter } = await jiti.import("./task-view.ts");
const { taskColumnRemovalDigest } = await jiti.import("./task-store.ts");
const raw = async f => JSON.parse(await readFile(f.file));
function fresh(f, action = "list") {
  const input = action === "list" ? { action } : { action, sessionId: f.w.sessionId };
  const script = `import {createJiti} from 'jiti';const {taskOperation}=await createJiti(import.meta.url).import('./lib/task-operations.ts');try{console.log(JSON.stringify({ok:true,value:await taskOperation(JSON.parse(process.argv[2]),{agentDir:process.argv[1]})}));}catch(e){console.log(JSON.stringify({ok:false,code:e.code}));}`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script, f.agentDir, JSON.stringify(input)], { env: process.env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
}
async function rejectsUnchanged(f, document) {
  const text = JSON.stringify(document); await writeFile(f.file, text);
  for (let i = 0; i < 2; i++) {
    for (const action of ["list", "context-update-state"]) {
      await assert.rejects(f.op(action === "list" ? { action } : { action, sessionId: f.w.sessionId }), { code: "storage-unavailable" });
      assert.equal(await readFile(f.file, "utf8"), text);
      assert.deepEqual(fresh(f, action), { ok: false, code: "storage-unavailable" });
      assert.equal(await readFile(f.file, "utf8"), text, "every fresh rejection preserves original bytes, including first legacy read");
    }
  }
}
async function prepare(f) {
  const request = { action: "prepare-session-copy", operationId: randomUUID(), sourceSessionId: f.w.sessionId, fingerprint: "b".repeat(64) };
  await taskOperation(request, { agentDir: f.agentDir, sessionCopy: true }); return request;
}
async function change(f, targetTaskId) {
  const state = await f.state();
  return f.op({ action: "change-session-relation", sessionId: f.w.sessionId, sourceTaskId: state.task.id, targetTaskId,
    expectedGeneration: state.relationGeneration, expectedUpdateRevision: state.state.revision, operationId: randomUUID() });
}
async function aba(f, completeAtOne = false) {
  const b = (await f.op({ action: "create", id: randomUUID(), title: "Other owner", description: "", completionCriteria: "", cwd: null })).task;
  await change(f, b.id); await prepare(f);
  let completed;
  if (completeAtOne) {
    const command = { type: "fork_branch", entryId: f.w.inner.sessionManager.getLeafId(), operationId: randomUUID() };
    completed = { command, result: await f.w.send(command), ownerId: b.id };
  }
  await change(f, f.task.id); return completed;
}
function legacySix(good, omitEpochs = false) {
  const document = structuredClone(good); document.version = 6; delete document.sessionRelations;
  if (omitEpochs) {
    for (const task of document.tasks) {
      for (const c of task.sessionContexts) { delete c.relationGeneration; delete c.selection.expectedRelationGeneration; }
      for (const state of task.sessionUpdates) for (const c of state.choices) delete c.relationGeneration;
    }
    for (const receipt of document.sessionCopies) delete receipt.sourceRelationGeneration;
  }
  return document;
}

for (const status of ["prepared", "completed"]) for (const authority of [0, 2]) {
  test(`R1 v7 ${status} copy future epoch > authority${authority} rejects list/state and twice fresh reopen without overwriting`, async t => {
    const f = await contextUpdateFixture(t);
    let operationId;
    if (status === "prepared") operationId = (await prepare(f)).operationId;
    else {
      const command = { type: "fork_branch", entryId: f.w.inner.sessionManager.getLeafId(), operationId: randomUUID() };
      await f.w.send(command); operationId = command.operationId;
    }
    if (authority === 2) await aba(f);
    const bad = await raw(f), receipt = bad.sessionCopies.find(r => r.operationId === operationId);
    assert.equal(receipt.status, status); assert.equal((await f.state()).relationGeneration, authority);
    receipt.sourceRelationGeneration = authority + 1;
    await rejectsUnchanged(f, bad);
  });
}

for (const domain of ["start", "choice", "copy"]) {
  test(`R2 legacy v6 ${domain} present epoch1/default authority0 refuses BEFORE migration, including two fresh processes`, async t => {
    const f = await contextUpdateFixture(t), v = await f.publish("Legacy explicit pending"); await f.accept(v); await prepare(f);
    const bad = legacySix(await raw(f));
    if (domain === "start") { bad.tasks[0].sessionContexts[0].relationGeneration = 1; bad.tasks[0].sessionContexts[0].selection.expectedRelationGeneration = 1; }
    if (domain === "choice") bad.tasks[0].sessionUpdates[0].choices[0].relationGeneration = 1;
    if (domain === "copy") bad.sessionCopies[0].sourceRelationGeneration = 1;
    await rejectsUnchanged(f, bad);
  });
}

test("legal v6 missing/present epoch0 migrates before two fresh reopens;14 receipt/digest and09 pending/delivery/history/archive/views/start/copy/order preserved", async t => {
  const f = await contextUpdateFixture(t), v = await f.publish("Delivered immutable version"); await f.accept(v);
  await f.send("Actual successful09 input"); await settle(f.w);
  const v2 = await f.publish("Explicit later pending"); await f.accept(v2);
  const prepared = await prepare(f), copy = { type: "fork_branch", entryId: f.w.inner.sessionManager.getLeafId(), operationId: randomUUID() };
  const child = await f.w.send(copy);
  const view = { action: "save-view", id: randomUUID(), operationId: randomUUID(), expectedViewsRevision: 0,
    name: "Migration view", filter: emptyTaskFilter(), sort: "updated" }; await f.op(view);
  const archive = { action: "set-archive", id: f.task.id, archived: true, expectedArchiveRevision: 0, operationId: randomUUID() }; await f.op(archive);
  const before = await f.op({ action: "list" }), remove = { action: "remove-column", columnId: "todo", targetColumnId: "done",
    expectedColumnsRevision: before.columnsRevision, expectedOrderRevision: before.orderRevision, expectedSourceDigest: before.columnRemovalDigests.todo,
    confirmCompletion: true, operationId: randomUUID() };
  const board = await f.op(remove), good = await raw(f), native = await readFile(f.w.sessionFile), count = f.captures.length;
  assert.equal(good.sessionCopies.length, 2); assert.equal(good.tasks[0].sessionUpdates[0].deliveries.length, 1);
  assert.equal("columnRemovalDigests" in good, false);
  for (const omitEpochs of [false, true]) {
    await writeFile(f.file, JSON.stringify(legacySix(good, omitEpochs)));
    assert.deepEqual(fresh(f), { ok: true, value: board }, "first fresh-process migration preserves all domains");
    assert.deepEqual(await raw(f), good);
    const bytes = await readFile(f.file);
    for (let i = 0; i < 2; i++) {
      assert.deepEqual(fresh(f), { ok: true, value: board });
      const state = fresh(f, "context-update-state"); assert.equal(state.ok, true); assert.equal(state.value.relationGeneration, 0);
      assert.equal(state.value.state.pendingOperationId, good.tasks[0].sessionUpdates[0].pendingOperationId);
      assert.deepEqual(await readFile(f.file), bytes);
    }
    for (const request of [remove, view, archive]) { const response = await f.op(request); assert.deepEqual(response.board ?? response, board); }
    assert.deepEqual(await f.w.send(copy), child);
    assert.equal((await taskOperation(prepared, { agentDir: f.agentDir, sessionCopy: true })).receipt.sourceRelationGeneration, 0);
    assert.deepEqual(await readFile(f.file), bytes);
  }
  assert.deepEqual(board.columnRemovalDigests, Object.fromEntries(board.columns.map(c => [c.id, taskColumnRemovalDigest(board.tasks, c.id)])));
  assert.deepEqual(await readFile(f.w.sessionFile), native); assert.equal(f.captures.length, count, "migration/receipt confirmation dispatch nothing");
});

test("legal older prepared/completed epochs0/1 survive authority2 ABA and fresh reopen;completed confirms fact,prepared still rejects new execution", async t => {
  const f = await contextUpdateFixture(t), prepared = await prepare(f);
  const command = { type: "fork_branch", entryId: f.w.inner.sessionManager.getLeafId(), operationId: randomUUID() }, child = await f.w.send(command);
  const epochOne = await aba(f, true);
  const good = await raw(f), bytes = await readFile(f.file), board = await f.op({ action: "list" });
  assert.deepEqual(good.sessionCopies.map(r => r.sourceRelationGeneration), [0, 0, 1, 1]);
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(fresh(f), { ok: true, value: board });
    const state = fresh(f, "context-update-state"); assert.equal(state.ok, true); assert.equal(state.value.relationGeneration, 2);
  }
  assert.deepEqual(await f.w.send(command), child);
  assert.deepEqual(await f.w.send(epochOne.command), epochOne.result);
  assert.equal((await f.op({ action: "list" })).tasks.find(task => task.sessionIds.includes(epochOne.result.newSessionId)).id, epochOne.ownerId, "completed epoch1 fact does not rebind its child to today's source owner");
  await assert.rejects(taskOperation(prepared, { agentDir: f.agentDir, sessionCopy: true }), { code: "conflict" });
  assert.deepEqual(await readFile(f.file), bytes); assert.deepEqual(await raw(f), good, "historical epochs/receipts are retained, never reset or rebound");
});

test("existing start/choice future-epoch checks remain byte-preserving after target hydration validation moves", async t => {
  const f = await contextUpdateFixture(t), v = await f.publish("Choice audit"); await f.accept(v);
  const good = await raw(f);
  for (const domain of ["start", "choice"]) {
    const bad = structuredClone(good);
    if (domain === "start") { bad.tasks[0].sessionContexts[0].relationGeneration = 1; bad.tasks[0].sessionContexts[0].selection.expectedRelationGeneration = 1; }
    else bad.tasks[0].sessionUpdates[0].choices[0].relationGeneration = 1;
    await rejectsUnchanged(f, bad);
  }
});
