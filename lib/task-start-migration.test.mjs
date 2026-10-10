// Legacy start/adoption storage compatibility; no task-start execution is re-enabled.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { legacyFixture, emptyTaskFilter, removal, legacySix } from "./task-legacy-fixture.mjs";

async function completeDomains(f) {
  const { w } = f.wrapper(); const copy = { type: "fork_branch", entryId: f.source.getLeafId(), operationId: randomUUID() }, child = await w.send(copy);
  const view = { action: "save-view", id: randomUUID(), operationId: randomUUID(), expectedViewsRevision: 0, name: "Migration", filter: emptyTaskFilter(), sort: "updated" }; await f.op(view);
  await f.move(f.task.id, "review"); const archive = await f.archiveRequest(); await f.op(archive);
  const remove = removal(await f.list(), "blocked", "review"); await f.op(remove);
  return { w, copy, child, view, archive, remove };
}

test("v4/v5/v6 migration preserves combined AI/manual/restore/start/update/copy/views/archive/column domains and receipts", async t => {
  const f = await legacyFixture(t), facts = await completeDomains(f), good = await f.raw(), board = await f.list(), history = await readFile(f.source.getSessionFile());
  for (const version of [4, 5, 6]) {
    const legacy = legacySix(good, true); legacy.version = version;
    await writeFile(f.file, JSON.stringify(legacy)); assert.deepEqual(f.fresh().value, board); assert.deepEqual(await f.raw(), good);
    const bytes = await readFile(f.file); assert.deepEqual(f.fresh().value, board);
    for (const request of [facts.view, facts.archive, facts.remove, f.createRequest]) { const reply = await f.op(request); assert.deepEqual(reply.board ?? reply, board); }
    assert.deepEqual(await facts.w.send(facts.copy), facts.child); assert.deepEqual(await readFile(f.file), bytes);
    for (const request of [f.legacy.manual.request, f.legacy.ai.request, f.legacy.restore, f.legacy.pending]) await assert.rejects(f.op(request), /suspended/);
    assert.deepEqual(await readFile(f.file), bytes);
  }
  assert.deepEqual(await readFile(f.source.getSessionFile()), history);
});

test("legal absence-only v4 start and v5 update/archive migrations preserve every other established fact", async t => {
  const f = await legacyFixture(t); await completeDomains(f); const good = await f.raw();
  for (const domain of ["start", "updates", "archive"]) {
    const legacy = legacySix(good), expected = structuredClone(good); legacy.version = domain === "start" ? 4 : 5;
    if (domain === "start") { delete legacy.tasks[0].sessionContexts; expected.tasks[0].sessionContexts = []; }
    if (domain === "updates") { delete legacy.tasks[0].sessionUpdates; expected.tasks[0].sessionUpdates = []; }
    if (domain === "archive") {
      for (const key of ["archived", "archiveRevision", "archiveReceipt"]) delete legacy.tasks[0][key];
      expected.tasks[0].archived = false; expected.tasks[0].archiveRevision = 0; delete expected.tasks[0].archiveReceipt;
    }
    await writeFile(f.file, JSON.stringify(legacy)); assert.ok(f.fresh().value); assert.deepEqual(await f.raw(), expected);
  }
});

test("composed v6 required domains, duplicate cross-session operations and strict start corruption fail closed", async t => {
  const f = await legacyFixture(t), good = await f.raw();
  const damages = [
    ...["archived", "archiveRevision", "sessionUpdates", "sessionContexts"].map(key => d => { delete d.tasks[0][key]; }),
    ...["savedViews", "viewsRevision", "sessionCopies"].map(key => d => { delete d[key]; }),
    d => { d.tasks[0].sessionUpdates.push({ ...structuredClone(d.tasks[0].sessionUpdates[0]), sessionId: "other-session", pendingOperationId: null }); },
    d => { d.tasks[0].sessionContexts[0].sessionId = "other-session"; },
    d => { d.tasks[0].sessionContexts[0].selection.mode = "continue"; },
    d => { d.tasks[0].sessionContexts[0].snapshot.version.content.goal = "Forged snapshot"; },
    d => { d.tasks[0].sessionUpdates[0].pendingOperationId = randomUUID(); },
    d => { d.tasks[0].sessionUpdates[0].deliveries[0].evidence = "model-read"; },
  ];
  for (const damage of damages) {
    const bad = legacySix(good, true); damage(bad); const bytes = JSON.stringify(bad); await writeFile(f.file, bytes);
    await assert.rejects(f.list(), { code: "storage-unavailable" }); assert.equal(await readFile(f.file, "utf8"), bytes);
  }
  // Pre-v6 absence is allowed, but partial/present-invalid domains are not repaired.
  for (const patch of [{ archived: true }, { archiveRevision: 0 }, { archived: null, archiveRevision: 0 }]) {
    const bad = legacySix(good); bad.version = 5; delete bad.tasks[0].archived; delete bad.tasks[0].archiveRevision; Object.assign(bad.tasks[0], patch);
    const bytes = JSON.stringify(bad); await writeFile(f.file, bytes); await assert.rejects(f.list(), { code: "storage-unavailable" }); assert.equal(await readFile(f.file, "utf8"), bytes);
  }
});
