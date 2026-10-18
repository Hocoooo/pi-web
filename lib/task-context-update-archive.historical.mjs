// Main-only 09/12 intersections: actual SDK + native fake provider, no network.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createJiti } from "jiti";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { contextUpdateFixture, settle } from "./task-context-updates-fixture.mjs";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { withTaskStore } = await jiti.import("./task-store.ts");
const { POST } = await jiti.import("../app/api/tasks/route.ts");
const entries = w => w.inner.sessionManager.getEntries().filter(e => e.customType === "pi-web:task-context");
const text = r => JSON.stringify(r.context.messages);
async function archive(f, archived) {
  const task = (await f.op({ action: "list" })).tasks[0];
  return f.op({ action: "set-archive", id: f.task.id, archived, expectedArchiveRevision: task.archiveRevision, operationId: randomUUID() });
}
async function evidence(name, f) {
  if (!process.env.TASK_UPDATE_ARTIFACT_DIR) return;
  await mkdir(process.env.TASK_UPDATE_ARTIFACT_DIR, { recursive: true });
  await writeFile(`${process.env.TASK_UPDATE_ARTIFACT_DIR}/${name}.json`, JSON.stringify({ captures: f.captures, state: await f.state() }, null, 2));
}

test("09 pending→12 archive→all work/internal delivery reject→restore sends the original version; cancel/auth failure retain exact native facts", async t => {
  const f = await contextUpdateFixture(t), v2 = await f.publish("ARCHIVED CHOSEN"), choice = await f.accept(v2);
  const before = f.captures.length, nativeBefore = entries(f.w).length;
  await archive(f, true); const v3 = await f.publish("ARCHIVED LATER CURRENT");
  const bytes = await readFile(f.file);
  for (const type of ["prompt", "steer", "follow_up", "compact", "bash", "extension_ui_input"]) {
    await assert.rejects(f.w.send({ type, message: "Must not dispatch", command: "fixture", id: "fixture", data: "fixture" }), /archived/);
  }
  for (const streamingBehavior of ["steer", "followUp"]) await assert.rejects(f.send("No queued bypass", { streamingBehavior }), /archived/);
  await assert.rejects(f.op({ action: "pending-context-update", sessionId: f.w.sessionId }), /archived/);
  await assert.rejects(f.op({ action: "prepare-start", id: f.task.id, sessionId: f.w.sessionId, operationId: randomUUID() }), /archived/);
  const forged = { operationId: choice.operationId, entryId: "fake", inputHash: "a".repeat(64), provider: "fake", model: "fake", sentAt: new Date().toISOString(), evidence: "sdk-input-successful-response" };
  await assert.rejects(f.op({ action: "complete-context-update", id: f.task.id, sessionId: f.w.sessionId, delivery: forged }), /archived/);
  for (const input of [
    { action: "complete-context-update", id: f.task.id, sessionId: f.w.sessionId, delivery: forged },
    { action: "pending-context-update", sessionId: f.w.sessionId },
    { action: "clear-context-update", id: f.task.id, sessionId: f.w.sessionId, expectedRevision: 1, delivery: forged },
    { action: "clear-context-update", id: f.task.id, sessionId: f.w.sessionId, expectedRevision: 0 },
    { action: "clear", id: f.task.id },
  ]) {
    const r = await POST(new Request("http://localhost/api/tasks", { method: "POST", body: JSON.stringify(input) }));
    assert.ok([400, 409].includes(r.status)); assert.deepEqual(await readFile(f.file), bytes);
  }
  assert.equal(f.captures.length, before); assert.equal(entries(f.w).length, nativeBefore); assert.equal(f.w.inner.pendingMessageCount, 0);
  assert.equal((await f.state()).state.pendingOperationId, choice.operationId);
  // Exact selection confirmation is allowed while archived, never a work send.
  await f.op(choice); assert.deepEqual(await readFile(f.file), bytes);
  await archive(f, false);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const locked = withTaskStore(f.agentDir, async () => { entered.resolve(); await release.promise; return { value: null, changed: false }; }); await entered.promise;
  const send = f.send("Stop before provider"); const rejected = assert.rejects(send, /cancelled/);
  while (!f.w.isRunning()) await new Promise(r => setTimeout(r, 5));
  await f.w.send({ type: "abort" }); release.resolve(); await locked; await rejected;
  assert.equal(f.captures.length, before); assert.equal(entries(f.w).length, nativeBefore);
  const getAuth = f.w.inner.modelRuntime.getAuth.bind(f.w.inner.modelRuntime);
  f.w.inner.modelRuntime.getAuth = async () => { throw new Error("Joint auth denied"); };
  try { await f.send("Auth fails, native append is not use"); } catch {} await settle(f.w);
  assert.equal(f.captures.length, before); assert.equal((await f.state()).state.deliveries.length, 0);
  assert.equal((await f.state()).state.pendingOperationId, choice.operationId);
  f.w.inner.modelRuntime.getAuth = getAuth;
  await f.send("User explicitly retries after restore"); await settle(f.w);
  assert.match(text(f.captures.at(-1)), new RegExp(v2)); assert.ok(!text(f.captures.at(-1)).includes(v3));
  assert.equal(entries(f.w).filter(e => e.details.operationId === choice.operationId).length, 1);
  assert.equal((await f.state()).state.deliveries.length, 1); assert.equal((await f.state()).state.pendingOperationId, null);
  const next = await f.accept(v3); await archive(f, true);
  const state = await f.state(); await f.op({ action: "clear-context-update", id: f.task.id, sessionId: f.w.sessionId, expectedRevision: state.state.revision });
  await archive(f, false); await f.send("Explicit send after cancelling pending"); await settle(f.w);
  assert.ok(!text(f.captures.at(-1)).includes(v3)); assert.equal(entries(f.w).filter(e => e.details.operationId === next.operationId).length, 0);
  await evidence("joint-pending-archive-restore-auth-cancel", f);
});

