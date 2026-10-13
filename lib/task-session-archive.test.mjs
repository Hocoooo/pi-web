import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createJiti } from "jiti";
import lockfile from "proper-lockfile";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { taskOperation } = await jiti.import("./task-operations.ts");
const { withTaskStore } = await jiti.import("./task-store.ts");
const { waitForTaskReportExecutor } = await jiti.import("./task-report-executor.ts");
const { readArchivedSessionIds, setSessionArchived } = await jiti.import("./session-archive.ts");

async function fixture(t) {
  const agentDir = await mkdtemp(join(tmpdir(), "task-session-archive-"));
  const cwd = join(agentDir, "chat-workspace"); await mkdir(cwd);
  const prior = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    await waitForTaskReportExecutor();
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
    await rm(agentDir, { recursive: true, force: true });
  });
  const op = input => taskOperation(input, { agentDir });
  const current = async id => (await op({ action: "list" })).tasks.find(task => task.id === id);
  const create = async title => (await op({ action: "create", id: randomUUID(), title, description: "", completionCriteria: "", cwd: null })).task;
  const session = async parent => {
    const manager = SessionManager.create(cwd);
    if (parent) manager.appendCustomEntry("pi-web:subagent", { version: 1, parentSessionId: parent.getSessionId(), parentSessionPath: parent.getSessionFile(), profile: "worker", description: "Synthetic child" });
    manager.appendMessage({ role: "user", content: "Synthetic preserved history", timestamp: 1 });
    if (parent) {
      const lines = (await readFile(manager.getSessionFile(), "utf8")).split("\n");
      lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), parentSession: parent.getSessionFile() });
      await writeFile(manager.getSessionFile(), lines.join("\n"));
    }
    return manager;
  };
  const link = async (id, ids) => op({ action: "link", id, expectedRevision: (await current(id)).revision, sessionIds: ids });
  // Seed pre-existing child associations: the Dashboard's new bulk-link policy
  // must not prevent testing archive compatibility with already stored relations.
  const legacyLink = async (id, ids) => withTaskStore(agentDir, document => {
    assert.ok(ids.every(sessionId => !document.tasks.some(task => task.sessionIds.includes(sessionId))));
    const task = document.tasks.find(task => task.id === id);
    task.sessionIds.push(...ids); task.revision++;
    task.updatedAt = new Date(Math.max(Date.now(), Date.parse(task.updatedAt) + 1)).toISOString();
    return { value: undefined, changed: true };
  });
  const preview = id => op({ action: "preview-archive", id });
  const request = (p, confirmCrossTask = false) => ({ action: "set-archive", id: p.taskId, archived: true, expectedArchiveRevision: p.archiveRevision, operationId: randomUUID(), cascade: { previewToken: p.token, confirmCrossTask } });
  return { agentDir, cwd, op, current, create, session, link, legacyLink, preview, request, boardFile: join(agentDir, "tasks", "board.json") };
}

test("one-shot archive freezes linked roots, preserves native history and restores only the task", async t => {
  const f = await fixture(t), task = await f.create("One-shot"), a = await f.session(), b = await f.session();
  await f.link(task.id, [a.getSessionId(), b.getSessionId()]);
  const bytes = await Promise.all([a, b].map(s => readFile(s.getSessionFile())));
  const before = await f.current(task.id), p = await f.preview(task.id);
  assert.deepEqual(new Set(p.families.map(x => x.rootSessionId)), new Set([a.getSessionId(), b.getSessionId()]));
  assert.deepEqual([...await readArchivedSessionIds(f.agentDir)], [], "preview has no archive side effects");
  const r = f.request(p), archived = await f.op(r);
  assert.equal(archived.task.archived, true); assert.equal(archived.task.archiveRevision, 1);
  assert.equal(archived.task.revision, before.revision); assert.equal(archived.task.updatedAt, before.updatedAt);
  assert.deepEqual(new Set(archived.sessionArchive.rootSessionIds), new Set([a.getSessionId(), b.getSessionId()]));
  assert.deepEqual(new Set(await readArchivedSessionIds(f.agentDir)), new Set([a.getSessionId(), b.getSessionId()]));
  const c = await f.session(); await f.link(task.id, [c.getSessionId()]);
  await setSessionArchived(a.getSessionId(), false, f.agentDir);
  await f.op(r); // Lost response retry must not re-archive A or include the later C.
  assert.deepEqual([...await readArchivedSessionIds(f.agentDir)], [b.getSessionId()]);
  const restored = await f.op({ action: "set-archive", id: task.id, archived: false, expectedArchiveRevision: 1, operationId: randomUUID() });
  assert.equal(restored.task.archived, false); assert.equal(restored.sessionArchive, undefined);
  assert.deepEqual([...await readArchivedSessionIds(f.agentDir)], [b.getSessionId()]);
  assert.deepEqual(await Promise.all([a, b].map(s => readFile(s.getSessionFile()))), bytes);
  await assert.rejects(f.op(r), { code: "conflict" });
});

