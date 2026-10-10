import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { legacyFixture, owner, copySessionWithTask, SessionManager } from "./task-legacy-fixture.mjs";

for (const initiallyOwned of [true, false]) test(`copy source ${initiallyOwned ? "owned" : "unowned"} ABA invalidates prepared intent and known-child retry without duplicate SDK creation`, async t => {
  const f = await legacyFixture(t), b = await f.create();
  if (!initiallyOwned) await f.change(null);
  const request = { type: "fork_branch", entryId: f.source.getLeafId(), operationId: randomUUID() }, entered = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve()); let copies = 0, childId;
  const execute = async () => {
    copies++; const path = SessionManager.open(f.source.getSessionFile()).createBranchedSession(request.entryId); childId = SessionManager.open(path).getSessionId(); entered.resolve(); await release.promise; return { cancelled: false, newSessionId: childId };
  };
  const pending = copySessionWithTask(f.agentDir, f.sessionId, request, execute).catch(e => e); await entered.promise;
  if (initiallyOwned) { await f.change(b.id); await f.change(f.task.id); }
  else {
    await f.op({ action: "link", id: f.task.id, expectedRevision: (await f.current()).revision, sessionIds: [f.sessionId] }); await f.change(null);
  }
  release.resolve(); assert.equal((await pending).taskCode, "conflict");
  await assert.rejects(copySessionWithTask(f.agentDir, f.sessionId, request, execute), e => e.taskCode === "conflict");
  assert.equal(copies, 1); assert.equal(owner(await f.list(), childId), undefined);
  const receipt = (await f.raw()).sessionCopies.find(r => r.operationId === request.operationId); assert.equal(receipt.status, "prepared");
});

test("completed copy receipt remains historical fact after source and child reassignments", async t => {
  const f = await legacyFixture(t), target = await f.create(), { w } = f.wrapper();
  const request = { type: "fork_branch", entryId: f.source.getLeafId(), operationId: randomUUID() }, result = await w.send(request);
  await f.change(target.id, result.newSessionId); await f.change(target.id);
  const before = await readFile(f.file); assert.deepEqual(await w.send(request), result); assert.deepEqual(await readFile(f.file), before);
  assert.equal(owner(await f.list(), result.newSessionId).id, target.id);
});

test("old start/update executions cannot revive across ABA; native history and successful audit remain facts", async t => {
  const f = await legacyFixture(t), b = await f.create(), { w, calls } = f.wrapper(), history = await readFile(f.source.getSessionFile());
  await f.change(b.id); await f.change(f.task.id); await f.archive();
  const before = await readFile(f.file), task = await f.current();
  for (const request of [f.legacy.pending, { action: "prepare-start", id: f.task.id, operationId: randomUUID(), sessionId: f.sessionId },
    { action: "admit-start", id: f.task.id, selection: f.legacy.context.selection, realSessionId: f.sessionId },
    { action: "complete-context-update", id: f.task.id, sessionId: f.sessionId, relationGeneration: 0, delivery: task.sessionUpdates[0].deliveries[0] }]) await assert.rejects(f.op(request), /suspended/);
  await assert.rejects(w.send({ type: "prompt", message: "Old preparation", taskStart: f.legacy.context.selection }), /suspended/);
  await w.send({ type: "prompt", message: "Ordinary chat after ABA and archive" });
  assert.equal(calls.prompts.length, 1); const input = JSON.stringify(calls.prompts[0].context);
  assert.match(input, /LEGACY NATIVE MATERIAL/); assert.doesNotMatch(input, /LEGACY PENDING MATERIAL/);
  assert.equal(task.sessionUpdates[0].pendingOperationId, null); assert.equal(task.sessionUpdates[0].deliveries.length, 1);
  assert.deepEqual(await readFile(f.file), before); assert.deepEqual(await readFile(f.source.getSessionFile()), history);
});
