// Actual SDK runtime + original POST copy path. Historical data is seeded explicitly.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createJiti } from "jiti";
import { legacyFixture, emptyTaskFilter, SessionManager } from "./task-legacy-fixture.mjs";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { startRpcSession, getRpcSession } = await jiti.import("./rpc-manager.ts");
const { POST } = await jiti.import("../app/api/agent/[id]/route.ts");

test("SDK clone and retry preserve legacy AI/manual/restore provenance, adoption audits, views and all independent receipts", async t => {
  const f = await legacyFixture(t), save = { action: "save-view", id: randomUUID(), operationId: randomUUID(), expectedViewsRevision: 0, name: "Copy", filter: emptyTaskFilter(), sort: "updated" };
  const saved = await f.op(save), custom = randomUUID();
  await f.op({ action: "set-columns", expectedColumnsRevision: saved.columnsRevision, columns: [...saved.columns.map(({ id, label }) => ({ id, label })), { id: custom, label: "Copy review" }] });
  await f.move(f.task.id, custom); await f.archive();
  const good = await f.raw(), legacy = structuredClone(good); legacy.version = 4; delete legacy.sessionRelations; delete legacy.sessionCopies;
  await writeFile(f.file, JSON.stringify(legacy)); assert.ok(f.fresh().value); assert.deepEqual(await f.raw(), good);
  const { session } = await startRpcSession(f.sessionId, f.source.getSessionFile(), f.cwd, { toolNames: [] });
  t.after(async () => { await session.shutdown(); await getRpcSession(f.sessionId)?.shutdown(); });
  const history = await readFile(f.source.getSessionFile()), command = { type: "clone", leafId: f.source.getLeafId(), operationId: randomUUID() };
  const post = () => POST(new Request("http://localhost/api/agent/fixture", { method: "POST", body: JSON.stringify(command) }), { params: Promise.resolve({ id: f.sessionId }) });
  const response = await post(); assert.equal(response.status, 200, await response.clone().text()); const result = await response.json();
  assert.deepEqual(await (await post()).json(), result);
  const after = await f.raw();
  for (const key of ["columns", "columnsRevision", "orderRevision", "viewsRevision", "savedViews", "sessionRelations"]) assert.deepEqual(after[key], good[key]);
  for (const key of Object.keys(good.tasks[0]).filter(k => !["revision", "updatedAt", "sessionIds"].includes(k))) assert.deepEqual(after.tasks[0][key], good.tasks[0][key]);
  assert.equal(after.tasks[0].revision, good.tasks[0].revision + 1); assert.deepEqual(after.tasks[0].sessionIds, [f.sessionId, result.data.newSessionId]);
  const childInfo = (await SessionManager.listAll()).find(s => s.id === result.data.newSessionId), child = SessionManager.open(childInfo.path);
  assert.deepEqual(child.getEntries(), f.source.getBranch()); assert.equal(child.getHeader().parentSession, f.source.getSessionFile());
  assert.ok(!after.tasks[0].sessionContexts.some(c => c.sessionId === result.data.newSessionId)); assert.ok(!after.tasks[0].sessionUpdates.some(c => c.sessionId === result.data.newSessionId));
  const bytes = await readFile(f.file);
  for (const request of [f.legacy.manual.request, f.legacy.ai.request, f.legacy.restore]) await assert.rejects(f.op(request), /suspended/);
  assert.deepEqual(await f.op(save), await f.list()); assert.deepEqual(await readFile(f.file), bytes); assert.deepEqual(await readFile(f.source.getSessionFile()), history);
  await assert.rejects(f.op({ action: "edit", id: f.task.id, expectedRevision: good.tasks[0].revision, title: "Stale", description: "", completionCriteria: "", priority: 1, labels: [] }), { code: "conflict" });
});
