// Archive now controls management visibility only. Native lifecycle checks remain native.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, rm, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { legacyFixture, legacySix, SessionManager, copySessionWithTask } from "./task-legacy-fixture.mjs";

const stripArchive = task => { const { archived, archiveRevision, archiveReceipt, ...rest } = task; void archived; void archiveRevision; void archiveReceipt; return rest; };
for (const kind of ["prompt-pending", "streaming", "queue", "UI", "custom-UI", "compaction", "bash", "closing", "deleted-file-busy"]) test(`archive/restore during ${kind} never stops work or changes history/other task domains`, async t => {
  const f = await legacyFixture(t), { w, inner, calls } = f.wrapper(), before = await f.raw(), history = await readFile(f.source.getSessionFile());
  if (kind === "prompt-pending") w.pendingPromptCount = 1;
  if (["streaming", "closing", "deleted-file-busy"].includes(kind)) inner.isStreaming = true;
  if (kind === "queue") inner.pendingMessageCount = 2;
  if (kind === "UI") w.pendingUiResponses.set("fixture", {});
  if (kind === "custom-UI") w.activeCustomUis.set("fixture", {});
  if (kind === "compaction") inner.isCompacting = true;
  if (kind === "bash") inner.isBashRunning = true;
  if (kind === "closing") w.closing = true;
  if (kind === "deleted-file-busy") await rm(f.source.getSessionFile());
  await f.archive(); const archived = await f.raw(); assert.equal(archived.tasks[0].archived, true);
  assert.deepEqual(archived.tasks.map(stripArchive), before.tasks.map(stripArchive));
  await f.archive(f.task.id, false); assert.deepEqual((await f.raw()).tasks.map(stripArchive), before.tasks.map(stripArchive));
  assert.equal(calls.aborts, 0); assert.equal(calls.prompts.length, 0); assert.equal(calls.disposes, 0);
  if (kind !== "deleted-file-busy") assert.deepEqual(await readFile(f.source.getSessionFile()), history);
});

test("archive CAS, no-op and exact receipts remain independent from task/order revisions and latest column", async t => {
  const f = await legacyFixture(t), request = await f.archiveRequest(), before = await f.raw();
  const results = await Promise.allSettled([f.op(request), f.op({ ...request, operationId: randomUUID() })]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1); assert.equal(results.find(r => r.status === "rejected").reason.code, "conflict");
  const current = await f.current(); assert.equal(current.revision, before.tasks[0].revision); assert.equal(current.updatedAt, before.tasks[0].updatedAt);
  const noop = await f.archiveRequest(); await f.op(noop); assert.equal((await f.current()).archiveRevision, 1);
  const bytes = await readFile(f.file); assert.deepEqual(f.fresh(noop).value.board, await f.list()); assert.deepEqual(await readFile(f.file), bytes);
  await f.move(f.task.id, "blocked"); await f.archive(f.task.id, false); assert.equal((await f.current()).columnId, "blocked");
  await assert.rejects(f.op(noop), { code: "conflict" }); assert.deepEqual((await f.raw()).tasks[0].sharedContext, before.tasks[0].sharedContext);
});

test("real archive write refusal preserves legacy records and exact retry recovers", { skip: process.platform === "win32" ? "POSIX permissions" : false }, async t => {
  const f = await legacyFixture(t), request = await f.archiveRequest(), bytes = await readFile(f.file); await chmod(dirname(f.file), 0o500);
  try { await assert.rejects(f.op(request), { code: "storage-unavailable" }); assert.deepEqual(await readFile(f.file), bytes); }
  finally { await chmod(dirname(f.file), 0o700); }
  await f.op(request); const stable = await readFile(f.file); await f.op(request); assert.deepEqual(await readFile(f.file), stable);
});

test("v5 archive absence hydrates only that domain; partial/null/invalid archive data is not repaired", async t => {
  const f = await legacyFixture(t), good = await f.raw(), old = legacySix(good); old.version = 5; delete old.tasks[0].archived; delete old.tasks[0].archiveRevision;
  await writeFile(f.file, JSON.stringify(old)); assert.ok(f.fresh().value); assert.deepEqual(await f.raw(), good);
  for (const patch of [{ archived: true }, { archiveRevision: 1 }, { archived: null, archiveRevision: 0 }, { archived: false, archiveRevision: -1 }, { archived: false, archiveRevision: 0, archiveReceipt: null }]) {
    const bad = structuredClone(old); Object.assign(bad.tasks[0], patch); const bytes = JSON.stringify(bad); await writeFile(f.file, bytes);
    await assert.rejects(f.list(), { code: "storage-unavailable" }); assert.equal(await readFile(f.file, "utf8"), bytes);
  }
});

test("archived native prompt/queue/compact/bash handlers run normally without context injection or board writes", async t => {
  const f = await legacyFixture(t), { w, inner, calls } = f.wrapper(); await f.archive(); const bytes = await readFile(f.file), native = await readFile(f.source.getSessionFile()), commands = [];
  inner.steer = async message => { commands.push(["steer", message]); }; inner.followUp = async message => { commands.push(["follow_up", message]); };
  inner.compact = async () => { commands.push(["compact"]); return {}; }; inner.executeBash = async () => { commands.push(["bash"]); return { output: "synthetic", exitCode: 0 }; };
  await w.send({ type: "prompt", message: "Ordinary" });
  for (const type of ["steer", "follow_up", "compact", "bash"]) await w.send({ type, message: "Explicit", command: "not executed by fixture" });
  assert.deepEqual(commands.map(c => c[0]), ["steer", "follow_up", "compact", "bash"]);
  assert.doesNotMatch(JSON.stringify(calls.prompts[0].context), /LEGACY PENDING MATERIAL/);
  assert.deepEqual(await readFile(f.file), bytes); assert.deepEqual(await readFile(f.source.getSessionFile()), native);
});

test("busy archived source/child can inherit task; native busy clone refusal is unchanged", async t => {
  const f = await legacyFixture(t), { w, inner } = f.wrapper(); await f.archive(); inner.isStreaming = true;
  await assert.rejects(w.send({ type: "clone", leafId: f.source.getLeafId(), operationId: randomUUID() }), /running|busy/i);
  const request = { type: "fork_branch", entryId: f.source.getLeafId(), operationId: randomUUID() }; let copies = 0;
  const execute = async () => {
    copies++; const path = SessionManager.open(f.source.getSessionFile()).createBranchedSession(request.entryId), child = SessionManager.open(path); f.wrapper(child).inner.isStreaming = true;
    return { cancelled: false, newSessionId: child.getSessionId() };
  };
  const result = await copySessionWithTask(f.agentDir, f.sessionId, request, execute);
  assert.deepEqual(await copySessionWithTask(f.agentDir, f.sessionId, request, execute), result); assert.equal(copies, 1);
  const current = await f.current(); assert.equal(current.archived, true); assert.ok(current.sessionIds.includes(result.newSessionId));
  assert.equal(current.sessionContexts.length, 1); assert.equal(current.sessionUpdates.length, 1);
});
