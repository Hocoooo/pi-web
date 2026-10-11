// Relations are metadata-only; old busy/admission assertions are superseded by F31.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdir, rm, chmod } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createJiti } from "jiti";
import { legacyFixture, owner, seedLegacyChoice, tasksHttp } from "./task-legacy-fixture.mjs";
const { resolveProject } = await createJiti(import.meta.url).import("./worktree.ts");

for (const kind of ["prompt-pending", "streaming", "queue", "UI", "custom-UI", "compaction", "bash", "closing", "deleted-file-busy"]) test(`relation during ${kind} preserves native work/history and clears only obsolete pending (missing files still refuse)`, async t => {
  const f = await legacyFixture(t), target = await f.create(), { w, inner, calls } = f.wrapper();
  const request = await f.relation(target.id), before = await f.raw(), history = await readFile(f.source.getSessionFile());
  if (kind === "prompt-pending") w.pendingPromptCount = 1;
  if (["streaming", "closing", "deleted-file-busy"].includes(kind)) inner.isStreaming = true;
  if (kind === "queue") inner.pendingMessageCount = 2;
  if (kind === "UI") w.pendingUiResponses.set("fixture", {});
  if (kind === "custom-UI") w.activeCustomUis.set("fixture", {});
  if (kind === "compaction") inner.isCompacting = true;
  if (kind === "bash") inner.isBashRunning = true;
  if (kind === "closing") w.closing = true;
  if (kind === "deleted-file-busy") {
    await rm(f.source.getSessionFile()); const bytes = await readFile(f.file);
    await assert.rejects(f.op(request), { code: "not-found" }); assert.deepEqual(await readFile(f.file), bytes);
  } else {
    const saved = await f.op(request), old = saved.tasks.find(t => t.id === f.task.id);
    assert.equal(owner(saved, f.sessionId).id, target.id);
    assert.equal(old.sessionUpdates[0].pendingOperationId, null);
    assert.deepEqual(old.sessionUpdates[0].choices, before.tasks[0].sessionUpdates[0].choices);
    assert.deepEqual(old.sessionUpdates[0].deliveries, before.tasks[0].sessionUpdates[0].deliveries);
    assert.deepEqual(old.sessionContexts, before.tasks[0].sessionContexts);
    assert.deepEqual(await readFile(f.source.getSessionFile()), history);
  }
  assert.equal(calls.aborts, 0); assert.equal(calls.prompts.length, 0); assert.equal(calls.disposes, 0);
});

test("HTTP removal of a missing chat validates its legacy update revision and preserves historical records", async t => {
  const f = await legacyFixture(t), target = await f.create();
  await f.change(target.id); await f.change(f.task.id);
  await seedLegacyChoice(f, f.task.id, f.sessionId, f.legacy.ai.version.id);
  const stale = await f.relation(null);
  await seedLegacyChoice(f, f.task.id, f.sessionId, f.legacy.manual.version.id);
  await rm(f.source.getSessionFile());
  const post = input => tasksHttp(new Request("http://localhost/api/tasks", { method: "POST", body: JSON.stringify(input) }));
  const before = await f.list();
  assert.equal((await post(stale)).status, 409, "a deleted file does not bypass the update CAS");
  assert.deepEqual(await f.list(), before);
  const metadata = await (await post({ action: "sessions", id: f.task.id })).json();
  assert.equal(metadata.linked[0].missing, true);
  assert.equal(metadata.linked[0].relationGeneration, 2);
  assert.ok(metadata.linked[0].updateRevision > stale.expectedUpdateRevision);
  const request = { ...stale, operationId: randomUUID(), expectedUpdateRevision: metadata.linked[0].updateRevision };
  const response = await post(request);
  assert.equal(response.status, 200, await response.clone().text());
  const saved = await response.json(), original = before.tasks.find(task => task.id === f.task.id), changed = saved.tasks.find(task => task.id === f.task.id);
  assert.equal(owner(saved, f.sessionId), undefined);
  assert.equal(changed.sessionUpdates[0].pendingOperationId, null);
  assert.deepEqual(changed.sessionUpdates[0].choices, original.sessionUpdates[0].choices);
  assert.deepEqual(changed.sessionUpdates[0].deliveries, original.sessionUpdates[0].deliveries);
  assert.deepEqual(changed.sessionContexts, original.sessionContexts);
  assert.deepEqual(changed.sharedContext, original.sharedContext);
  assert.deepEqual(f.fresh(request).value, saved, "a restart confirms the same receipt without replay");
  assert.equal((await post({ ...request, operationId: randomUUID() })).status, 409, "departure advances the relation generation");
  await assert.rejects(readFile(f.source.getSessionFile()), { code: "ENOENT" });
});

