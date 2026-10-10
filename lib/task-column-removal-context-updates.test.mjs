// Main-only composed v7 integration: real SDK, native fake Provider and current locked board.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { contextUpdateFixture, settle } from "./task-context-updates-fixture.mjs";
const removal = (board, columnId = "todo", targetColumnId = "review") => ({ action: "remove-column", columnId, targetColumnId, expectedColumnsRevision: board.columnsRevision, expectedOrderRevision: board.orderRevision, expectedSourceDigest: board.columnRemovalDigests[columnId], confirmCompletion: false, operationId: randomUUID() });
const stored = async f => JSON.parse(await readFile(f.file));
const nativeChoice = (f, choice) => f.w.inner.sessionManager.getEntries().filter(e => e.customType === "pi-web:task-context" && e.details.operationId === choice.operationId);
async function artifact(name, value) { if (process.env.TASK_UPDATE_ARTIFACT_DIR) await writeFile(join(process.env.TASK_UPDATE_ARTIFACT_DIR, name + ".json"), JSON.stringify(value, null, 2)); }

test("09 pending→column removal→actual SDK Send keeps selected version, identity and successful-input evidence; exact receipts return latest digest board", async t => {
  const f = await contextUpdateFixture(t), chosen = await f.publish("LOCKED VERSION TWO"), choice = await f.accept(chosen);
  const preview = await f.op({ action: "list" }), remove = removal(preview), before = await stored(f);
  const later = await f.publish("UNCHOSEN VERSION THREE");
  assert.equal((await f.op({ action: "list" })).columnRemovalDigests.todo, remove.expectedSourceDigest, "knowledge and09 independent CAS do not invalidate scope");
  const latestBefore = await stored(f), count = f.captures.length;
  const moved = await f.op(remove), after = await stored(f);
  assert.equal(after.version, 7); assert.deepEqual(after.tasks[0].sessionUpdates, before.tasks[0].sessionUpdates);
  assert.deepEqual(after.tasks[0].sessionContexts, latestBefore.tasks[0].sessionContexts);
  assert.deepEqual(after.tasks[0].sharedContext, latestBefore.tasks[0].sharedContext);
  assert.equal(moved.tasks[0].columnId, "review"); assert.equal(moved.tasks[0].archived, false);
  assert.equal(f.captures.length, count); assert.equal(nativeChoice(f, choice).length, 0, "removal cannot consume/append pending");
  const stable = await readFile(f.file);
  assert.deepEqual((await f.op(choice)).board, moved); assert.deepEqual(await f.op(remove), moved);
  assert.deepEqual(await readFile(f.file), stable);
  await f.send("Explicit Send after removal"); await settle(f.w);
  const state = await f.state(), capture = f.captures.at(-1), material = JSON.stringify(capture.context.messages);
  assert.ok(material.includes(chosen)); assert.ok(material.includes("LOCKED VERSION TWO")); assert.ok(!material.includes(later));
  assert.equal(state.state.pendingOperationId, null); assert.equal(state.state.deliveries.length, 1);
  assert.equal(state.state.deliveries[0].operationId, choice.operationId);
  assert.equal(state.state.deliveries[0].evidence, "sdk-input-successful-response");
  assert.match(state.state.deliveries[0].inputHash, /^[0-9a-f]{64}$/);
  assert.equal(nativeChoice(f, choice).length, 1); assert.equal(state.state.deliveries[0].entryId, nativeChoice(f, choice)[0].id);
  const current = await f.op({ action: "list" }), delivered = await readFile(f.file);
  assert.deepEqual((await f.op(choice)).board, current, "old selection receipt cannot re-pend or roll back delivery");
  assert.deepEqual(await f.op(remove), current); assert.deepEqual(await readFile(f.file), delivered);
  assert.equal("todo" in current.columnRemovalDigests, false); assert.equal("columnRemovalDigests" in after, false);
  await artifact("14-pending-removal-actual-send", { choice, remove, before, after, capture, state, current });
});