test("cross-task family expansion requires consent in both child-to-root and root-to-child directions", async t => {
  const f = await fixture(t), a = await f.create("Parent task"), b = await f.create("Child task");
  const root = await f.session(), child = await f.session(root), nested = await f.session(child);
  await f.link(a.id, [root.getSessionId()]); await f.legacyLink(b.id, [child.getSessionId(), nested.getSessionId()]);
  const p = await f.preview(b.id);
  assert.equal(p.families.length, 1); assert.equal(p.families[0].rootSessionId, root.getSessionId());
  assert.deepEqual(p.families[0].otherTasks, [{ id: a.id, title: "Parent task", sessionIds: [root.getSessionId()] }]);
  assert.deepEqual(new Set(p.families[0].sessionIds), new Set([root, child, nested].map(s => s.getSessionId())));
  const bytes = await readFile(f.boardFile);
  await assert.rejects(f.op(f.request(p)), { code: "conflict" });
  assert.deepEqual(await readFile(f.boardFile), bytes); assert.equal((await readArchivedSessionIds(f.agentDir)).size, 0);
  const accepted = await f.op(f.request(p, true));
  assert.deepEqual(accepted.sessionArchive.rootSessionIds, [root.getSessionId()]);
  assert.equal((await f.current(a.id)).archived, false, "other task remains active even though its family is hidden");
  const parentPreview = await f.preview(a.id);
  assert.deepEqual(parentPreview.families[0].otherTasks[0].sessionIds, [child.getSessionId(), nested.getSessionId()].sort());
  await assert.rejects(f.op(f.request(parentPreview)), { code: "conflict" });
});

test("stale membership, owner ABA and newly persisted descendants invalidate reviewed scope before any archive", async t => {
  const f = await fixture(t), a = await f.create("A"), b = await f.create("B"), root = await f.session(), child = await f.session(root);
  await f.link(a.id, [root.getSessionId()]);
  let p = await f.preview(a.id);
  await f.legacyLink(b.id, [child.getSessionId()]);
  const relation = (await f.op({ action: "sessions", id: b.id })).linked[0];
  await f.op({ action: "change-session-relation", sessionId: child.getSessionId(), sourceTaskId: b.id, targetTaskId: null,
    expectedGeneration: relation.relationGeneration, expectedUpdateRevision: relation.updateRevision, operationId: randomUUID() });
  await assert.rejects(f.op(f.request(p)), { code: "conflict" });
  p = await f.preview(a.id); await f.session(root);
  await assert.rejects(f.op(f.request(p)), { code: "conflict" });
  p = await f.preview(a.id); const later = await f.session(); await f.link(a.id, [later.getSessionId()]);
  await assert.rejects(f.op(f.request(p)), { code: "conflict" });
  assert.equal((await f.current(a.id)).archived, false); assert.equal((await readArchivedSessionIds(f.agentDir)).size, 0);
});

test("fresh same-state cascades cannot replace an archived task's intent and revive superseded batches", async t => {
  const f = await fixture(t), task = await f.create("Fenced"), s = await f.session(); await f.link(task.id, [s.getSessionId()]);
  await f.op({ action: "set-archive", id: task.id, archived: true, expectedArchiveRevision: 0, operationId: randomUUID() });
  const a = f.request(await f.preview(task.id));
  await assert.rejects(f.op(a), { code: "conflict" });
  assert.equal((await readArchivedSessionIds(f.agentDir)).size, 0);
  await f.op({ action: "set-archive", id: task.id, archived: false, expectedArchiveRevision: 1, operationId: randomUUID() });
  const accepted = f.request(await f.preview(task.id)); await f.op(accepted);
  await setSessionArchived(s.getSessionId(), false, f.agentDir);
  await assert.rejects(f.op(f.request(await f.preview(task.id))), { code: "conflict" });
  await f.op(accepted); assert.equal((await readArchivedSessionIds(f.agentDir)).size, 0);
});