test("two-tab CAS, stale update revision, exact retry and unlink never duplicate/replay ownership", async t => {
  const f = await legacyFixture(t), b = await f.create("B"), c = await f.create("C"), request = await f.relation(b.id);
  const outcomes = await Promise.allSettled([f.op(request), f.op({ ...request, targetTaskId: c.id, operationId: randomUUID() })]);
  assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 1); assert.equal(outcomes.find(r => r.status === "rejected").reason.code, "conflict");
  const actual = owner(await f.list(), f.sessionId); await f.change(f.task.id);
  const stale = await f.relation(null); await seedLegacyChoice(f, f.task.id, f.sessionId, f.legacy.ai.version.id);
  const bytes = await readFile(f.file); await assert.rejects(f.op(stale), { code: "conflict" }); assert.deepEqual(await readFile(f.file), bytes);
  const unlink = await f.relation(null), unlinked = await f.op(unlink), stable = await readFile(f.file);
  assert.equal(owner(unlinked, f.sessionId), undefined); assert.deepEqual(await f.op(unlink), unlinked); assert.deepEqual(await readFile(f.file), stable);
  await assert.rejects(f.op({ ...unlink, targetTaskId: actual.id }), { code: "conflict" });
  assert.deepEqual(await f.op({ action: "session-task", sessionId: f.sessionId }), { task: null });
});

test("authoritative scope rejects cross-project/chat and stale worktree identity; same-project reassign works", async t => {
  const f = await legacyFixture(t), project = join(f.agentDir, "project"), other = join(f.agentDir, "other"); await mkdir(project); await mkdir(other);
  const foreign = await f.create("Foreign", project), bytes = await readFile(f.file);
  await assert.rejects(f.change(foreign.id), { code: "invalid-input" }); assert.deepEqual(await readFile(f.file), bytes);
  const git = (...args) => execFileSync("git", args, { stdio: "pipe" });
  for (const dir of [project, other]) { git("init", dir); git("-C", dir, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture"); }
  const wt = join(f.agentDir, "worktree"); git("-C", project, "worktree", "add", "-b", "fixture", wt);
  const manager = f.native(wt), id = manager.getSessionId();
  const source = (await f.op({ action: "createFromSession", id: randomUUID(), title: "Project source", description: "", completionCriteria: "", sourceSessionId: id })).task;
  const target = await f.create("Same project", project);
  assert.equal(owner(await f.change(target.id, id), id).id, target.id);
  await resolveProject(wt); git("-C", project, "worktree", "remove", wt); git("-C", other, "worktree", "add", "-b", "replacement", wt);
  const unchanged = await readFile(f.file); await assert.rejects(f.change(source.id, id), { code: "invalid-input" }); assert.deepEqual(await readFile(f.file), unchanged);
});

test("archived source/target reassign while busy; write failure preserves original owner and pending atomically", { skip: process.platform === "win32" ? "POSIX permission fixture" : false }, async t => {
  const f = await legacyFixture(t), target = await f.create(); await f.archive(); await f.archive(target.id);
  const { inner, calls } = f.wrapper(); inner.isStreaming = true;
  const request = await f.relation(target.id), bytes = await readFile(f.file);
  await chmod(join(f.agentDir, "tasks"), 0o500);
  try { await assert.rejects(f.op(request), { code: "storage-unavailable" }); assert.deepEqual(await readFile(f.file), bytes); }
  finally { await chmod(join(f.agentDir, "tasks"), 0o700); }
  const saved = await f.op(request); assert.equal(owner(saved, f.sessionId).id, target.id); assert.ok(saved.tasks.every(t => t.archived));
  assert.equal(inner.isStreaming, true); assert.equal(calls.aborts, 0);
});

test("HTTP relation success/retry, strict field guards and internal action whitelist remain enforced", async t => {
  const f = await legacyFixture(t), b = await f.create(), request = await f.relation(b.id);
  const post = input => tasksHttp(new Request("http://localhost/api/tasks", { method: "POST", body: JSON.stringify(input) }));
  const before = await readFile(f.file);
  for (const action of ["pending-context-update", "complete-context-update", "admit-start", "admit-session-work", "prepare-session-copy", "complete-session-copy"]) assert.equal((await post({ ...request, action })).status, 400);
  for (const extra of [{ generation: 0 }, { expectedGeneration: null }, { targetTaskId: f.task.id }, { sessionId: "../escape" }, { expectedUpdateRevision: -1 }]) assert.equal((await post({ ...request, ...extra })).status, 400);
  assert.deepEqual(await readFile(f.file), before); assert.equal((await post(request)).status, 200);
  const stable = await readFile(f.file); assert.equal((await post(request)).status, 200); assert.deepEqual(await readFile(f.file), stable);
});
