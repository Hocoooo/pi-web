// Current compatibility contract. Publication/restore execution is suspended.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { legacyFixture } from "./task-legacy-fixture.mjs";

test("legacy manual/AI/restore versions and precise receipts survive reads and fresh reopen without relabeling", async t => {
  const f = await legacyFixture(t), raw = await f.raw(), before = await readFile(f.file), board = await f.list(), versions = board.tasks[0].sharedContext.versions;
  assert.deepEqual(versions.map(v => v.source.kind), ["manual", "ai", "restore"]);
  assert.deepEqual(versions[2].source, { kind: "restore", versionId: versions[0].id });
  assert.deepEqual(versions[2].content, versions[0].content);
  assert.equal(new Set(versions.map(v => v.id)).size, 3);
  assert.ok(versions.every((v, i) => !Object.hasOwn(v, "receipt") && (!i || Date.parse(v.confirmedAt) > Date.parse(versions[i - 1].confirmedAt))));
  assert.ok(raw.tasks[0].sharedContext.versions.every(v => v.receipt.operationId && /^[a-f0-9]{64}$/.test(v.receipt.fingerprint)));
  assert.deepEqual(f.fresh().value, board); assert.deepEqual(await readFile(f.file), before);
});

test("new and exact historical publication/restore requests are suspended, including fresh callers", async t => {
  const f = await legacyFixture(t), before = await readFile(f.file);
  for (const request of [f.legacy.manual.request, f.legacy.ai.request, f.legacy.restore]) {
    for (const value of [request, { ...request, operationId: randomUUID() }, { ...request, id: "../escape" }]) {
      await assert.rejects(f.op(value), e => e.code === "invalid-input" && /suspended/.test(e.message));
      assert.equal(f.fresh(value).code, "invalid-input");
    }
  }
  assert.deepEqual(await readFile(f.file), before);
});

test("management fields/order/creation retries never mutate legacy context versions or receipts", async t => {
  const f = await legacyFixture(t), before = await f.raw(), task = await f.current();
  const edited = await f.op({ action: "edit", id: task.id, expectedRevision: task.revision, title: "Edited", description: "Changed", completionCriteria: "Checked", priority: 3, labels: ["kept"] });
  await f.move(task.id, "review"); await f.archive();
  const board = await f.list(), bytes = await readFile(f.file);
  assert.deepEqual((await f.op(f.createRequest)).board, board); assert.deepEqual(await readFile(f.file), bytes);
  const saved = (await f.raw()).tasks[0]; assert.deepEqual(saved.sharedContext, before.tasks[0].sharedContext);
  assert.deepEqual(saved.sessionContexts, before.tasks[0].sessionContexts); assert.deepEqual(saved.sessionUpdates, before.tasks[0].sessionUpdates);
  assert.equal(saved.creationFingerprint, before.tasks[0].creationFingerprint); assert.equal(saved.revision, edited.task.revision + 1);
});

test("v2 knowledge absence hydrates only empty context and preserves old identity/order/move receipt", async t => {
  const f = await legacyFixture(t, { seed: false }); await f.move(f.task.id, "review");
  const good = await f.raw(), legacy = structuredClone(good); legacy.version = 2; delete legacy.sessionRelations; delete legacy.columns; delete legacy.columnsRevision; delete legacy.tasks[0].sharedContext;
  await writeFile(f.file, JSON.stringify(legacy)); const board = f.fresh().value;
  assert.deepEqual(board.tasks[0].sharedContext, { currentVersionId: null, versions: [] });
  assert.deepEqual(await f.raw(), good); const stable = await readFile(f.file); assert.deepEqual(f.fresh().value, board); assert.deepEqual(await readFile(f.file), stable);
});

test("corrupt legacy pointers, IDs, time, source, content, receipt and duplicate histories refuse without repairing bytes", async t => {
  const f = await legacyFixture(t), good = await f.raw(), context = good.tasks[0].sharedContext;
  const cases = [null, {}, { ...context, currentVersionId: null }, { ...context, currentVersionId: randomUUID() },
    ...[{ id: "bad" }, { confirmedAt: "bad" }, { content: {} }, { source: { kind: "ai" } }, { source: { kind: "manual", model: "fake" } },
      { source: { kind: "restore", versionId: randomUUID() } }, { receipt: { operationId: "bad", fingerprint: "x" } }].map(patch => ({ ...context, versions: [{ ...context.versions[0], ...patch }, ...context.versions.slice(1)] })),
    { ...context, versions: [context.versions[0], ...context.versions] },
    ...[{ model: null }, { inputHash: "invalid" }, { sources: [] }, { sources: [{ sessionId: "../escape", leafId: "leaf", entryIds: ["entry"], toolEntryIds: [] }] }, { extra: true }]
      .map(patch => ({ ...context, versions: context.versions.map((v, i) => i === 1 ? { ...v, source: { ...v.source, ...patch } } : v) }))];
  for (const sharedContext of cases) {
    const broken = structuredClone(good); broken.tasks[0].sharedContext = sharedContext;
    const bytes = JSON.stringify(broken); await writeFile(f.file, bytes);
    await assert.rejects(f.list(), { code: "storage-unavailable" }); assert.equal(await readFile(f.file, "utf8"), bytes);
  }
  await writeFile(f.file, JSON.stringify(good)); assert.deepEqual((await f.list()).tasks[0].sharedContext.versions.map(v => v.source.kind), ["manual", "ai", "restore"]);
});

test("management write failure preserves complete legacy context; exact archive retry recovers", { skip: process.platform === "win32" ? "POSIX permissions; Windows ACL not exercised" : false }, async t => {
  const f = await legacyFixture(t), request = await f.archiveRequest(), before = await readFile(f.file);
  await chmod(dirname(f.file), 0o500);
  try { await assert.rejects(f.op(request), { code: "storage-unavailable" }); assert.deepEqual(await readFile(f.file), before); }
  finally { await chmod(dirname(f.file), 0o700); }
  await f.op(request); const saved = await readFile(f.file); await f.op(request); assert.deepEqual(await readFile(f.file), saved);
  assert.deepEqual((await f.raw()).tasks[0].sharedContext, JSON.parse(before).tasks[0].sharedContext);
});