test("known board-lock loss before the batch refuses session effects after a newer process restores the task", async t => {
  const f = await fixture(t), task = await f.create("Lock fence"), s = await f.session(); await f.link(task.id, [s.getSessionId()]);
  const request = f.request(await f.preview(task.id));
  const originalLock = lockfile.lock;
  let boardOptions, injected = false;
  // Fault injection is at the external filesystem lock seam. A separate process really
  // restores the committed pending task after this writer has lost board authority.
  lockfile.lock = async (file, options) => {
    if (file.endsWith("board.json")) boardOptions = options;
    if (file.endsWith("session-archive.json") && !injected) {
      injected = true; boardOptions.onCompromised(new Error("Synthetic lost board lease"));
      await rm(`${f.boardFile}.lock`, { recursive: true, force: true });
      const operationsUrl = new URL("./task-operations.ts", import.meta.url).href;
      await promisify(execFile)(process.execPath, ["--input-type=module", "-e", `
        import { createJiti } from 'jiti';
        const { taskOperation } = await createJiti(import.meta.url, { alias: {'@': process.cwd()} }).import(${JSON.stringify(operationsUrl)});
        await taskOperation(${JSON.stringify({ action: "set-archive", id: task.id, archived: false, expectedArchiveRevision: 1, operationId: randomUUID() })}, { agentDir: ${JSON.stringify(f.agentDir)} });`], { cwd: process.cwd(), timeout: 30000 });
    }
    return originalLock(file, options);
  };
  try { await assert.rejects(f.op(request), { code: "storage-unavailable" }); }
  finally { lockfile.lock = originalLock; }
  assert.equal(injected, true); assert.equal((await f.current(task.id)).archived, false);
  assert.equal((await readArchivedSessionIds(f.agentDir)).size, 0, "stale writer cannot apply a batch using the old captured board");
});

test("missing, unpersisted, unsupported and orphaned links are reported, never resurrected or silently treated as roots", async t => {
  const f = await fixture(t), task = await f.create("Skipped"), missing = await f.session(), orphanParent = await f.session(), orphan = await f.session(orphanParent);
  const unsupported = SessionManager.create(f.cwd);
  unsupported.appendMessage({ role: "user", content: "Explicit SDK ID", timestamp: 1 });
  const lines = (await readFile(unsupported.getSessionFile(), "utf8")).split("\n");
  lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), id: "native-non-uuid" }); await writeFile(unsupported.getSessionFile(), lines.join("\n"));
  const warm = SessionManager.create(f.cwd), warmId = warm.getSessionId();
  (globalThis.__piSessions ??= new Map()).set(warmId, { inner: { sessionManager: warm }, isAlive: () => true, hasDeletedSessionFile: () => false, isRunning: () => true });
  t.after(() => globalThis.__piSessions.delete(warmId));
  await f.legacyLink(task.id, [missing.getSessionId(), orphan.getSessionId(), "native-non-uuid", warmId]);
  await rm(missing.getSessionFile()); await rm(orphanParent.getSessionFile());
  const p = await f.preview(task.id), reasons = Object.fromEntries(p.skipped.map(s => [s.sessionId, s.reason]));
  assert.deepEqual(reasons, { [missing.getSessionId()]: "missing", [orphan.getSessionId()]: "unresolved-family", "native-non-uuid": "unsupported-id", [warmId]: "unpersisted" });
  assert.deepEqual(p.families, []);
  const r = await f.op(f.request(p)); assert.equal(r.sessionArchive.skipped.length, 4);
  assert.deepEqual((await f.current(task.id)).sessionIds, [missing.getSessionId(), orphan.getSessionId(), "native-non-uuid", warmId]);
  assert.equal((await readArchivedSessionIds(f.agentDir)).size, 0);
});

test("failed batch remains discoverable and resumable with the same intent, and task restoration fences pending work", async t => {
  const f = await fixture(t), task = await f.create("Partial"), s = await f.session(); await f.link(task.id, [s.getSessionId()]);
  const r = f.request(await f.preview(task.id)), archiveFile = join(f.agentDir, "session-archive.json");
  await writeFile(archiveFile, "broken archive metadata");
  await assert.rejects(f.op(r), { code: "storage-unavailable" });
  const pending = await f.current(task.id);
  assert.equal(pending.archived, true);
  assert.deepEqual(pending.pendingSessionArchive, { operationId: r.operationId, expectedArchiveRevision: r.expectedArchiveRevision, ...r.cascade });
  assert.equal(await readFile(archiveFile, "utf8"), "broken archive metadata");
  await rm(archiveFile);
  await f.op(r); assert.equal((await f.current(task.id)).pendingSessionArchive, undefined);
  assert.deepEqual([...await readArchivedSessionIds(f.agentDir)], [s.getSessionId()]);
  await f.op({ action: "set-archive", id: task.id, archived: false, expectedArchiveRevision: 1, operationId: randomUUID() });
  const second = f.request(await f.preview(task.id)); await writeFile(archiveFile, "broken again");
  await assert.rejects(f.op(second), { code: "storage-unavailable" });
  await f.op({ action: "set-archive", id: task.id, archived: false, expectedArchiveRevision: 3, operationId: randomUUID() });
  await rm(archiveFile);
  await assert.rejects(f.op(second), { code: "conflict" });
  assert.equal((await readArchivedSessionIds(f.agentDir)).size, 0);
});