test("archived owner→column removal leaves all archive/adoption domains intact; actual Send still rejects and restore retains pending until eligible Send", async t => {
  const f = await contextUpdateFixture(t), chosen = await f.publish("ARCHIVED LOCKED UPDATE"), choice = await f.accept(chosen);
  const archive = { action: "set-archive", id: f.task.id, archived: true, expectedArchiveRevision: 0, operationId: randomUUID() };
  await f.op(archive); const before = await stored(f), remove = removal(await f.op({ action: "list" }));
  const moved = await f.op(remove), after = await stored(f), count = f.captures.length, stable = await readFile(f.file);
  for (const key of ["archived", "archiveRevision", "archiveReceipt", "sessionUpdates", "sessionContexts", "sessionIds"]) assert.deepEqual(after.tasks[0][key], before.tasks[0][key]);
  assert.deepEqual((await f.op(archive)).board, moved); assert.deepEqual((await f.op(choice)).board, moved);
  await assert.rejects(f.send("Archived owner after deletion"), /archived/);
  assert.equal(f.captures.length, count); assert.equal(nativeChoice(f, choice).length, 0); assert.deepEqual(await readFile(f.file), stable);
  const restored = await f.op({ ...archive, archived: false, expectedArchiveRevision: 1, operationId: randomUUID() });
  assert.equal(restored.task.columnId, "review"); assert.deepEqual(restored.task.sessionUpdates, before.tasks[0].sessionUpdates);
  await f.send("Independent Send after explicit restore"); await settle(f.w);
  assert.ok(JSON.stringify(f.captures.at(-1).context.messages).includes(chosen));
  const state = await f.state(); assert.equal(state.state.pendingOperationId, null); assert.equal(state.state.deliveries.length, 1);
  assert.equal((await f.op({ action: "list" })).tasks[0].columnId, "review");
  await artifact("14-archive-removal-restore-send", { choice, archive, remove, before, after, state, captures: f.captures });
});

test("independent adoption changes after frozen scope and deletion during actual SDK work preserve all choice/delivery history without Stop", async t => {
  const f = await contextUpdateFixture(t), v2 = await f.publish("SUCCESSFUL PREVIOUS UPDATE"), first = await f.accept(v2);
  await f.send("First explicit update Send"); await settle(f.w);
  const preview = await f.op({ action: "list" }), remove = removal(preview);
  const v3 = await f.publish("IN-FLIGHT LOCKED UPDATE"), second = await f.accept(v3);
  const selected = await f.op({ action: "list" }); assert.equal(selected.columnRemovalDigests.todo, remove.expectedSourceDigest);
  assert.equal(selected.tasks[0].sessionUpdates[0].deliveries[0].operationId, first.operationId);
  let release, entered; const gate = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  f.setResponse(async () => { entered(); await gate; return fauxAssistantMessage([fauxText("Successful held response")]); });
  t.after(() => release());
  await f.send("User sends selected V3"); await started;
  const before = await stored(f); assert.equal(f.w.isRunning(), true);
  assert.equal(before.tasks[0].sessionUpdates[0].pendingOperationId, second.operationId);
  try {
    const moved = await f.op(remove), after = await stored(f);
    assert.deepEqual(after.tasks[0].sessionUpdates, before.tasks[0].sessionUpdates);
    assert.equal(f.w.isRunning(), true, "column removal does not abort/restart actual work");
    assert.deepEqual((await f.op(first)).board, moved); assert.deepEqual((await f.op(second)).board, moved);
  } finally { release(); }
  await settle(f.w);
  const state = await f.state(); assert.equal(state.state.pendingOperationId, null);
  assert.deepEqual(state.state.deliveries.map(d => d.operationId), [first.operationId, second.operationId]);
  assert.equal(nativeChoice(f, second).length, 1); assert.equal(state.task.columnId, "review");
  assert.ok(JSON.stringify(f.captures.at(-1).context.messages).includes(v3));
  await artifact("14-inflight-adoption-domain", { first, second, remove, before, state, captures: f.captures });
});

test("field editing and real link/copy relationship revisions conflict old removal digest even without columns/order changes", async t => {
  const f = await contextUpdateFixture(t);
  for (const mutation of ["edit", "link", "copy"]) {
    const board = await f.op({ action: "list" }), remove = removal(board), owner = board.tasks[0];
    if (mutation === "edit") await f.op({ action: "edit", id: owner.id, expectedRevision: owner.revision, title: "Changed field", description: owner.description, completionCriteria: owner.completionCriteria, priority: owner.priority, labels: owner.labels });
    if (mutation === "link") {
      const directory = join(f.agentDir, "sessions", "extra"); await mkdir(directory, { recursive: true });
      const extra = SessionManager.create(f.cwd, directory); extra.appendMessage({ role: "user", content: "Synthetic extra session", timestamp: Date.now() }); extra.appendSessionInfo("Metadata only");
      await f.op({ action: "link", id: owner.id, expectedRevision: owner.revision, sessionIds: [extra.getSessionId()] });
    }
    if (mutation === "copy") {
      const result = await f.w.send({ type: "fork_branch", entryId: f.w.inner.sessionManager.getLeafId(), operationId: randomUUID() }); assert.equal(result.cancelled, false);
    }
    const current = await f.op({ action: "list" }), bytes = await readFile(f.file);
    assert.equal(current.columnsRevision, board.columnsRevision); assert.equal(current.orderRevision, board.orderRevision);
    assert.equal(current.tasks[0].revision, owner.revision + 1); assert.notEqual(current.columnRemovalDigests.todo, remove.expectedSourceDigest);
    await assert.rejects(f.op(remove), { code: "conflict" }); assert.deepEqual(await readFile(f.file), bytes);
  }
});
