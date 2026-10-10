// Hydrated-target epoch validation is retained independently of retired execution APIs.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { legacyFixture, legacySix, taskOperation, removal, emptyTaskFilter, owner } from "./task-legacy-fixture.mjs";
async function prepare(f) {
  const request = { action: "prepare-session-copy", operationId: randomUUID(), sourceSessionId: f.sessionId, fingerprint: "b".repeat(64) };
  await taskOperation(request, { agentDir: f.agentDir, sessionCopy: true }); return request;
}
async function rejectUnchanged(f, document) {
  const bytes = JSON.stringify(document); await writeFile(f.file, bytes);
  await assert.rejects(f.list(), { code: "storage-unavailable" });
  for (let i = 0; i < 2; i++) { assert.deepEqual(f.fresh(), { code: "storage-unavailable" }); assert.equal(await readFile(f.file, "utf8"), bytes); }
}
for (const status of ["prepared", "completed"]) for (const authority of [0, 2]) test(`future ${status} copy epoch rejects before any migration/write (authority ${authority})`, async t => {
  const f = await legacyFixture(t), request = await prepare(f);
  if (status === "completed") await taskOperation({ ...request, action: "complete-session-copy", newSessionId: null }, { agentDir: f.agentDir, sessionCopy: true });
  if (authority) { const b = await f.create(); await f.change(b.id); await f.change(f.task.id); }
  const bad = await f.raw(); bad.sessionCopies.find(r => r.operationId === request.operationId).sourceRelationGeneration = authority + 1;
  await rejectUnchanged(f, bad);
});
for (const domain of ["start", "choice", "copy"]) test(`legacy v6 present nonzero ${domain} epoch refuses before hydration writes`, async t => {
  const f = await legacyFixture(t); await prepare(f); const bad = legacySix(await f.raw());
  if (domain === "start") { bad.tasks[0].sessionContexts[0].relationGeneration = 1; bad.tasks[0].sessionContexts[0].selection.expectedRelationGeneration = 1; }
  if (domain === "choice") bad.tasks[0].sessionUpdates[0].choices[0].relationGeneration = 1;
  if (domain === "copy") bad.sessionCopies[0].sourceRelationGeneration = 1;
  await rejectUnchanged(f, bad);
});

test("legal missing/present epoch0 preserves start/pending/delivery/AI/archive/views/copy/column receipts across fresh migrations", async t => {
  const f = await legacyFixture(t), { w } = f.wrapper(), prepared = await prepare(f);
  const command = { type: "fork_branch", entryId: f.source.getLeafId(), operationId: randomUUID() }, child = await w.send(command);
  const view = { action: "save-view", id: randomUUID(), operationId: randomUUID(), expectedViewsRevision: 0, name: "Migration", filter: emptyTaskFilter(), sort: "updated" }; await f.op(view);
  const archive = await f.archiveRequest(); await f.op(archive);
  const remove = removal(await f.list(), "todo", "done"), board = await f.op(remove), good = await f.raw(), history = await readFile(f.source.getSessionFile());
  for (const omit of [false, true]) {
    await writeFile(f.file, JSON.stringify(legacySix(good, omit))); assert.deepEqual(f.fresh().value, board); assert.deepEqual(await f.raw(), good);
    const bytes = await readFile(f.file); assert.deepEqual(f.fresh().value, board);
    for (const request of [view, archive, remove]) { const reply = await f.op(request); assert.deepEqual(reply.board ?? reply, board); }
    assert.deepEqual(await w.send(command), child); assert.equal((await taskOperation(prepared, { agentDir: f.agentDir, sessionCopy: true })).receipt.sourceRelationGeneration, 0);
    assert.deepEqual(await readFile(f.file), bytes);
  }
  assert.deepEqual(await readFile(f.source.getSessionFile()), history);
});

test("older prepared/completed epoch0/1 receipts survive authority2; completed confirms fact but prepared cannot execute", async t => {
  const f = await legacyFixture(t), { w } = f.wrapper(), prepared = await prepare(f);
  const cmd0 = { type: "fork_branch", entryId: f.source.getLeafId(), operationId: randomUUID() }, child0 = await w.send(cmd0);
  const b = await f.create(); await f.change(b.id); await prepare(f);
  const cmd1 = { ...cmd0, operationId: randomUUID() }, child1 = await w.send(cmd1); await f.change(f.task.id);
  const good = await f.raw(), board = await f.list(), bytes = await readFile(f.file);
  assert.deepEqual(good.sessionCopies.map(r => r.sourceRelationGeneration), [0, 0, 1, 1]); assert.deepEqual(f.fresh().value, board);
  assert.deepEqual(await w.send(cmd0), child0); assert.deepEqual(await w.send(cmd1), child1);
  assert.equal(owner(await f.list(), child1.newSessionId).id, b.id);
  await assert.rejects(taskOperation(prepared, { agentDir: f.agentDir, sessionCopy: true }), { code: "conflict" }); assert.deepEqual(await readFile(f.file), bytes);
});

test("current schema requires relation/receipt epochs and rejects future start/choice authority without repair", async t => {
  const f = await legacyFixture(t), good = await f.raw();
  for (const damage of [d => { delete d.sessionRelations; }, d => { d.sessionRelations = null; },
    d => { delete d.tasks[0].sessionContexts[0].relationGeneration; }, d => { delete d.tasks[0].sessionUpdates[0].choices[0].relationGeneration; },
    d => { d.tasks[0].sessionContexts[0].relationGeneration = 1; d.tasks[0].sessionContexts[0].selection.expectedRelationGeneration = 1; },
    d => { d.tasks[0].sessionUpdates[0].choices[0].relationGeneration = 1; }]) {
    const bad = structuredClone(good); damage(bad); const bytes = JSON.stringify(bad); await writeFile(f.file, bytes);
    await assert.rejects(f.list(), { code: "storage-unavailable" }); assert.equal(await readFile(f.file, "utf8"), bytes);
  }
});