test("pending retry refuses changed ownership, but a committed batch confirms after restart without undoing a manual restore", async t => {
  const f = await fixture(t), task = await f.create("Retry"), other = await f.create("Other"), s = await f.session();
  await f.link(task.id, [s.getSessionId()]);
  const r = f.request(await f.preview(task.id)), archiveFile = join(f.agentDir, "session-archive.json");
  await writeFile(archiveFile, "broken"); await assert.rejects(f.op(r), { code: "storage-unavailable" }); await rm(archiveFile);
  const relation = (await f.op({ action: "sessions", id: task.id })).linked[0];
  await f.op({ action: "change-session-relation", sessionId: s.getSessionId(), sourceTaskId: task.id, targetTaskId: other.id,
    expectedGeneration: relation.relationGeneration, expectedUpdateRevision: relation.updateRevision, operationId: randomUUID() });
  await assert.rejects(f.op(r), { code: "conflict" }); assert.equal((await readArchivedSessionIds(f.agentDir)).size, 0);
  const next = f.request(await f.preview(other.id)); await f.op(next);
  // Recreate exactly the durable crash window: session batch committed, board completion not persisted.
  const board = JSON.parse(await readFile(f.boardFile, "utf8"));
  board.tasks.find(task => task.id === other.id).archiveReceipt.cascade.status = "pending";
  await writeFile(f.boardFile, JSON.stringify(board));
  await setSessionArchived(s.getSessionId(), false, f.agentDir);
  const fresh = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });
  const { taskOperation: restart } = await fresh.import("./task-operations.ts");
  const confirmed = await restart(next, { agentDir: f.agentDir });
  assert.equal(confirmed.task.pendingSessionArchive, undefined); assert.equal((await readArchivedSessionIds(f.agentDir)).size, 0);
  await assert.rejects(f.op({ ...next, cascade: { ...next.cascade, confirmCrossTask: true } }), { code: "conflict" });
});

test("malformed or truncated native relation markers remain explicitly unresolved rather than independent roots", async t => {
  const f = await fixture(t), task = await f.create("Malformed family"), parent = await f.session(), child = await f.session(parent);
  await f.legacyLink(task.id, [child.getSessionId()]); await rm(parent.getSessionFile());
  const path = child.getSessionFile(), original = await readFile(path, "utf8"), lines = original.split("\n");
  const { type: ignoredType, ...missingType } = JSON.parse(lines[1]); void ignoredType;
  for (const marker of [lines[1].slice(0, -1), "x".repeat(300000), JSON.stringify(missingType), JSON.stringify({ ...missingType, type: "message" })]) {
    await writeFile(path, [lines[0], marker, ...lines.slice(2)].join("\n"));
    const preview = await f.preview(task.id);
    assert.deepEqual(preview.families, []);
    assert.deepEqual(preview.skipped, [{ sessionId: child.getSessionId(), reason: "unresolved-family" }]);
  }
});

test("malformed cascade receipt domains fail closed and never repair or expose stored retry internals", async t => {
  const f = await fixture(t), task = await f.create("Receipt validation"), s = await f.session(); await f.link(task.id, [s.getSessionId()]);
  await f.op(f.request(await f.preview(task.id)));
  const valid = await readFile(f.boardFile, "utf8");
  for (const mutate of [
    task => { delete task.archiveReceipt.cascade.previewToken; },
    task => { task.archiveReceipt.cascade.status = "unknown"; },
    task => { task.archiveReceipt.cascade.rootSessionIds = ["../private"]; },
    task => { task.archiveReceipt.cascade.expectedArchiveRevision = -1; },
    task => { task.archiveReceipt.cascade.skipped = [{ sessionId: s.getSessionId(), reason: "unknown" }]; },
    task => { task.archived = false; },
    task => { task.pendingSessionArchive = { operationId: randomUUID() }; },
  ]) {
    const document = JSON.parse(valid); mutate(document.tasks[0]);
    const malformed = JSON.stringify(document); await writeFile(f.boardFile, malformed);
    await assert.rejects(f.op({ action: "list" }), { code: "storage-unavailable" });
    assert.equal(await readFile(f.boardFile, "utf8"), malformed);
  }
  await writeFile(f.boardFile, valid);
  const publicRecord = await f.current(task.id);
  assert.equal("archiveReceipt" in publicRecord, false); assert.equal(publicRecord.pendingSessionArchive, undefined);
});
