import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, rm, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createJiti } from "jiti";
import { summaryFixture, content } from "./task-summary-fixture.mjs";
const { emptyTaskFilter } = await createJiti(import.meta.url).import("./task-view.ts");
function fresh(input, agentDir) {
  const script = `import {createJiti} from 'jiti'; const {taskOperation}=await createJiti(import.meta.url).import('./lib/task-operations.ts'); try {console.log(JSON.stringify({value:await taskOperation(JSON.parse(process.argv[1]),{agentDir:process.argv[2]})}));} catch(e) {console.log(JSON.stringify({code:e.code}));}`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(input), agentDir], { cwd: process.cwd(), env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr); return JSON.parse(child.stdout);
}
async function fixture(t) { const f = await summaryFixture(); t.after(() => rm(f.agentDir, { recursive: true, force: true })); return f; }
const publish = (id, base = null, goal = "Manual") => ({ action: "publish-context", id, expectedCurrentVersionId: base, operationId: randomUUID(), content: { ...content, goal } });

test("07 source-union extension never relabels legacy manual/restore histories; joint v1/v2/main-v3/v4 absence-only views migration retains all receipts", async (t) => {
  const f = await fixture(t);
  const a = await f.call(publish(f.task.id));
  const b = await f.call(publish(f.task.id, a.task.sharedContext.currentVersionId, "Second"));
  await f.call({ action: "restore-context", id: f.task.id, operationId: randomUUID(), expectedCurrentVersionId: b.task.sharedContext.currentVersionId, versionId: a.task.sharedContext.currentVersionId });
  let board = await f.call({ action: "list" });
  await f.call({ action: "move", id: f.task.id, columnId: "done", position: { edge: "end" }, operationId: randomUUID(), expectedRevision: f.task.revision, expectedOrderRevision: board.orderRevision });
  board = await f.call({ action: "list" });
  const custom = randomUUID();
  await f.call({ action: "set-columns", expectedColumnsRevision: board.columnsRevision, columns: [...board.columns.map(({ id, label }) => ({ id, label })), { id: custom, label: "Custom" }] });
  const good = JSON.parse(await readFile(f.file, "utf8"));
  for (const version of [1, 2, 3, 4]) {
    const legacy = structuredClone(good); legacy.version = version; delete legacy.sessionRelations; delete legacy.viewsRevision; delete legacy.savedViews;
    if (version < 3) { delete legacy.columns; delete legacy.columnsRevision; }
    if (version === 1) delete legacy.orderRevision;
    await writeFile(f.file, JSON.stringify(legacy));
    const first = fresh({ action: "list" }, f.agentDir); assert.ok(first.value);
    const migrated = JSON.parse(await readFile(f.file, "utf8"));
    assert.equal(migrated.version, 7); assert.equal(migrated.viewsRevision, 0); assert.deepEqual(migrated.savedViews, []);
    assert.deepEqual(migrated.tasks, good.tasks, "original creation, relations, revisions, history and exact receipts remain identical");
    assert.deepEqual(migrated.tasks[0].sharedContext.versions.map((v) => v.source.kind), ["manual", "manual", "restore"]);
    if (version >= 3) { assert.deepEqual(migrated.columns, good.columns); assert.equal(migrated.columnsRevision, good.columnsRevision); }
    const stable = await readFile(f.file); assert.deepEqual(fresh({ action: "list" }, f.agentDir), first); assert.deepEqual(await readFile(f.file), stable);
  }
  for (const patch of [{ viewsRevision: null }, { savedViews: null }, { viewsRevision: undefined }, { savedViews: undefined }]) {
    const bad = JSON.stringify({ ...good, ...patch }); await writeFile(f.file, bad);
    assert.equal(fresh({ action: "list" }, f.agentDir).code, "storage-unavailable"); assert.equal(await readFile(f.file, "utf8"), bad);
  }
  assert.equal(f.captures.length, 0, "migration never infers AI provenance or calls a model");
});

test("07 generation/publication coexists with 05 views and columns/task/order/context CAS; fresh exact receipts return newest board without source access or regeneration", async (t) => {
  const f = await fixture(t), native = await readFile(f.source.getSessionFile());
  const create = { action: "createFromSession", id: f.task.id, title: f.task.title, description: f.task.description, completionCriteria: f.task.completionCriteria, sourceSessionId: f.source.getSessionId() };
  const generated = await f.generate(await f.snapshot());
  const save = { action: "save-view", id: randomUUID(), operationId: randomUUID(), expectedViewsRevision: 0, name: "AI view", filter: emptyTaskFilter(), sort: "updated" };
  const saved = await f.call(save);
  const custom = randomUUID();
  await f.call({ action: "set-columns", expectedColumnsRevision: 0, columns: [...saved.columns.map(({ id, label }) => ({ id, label })), { id: custom, label: "AI review" }] });
  const edit = { action: "edit", id: f.task.id, expectedRevision: 1, title: "Edited task", description: f.task.description, completionCriteria: f.task.completionCriteria, priority: 3, labels: ["review"] };
  const edited = await f.call(edit);
  const ai = { ...publish(f.task.id), generationId: generated.generationId, content: { ...generated.content, goal: "Edited AI output" } };
  const confirmed = await f.call(ai);
  assert.equal(confirmed.task.revision, edited.task.revision); assert.equal(confirmed.board.orderRevision, saved.orderRevision);
  assert.equal(confirmed.board.viewsRevision, 1); assert.equal(confirmed.board.columnsRevision, 1); assert.deepEqual(confirmed.board.savedViews, saved.savedViews);
  assert.deepEqual(confirmed.task.sharedContext.versions[0].source, generated.source);
  const move = { action: "move", id: f.task.id, columnId: custom, position: { edge: "end" }, operationId: randomUUID(), expectedRevision: edited.task.revision, expectedOrderRevision: confirmed.board.orderRevision };
  const moved = await f.call(move);
  const manual = publish(f.task.id, confirmed.task.sharedContext.currentVersionId, "Later manual"); const later = await f.call(manual);
  const restore = { action: "restore-context", id: f.task.id, operationId: randomUUID(), expectedCurrentVersionId: later.task.sharedContext.currentVersionId, versionId: confirmed.task.sharedContext.currentVersionId };
  const restored = await f.call(restore);
  assert.equal(restored.task.revision, moved.task.revision); assert.equal(restored.board.orderRevision, moved.board.orderRevision);
  assert.deepEqual(restored.task.sharedContext.versions.map((v) => v.source.kind), ["ai", "manual", "restore"]);
  const newest = await f.call({ ...save, id: randomUUID(), operationId: randomUUID(), expectedViewsRevision: 1, name: "Newest view" });
  await assert.rejects(f.call({ ...edit, title: "Stale details" }), { code: "conflict" });
  await assert.rejects(f.call({ ...ai, operationId: randomUUID() }), { code: "conflict" });
  assert.deepEqual(await readFile(f.source.getSessionFile()), native); await unlink(f.source.getSessionFile());
  const stable = await readFile(f.file);
  for (const request of [create, move, ai, manual, restore, save]) {
    const retried = fresh(request, f.agentDir); assert.deepEqual(retried.value.board ?? retried.value, newest);
    assert.deepEqual(await readFile(f.file), stable, "receipt confirmation does not replay, rewrite or roll back another domain");
  }
  assert.equal(f.captures.length, 1, "all retries, including new-process AI confirmation, avoid a second provider request");
});
