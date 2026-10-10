// Column deletion retains legacy adoption facts, but pending material is no longer delivered.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { legacyFixture, removal, seedLegacyVersion, seedLegacyChoice } from "./task-legacy-fixture.mjs";

for (const archived of [false, true]) test(`column removal preserves legacy pending/receipts (${archived ? "archived" : "active"}); ordinary send never consumes or injects it`, async t => {
  const f = await legacyFixture(t), { w, calls } = f.wrapper(); if (archived) await f.archive();
  const remove = removal(await f.list()), before = await f.raw(), history = await readFile(f.source.getSessionFile());
  const latest = await seedLegacyVersion(f, f.task.id, "LATER UNCHOSEN MATERIAL");
  assert.equal((await f.list()).columnRemovalDigests.todo, remove.expectedSourceDigest);
  const saved = await f.op(remove), after = await f.raw();
  for (const key of ["sessionContexts", "sessionUpdates", "archived", "archiveRevision", "archiveReceipt"]) assert.deepEqual(after.tasks[0][key], before.tasks[0][key]);
  assert.equal(saved.tasks[0].sharedContext.currentVersionId, latest.version.id);
  const bytes = await readFile(f.file); await w.send({ type: "prompt", message: "Ordinary after removal" });
  const input = JSON.stringify(calls.prompts[0].context); assert.match(input, /LEGACY NATIVE MATERIAL/); assert.doesNotMatch(input, /LEGACY PENDING MATERIAL|LATER UNCHOSEN MATERIAL/);
  assert.deepEqual(await f.op(remove), saved); await assert.rejects(f.op(f.legacy.pending), /suspended/);
  assert.deepEqual(await readFile(f.file), bytes); assert.deepEqual(await readFile(f.source.getSessionFile()), history);
});

test("independent legacy selection/delivery facts do not invalidate column digest; deleting during work never stops it", async t => {
  const f = await legacyFixture(t), preview = await f.list(), remove = removal(preview), { inner, calls } = f.wrapper();
  const version = await seedLegacyVersion(f, f.task.id, "Historical later version"); await seedLegacyChoice(f, f.task.id, f.sessionId, version.version.id, true);
  const pending = await seedLegacyChoice(f, f.task.id, f.sessionId, version.version.id);
  assert.equal((await f.list()).columnRemovalDigests.todo, remove.expectedSourceDigest);
  inner.isStreaming = true; const before = await f.raw(); await f.op(remove); const after = await f.raw();
  assert.deepEqual(after.tasks[0].sessionUpdates, before.tasks[0].sessionUpdates);
  assert.equal(after.tasks[0].sessionUpdates[0].pendingOperationId, pending.operationId); assert.equal(after.tasks[0].sessionUpdates[0].deliveries.length, 2);
  assert.equal(inner.isStreaming, true); assert.equal(calls.aborts, 0); assert.equal(calls.prompts.length, 0);
});

test("field edits and real link/copy mutations still invalidate old full-source digest without advancing columns/order", async t => {
  const f = await legacyFixture(t), { w } = f.wrapper();
  for (const mutation of ["edit", "link", "copy"]) {
    const board = await f.list(), task = board.tasks[0], request = removal(board);
    if (mutation === "edit") await f.op({ action: "edit", id: task.id, expectedRevision: task.revision, title: "Changed", description: task.description, completionCriteria: task.completionCriteria, priority: task.priority, labels: task.labels });
    if (mutation === "link") await f.op({ action: "link", id: task.id, expectedRevision: task.revision, sessionIds: [f.native().getSessionId()] });
    if (mutation === "copy") await w.send({ type: "fork_branch", entryId: f.source.getLeafId(), operationId: randomUUID() });
    const current = await f.list(), bytes = await readFile(f.file);
    assert.equal(current.columnsRevision, board.columnsRevision); assert.equal(current.orderRevision, board.orderRevision); assert.equal(current.tasks[0].revision, task.revision + 1);
    assert.notEqual(current.columnRemovalDigests.todo, request.expectedSourceDigest); await assert.rejects(f.op(request), { code: "conflict" }); assert.deepEqual(await readFile(f.file), bytes);
  }
});