test("earliest09 send reservation wins archive; already queued native/SDK work remains old and cannot consume busy pending", async t => {
  const f = await contextUpdateFixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const locked = withTaskStore(f.agentDir, async () => { entered.resolve(); await release.promise; return { value: null, changed: false }; }); await entered.promise;
  const gate = Promise.withResolvers(), started = Promise.withResolvers(); let calls = 0;
  f.setResponse(async () => { if (++calls === 1) { started.resolve(); await gate.promise; } return fauxAssistantMessage([fauxText("Queued joint reply")]); });
  const send = f.send("Original run before archive"); while (!f.w.isRunning()) await new Promise(r => setTimeout(r, 5));
  const archival = f.op({ action: "set-archive", id: f.task.id, archived: true, expectedArchiveRevision: 0, operationId: randomUUID() });
  const rejected = assert.rejects(archival, /busy/); release.resolve(); await locked; await send; await rejected; await started.promise;
  await f.w.send({ type: "follow_up", message: "Already queued" });
  const v2 = await f.publish("BUSY JOINT SELECTED"), choice = await f.accept(v2);
  await f.send("More explicit queued work", { streamingBehavior: "followUp" });
  await assert.rejects(archive(f, true), /busy/); gate.resolve(); await settle(f.w);
  assert.ok(f.captures.length > 2); for (const r of f.captures) assert.ok(!text(r).includes(v2));
  assert.equal((await f.state()).state.pendingOperationId, choice.operationId);
  await archive(f, true); await assert.rejects(f.send(), /archived/); await archive(f, false);
  await f.send("First eligible send after all queue and restore"); await settle(f.w);
  assert.match(text(f.captures.at(-1)), new RegExp(v2)); assert.equal((await f.state()).state.pendingOperationId, null);
  await evidence("joint-reservation-queue-archive", f);
});

test("archive wins sampled idle snapshot before09 prompt; pending persists with zero append/provider until restored", async t => {
  const f = await contextUpdateFixture(t), v2 = await f.publish("ARCHIVE FIRST"), choice = await f.accept(v2), count = f.captures.length;
  const original = f.w.getActivitySnapshot.bind(f.w); let submitted, rejected;
  f.w.getActivitySnapshot = () => { const snapshot = original(); f.w.getActivitySnapshot = original; submitted = f.send("After idle snapshot"); rejected = assert.rejects(submitted, /archived/); return snapshot; };
  await archive(f, true); assert.ok(submitted); await rejected;
  assert.equal(f.captures.length, count); assert.equal(entries(f.w).length, 1); assert.equal((await f.state()).state.pendingOperationId, choice.operationId);
  await archive(f, false); await f.send("Restored independent user send"); await settle(f.w);
  assert.match(text(f.captures.at(-1)), new RegExp(v2)); await evidence("joint-archive-first", f);
});

test("composed v6 refuses missing archive/views/copies and duplicate cross-session operation; old v5 absence alone migrates", async t => {
  const f = await contextUpdateFixture(t), v2 = await f.publish("MIGRATION PENDING"); await f.accept(v2);
  await archive(f, true); const good = JSON.parse(await readFile(f.file));
  for (const corrupt of [
    d => { delete d.tasks[0].archived; delete d.tasks[0].archiveRevision; delete d.tasks[0].archiveReceipt; },
    d => { delete d.savedViews; delete d.viewsRevision; }, d => { delete d.sessionCopies; },
    d => { delete d.tasks[0].sessionUpdates; }, d => { delete d.tasks[0].sessionContexts; },
    d => { const other = structuredClone(d.tasks[0].sessionUpdates[0]); other.sessionId = "other"; other.pendingOperationId = null; d.tasks[0].sessionUpdates.push(other); },
  ]) {
    const bad = structuredClone(good); corrupt(bad); await writeFile(f.file, JSON.stringify(bad)); const bytes = await readFile(f.file);
    await assert.rejects(f.op({ action: "list" }), { code: "storage-unavailable" }); assert.deepEqual(await readFile(f.file), bytes);
  }
  const legacy = structuredClone(good); legacy.version = 5; delete legacy.sessionRelations; delete legacy.tasks[0].sessionUpdates;
  await writeFile(f.file, JSON.stringify(legacy)); await f.op({ action: "list" });
  const expected = structuredClone(good); expected.tasks[0].sessionUpdates = [];
  assert.deepEqual(JSON.parse(await readFile(f.file)), expected, "archive receipt and all other fields preserved, absent updates only hydrated");
});
