// Relation/column compatibility remains active; old shared delivery execution is suspended.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { legacyFixture, removal, seedLegacyVersion, seedLegacyChoice, taskColumnRemovalDigest, emptyTaskFilter, projectTaskView, legacySix } from "./task-legacy-fixture.mjs";
const assertDigests = board => assert.deepEqual(board.columnRemovalDigests, Object.fromEntries(board.columns.map(c => [c.id, taskColumnRemovalDigest(board.tasks, c.id)])));
async function target(f) { const task = await f.create(); await f.move(task.id, "review"); return task; }

test("reassign invalidates both column digests; deletion retains epoch/history; old receipts cannot clear new pending", async t => {
  const f = await legacyFixture(t), b = await target(f), before = await f.list(), oldSource = removal(before), oldTarget = removal(before, "review", "done"), relation = await f.relation(b.id);
  const moved = await f.op(relation), stored = await f.raw();
  for (const id of [f.task.id, b.id]) assert.equal(moved.tasks.find(t => t.id === id).revision, before.tasks.find(t => t.id === id).revision + 1);
  for (const key of ["orderRevision", "columnsRevision", "viewsRevision"]) assert.equal(moved[key], before[key]);
  for (const request of [oldSource, oldTarget]) await assert.rejects(f.op(request), { code: "conflict" });
  const remove = removal(moved, "todo", "done"); await f.op(remove); const after = await f.raw();
  assert.deepEqual(after.sessionRelations, stored.sessionRelations);
  for (const task of after.tasks) for (const key of ["sessionUpdates", "sessionContexts", "sharedContext"]) assert.deepEqual(task[key], stored.tasks.find(t => t.id === task.id)[key]);
  const version = await seedLegacyVersion(f, b.id, "TARGET PENDING NEVER INJECT");
  const choice = await seedLegacyChoice(f, b.id, f.sessionId, version.version.id);
  const current = await f.list(), stable = await readFile(f.file);
  assert.deepEqual(await f.op(relation), current); assert.deepEqual(await f.op(remove), current); assertDigests(current);
  await assert.rejects(f.op({ action: "complete-context-update", id: f.task.id, sessionId: f.sessionId, relationGeneration: 0, delivery: stored.tasks[0].sessionUpdates[0].deliveries[0] }), /suspended/);
  assert.equal((await f.current(b.id)).sessionUpdates[0].pendingOperationId, choice.operationId);
  assert.deepEqual(await readFile(f.file), stable); assert.equal("columnRemovalDigests" in after, false);
});

test("archive then delete then busy reassign does not restore/stop/inject or erase native records", async t => {
  const f = await legacyFixture(t), b = await target(f), { w, inner, calls } = f.wrapper(); inner.isStreaming = true;
  const history = await readFile(f.source.getSessionFile()); await f.archive(); await f.op(removal(await f.list(), "todo", "done")); await f.change(b.id);
  assert.equal((await f.current()).archived, true); assert.equal((await f.current()).columnId, "done"); assert.equal(inner.isStreaming, true); assert.equal(calls.aborts, 0);
  inner.isStreaming = false; await w.send({ type: "prompt", message: "Ordinary" });
  assert.doesNotMatch(JSON.stringify(calls.prompts[0].context), /LEGACY PENDING MATERIAL/);
  assert.deepEqual(await readFile(f.source.getSessionFile()), history);
});

test("failed relation/deletion writes are atomic; exact retries return current digests and deleted-column view stays failclosed", { skip: process.platform === "win32" ? "POSIX permissions" : false }, async t => {
  const f = await legacyFixture(t), b = await target(f), filter = { ...emptyTaskFilter(), columnIds: ["todo"] };
  const view = { action: "save-view", id: randomUUID(), operationId: randomUUID(), expectedViewsRevision: 0, name: "Old column", filter, sort: "manual" }; await f.op(view);
  const relation = await f.relation(b.id);
  for (const request of [relation, null]) {
    const input = request ?? removal(await f.list()), before = await readFile(f.file); await chmod(dirname(f.file), 0o500);
    try { await assert.rejects(f.op(input), { code: "storage-unavailable" }); assert.deepEqual(await readFile(f.file), before); }
    finally { await chmod(dirname(f.file), 0o700); }
    await f.op(input); const board = await f.list(), bytes = await readFile(f.file);
    assert.deepEqual(await f.op(input), board); assert.deepEqual(await readFile(f.file), bytes);
  }
  const current = await f.list(); assert.deepEqual(await f.op(relation), current); assert.deepEqual(await f.op(view), current);
  assert.deepEqual(projectTaskView(current, filter, "manual", new Set(), false), { tasks: [], invalid: true }); assertDigests(current);
});

test("v6 migration preserves column receipt plus all legacy domains; malformed removal metadata refuses unchanged", async t => {
  const f = await legacyFixture(t), remove = removal(await f.list()), board = await f.op(remove), good = await f.raw();
  await writeFile(f.file, JSON.stringify(legacySix(good, true))); assert.deepEqual(f.fresh().value, board); assert.deepEqual(await f.raw(), good);
  const bytes = await readFile(f.file); assert.deepEqual(await f.op(remove), board); assert.deepEqual(await readFile(f.file), bytes);
  for (const receipt of [null, {}, { operationId: randomUUID(), fingerprint: "bad" }]) {
    const text = JSON.stringify({ ...good, columnRemovalReceipt: receipt }); await writeFile(f.file, text);
    await assert.rejects(f.list(), { code: "storage-unavailable" }); assert.equal(await readFile(f.file, "utf8"), text);
  }
});
