import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { taskOperation } = await jiti.import("./task-operations.ts");
const { taskColumnRemovalDigest } = await jiti.import("./task-store.ts");
const { emptyTaskFilter, projectTaskView } = await jiti.import("./task-view.ts");
const create = title => ({ action: "create", id: randomUUID(), title, description: "Original", completionCriteria: "User confirms", cwd: null });
const removal = (board, columnId, targetColumnId, confirmCompletion = false) => ({ action: "remove-column", columnId, targetColumnId, confirmCompletion, operationId: randomUUID(), expectedColumnsRevision: board.columnsRevision, expectedOrderRevision: board.orderRevision, expectedSourceDigest: board.columnRemovalDigests[columnId] });
async function fixture(t) {
  const agentDir = await mkdtemp(join(tmpdir(), "remove14-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const call = input => taskOperation(input, { agentDir });
  const list = () => call({ action: "list" });
  const move = async (id, columnId) => { const b = await list(); return { action: "move", id, columnId, operationId: randomUUID(), expectedRevision: b.tasks.find(t => t.id === id).revision, expectedOrderRevision: b.orderRevision, position: { edge: "end" } }; };
  return { agentDir, file: join(agentDir, "tasks/board.json"), call, list, move };
}
function fresh(f, input, failRename = false) {
  const script = `import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';if(${failRename}){fs.rename=async()=>{throw Object.assign(new Error('Injected rename failure'),{code:'EIO'});};syncBuiltinESMExports();}import {createJiti} from 'jiti';const {taskOperation}=await createJiti(import.meta.url).import('./lib/task-operations.ts');try{console.log(JSON.stringify({value:await taskOperation(JSON.parse(process.argv[1]),{agentDir:process.argv[2]})}));}catch(e){console.log(JSON.stringify({code:e.code,message:e.message}));}`;
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(input), f.agentDir], { cwd: process.cwd(), env: process.env });
    let out = "", err = ""; p.stdout.on("data", d => out += d); p.stderr.on("data", d => err += d); p.on("error", reject);
    p.on("exit", code => code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err)));
  });
}

test("full source transfer includes archived/hidden tasks, appends deterministic order and retains all other domains/receipts", async t => {
  const f = await fixture(t), ids = [];
  for (const name of ["Source A", "Target A", "Hidden source", "Other", "Target B", "Archived source"]) ids.push((await f.call(create(name))).task.id);
  const oldMove = await f.move(ids[0], "todo"); await f.call(oldMove);
  for (const id of [ids[1], ids[4]]) await f.call(await f.move(id, "review"));
  await f.call(await f.move(ids[3], "blocked"));
  const publish = { action: "publish-context", id: ids[2], expectedCurrentVersionId: null, operationId: randomUUID(), content: { goal: "Knowledge", decisions: "Keep", progress: "Reviewed", nextSteps: "Continue" } };
  const v = (await f.call(publish)).task.sharedContext.currentVersionId;
  await f.call({ ...publish, operationId: randomUUID(), expectedCurrentVersionId: v, content: { ...publish.content, goal: "Later" } });
  const archive = { action: "set-archive", id: ids[5], archived: true, expectedArchiveRevision: 0, operationId: randomUUID() }; await f.call(archive);
  const view = { action: "save-view", id: randomUUID(), operationId: randomUUID(), expectedViewsRevision: 0, name: "Source only", filter: { ...emptyTaskFilter(), columnIds: ["todo"] }, sort: "manual" }; await f.call(view);
  const b = await f.list(), stored = JSON.parse(await readFile(f.file));
  const sourceIds = b.tasks.filter(t => t.columnId === "todo").map(t => t.id), targetIds = b.tasks.filter(t => t.columnId === "review").map(t => t.id);
  const r = removal(b, "todo", "review"), saved = await f.call(r);
  assert.deepEqual(saved.tasks.filter(t => t.columnId === "review").map(t => t.id), [...targetIds, ...sourceIds]);
  assert.equal(saved.columns.some(c => c.id === "todo"), false); assert.equal(saved.orderRevision, b.orderRevision + 1); assert.equal(saved.columnsRevision, b.columnsRevision + 1);
  assert.deepEqual(saved.savedViews, b.savedViews); assert.equal(saved.viewsRevision, b.viewsRevision);
  assert.deepEqual(projectTaskView(saved, saved.savedViews[0].filter, "manual", new Set(), false), { tasks: [], invalid: true });
  const after = JSON.parse(await readFile(f.file));
  for (const task of stored.tasks) {
    const current = after.tasks.find(t => t.id === task.id);
    if (!sourceIds.includes(task.id)) assert.deepEqual(current, task);
    else { const { columnId, revision, updatedAt, ...rest } = current; const original = structuredClone(task); for (const key of ["columnId", "revision", "updatedAt"]) delete original[key]; assert.deepEqual(rest, original); assert.equal(columnId, "review"); assert.equal(revision, task.revision + 1); assert.ok(Date.parse(updatedAt) > Date.parse(task.updatedAt)); }
  }
  const bytes = await readFile(f.file); for (const input of [r, oldMove, publish, archive, view]) {
    const reply = (await fresh(f, input)).value; assert.deepEqual(reply.board ?? reply, saved); assert.deepEqual(await readFile(f.file), bytes);
  }
  assert.deepEqual((await fresh(f, { action: "list" })).value, saved);
  await assert.rejects(f.call({ ...r, targetColumnId: "done", confirmCompletion: true }), { code: "conflict" });
});

test("done/last unfinished protected on backend; receiving done needs separate confirmation; empty deletions and fresh creates after todo removal", async t => {
  const f = await fixture(t); await f.call(create("Source")); let b = await f.list();
  for (const r of [removal(b, "done", "review"), removal(b, "todo", "done"), { ...removal(b, "todo", "review"), targetColumnId: "todo" }, removal(b, "todo", randomUUID())]) await assert.rejects(f.call(r), { code: "invalid-input" });
  b = await f.call(removal(b, "todo", "done", true)); assert.equal(b.tasks[0].columnId, "done");
  const request = create("After todo removal"); const made = await f.call(request); assert.equal(made.task.columnId, "in-progress");
  // Existing todo preference survives column reordering; once absent, first unfinished is authority.
  const managerDir = join(f.agentDir, "sessions/fixture"); await mkdir(managerDir, { recursive: true });
  const cwd = join(f.agentDir, "chat-workspace"); await mkdir(cwd);
  const manager = SessionManager.create(cwd, managerDir); manager.appendMessage({ role: "user", content: "Synthetic", timestamp: Date.now() }); manager.appendSessionInfo("Metadata fixture");
  const source = { action: "createFromSession", id: randomUUID(), title: "After deleted todo source", description: "", completionCriteria: "", sourceSessionId: manager.getSessionId() };
  const nativeBytes = await readFile(manager.getSessionFile()); assert.equal((await f.call(source)).task.columnId, "in-progress"); assert.deepEqual(await readFile(manager.getSessionFile()), nativeBytes);
  b = await f.list();
  for (const id of ["review", "blocked"]) { const order = b.orderRevision; b = await f.call(removal(b, id, "in-progress")); assert.equal(b.orderRevision, order, "empty deletion preserves order revision"); }
  assert.deepEqual(b.columns.map(c => c.id), ["in-progress", "done"]);
  await assert.rejects(f.call(removal(b, "in-progress", "done", true)), { code: "invalid-input" });
  assert.equal((await fresh(f, request)).value.task.id, made.task.id); assert.equal((await fresh(f, source)).value.task.columnId, "in-progress");
});

test("all source tasks archived still migrate without restore; identical two-process deletion confirms once", async t => {
  const f = await fixture(t);
  const a = (await f.call(create("Archived A"))).task, b = (await f.call(create("Archived B"))).task;
  for (const task of [a, b]) await f.call({ action: "set-archive", id: task.id, archived: true, expectedArchiveRevision: 0, operationId: randomUUID() });
  const before = await f.list(), r = removal(before, "todo", "review");
  const replies = await Promise.all([fresh(f, r), fresh(f, r)]); assert.ok(replies.every(r => r.value)); assert.deepEqual(replies[0], replies[1]);
  const saved = await f.list(); assert.ok(saved.tasks.every(t => t.archived && t.archiveRevision === 1 && t.columnId === "review"));
  assert.equal(saved.orderRevision, before.orderRevision + 1); assert.equal(saved.columnsRevision, before.columnsRevision + 1);
  const bytes = await readFile(f.file); assert.deepEqual((await fresh(f, r)).value, saved); assert.deepEqual(await readFile(f.file), bytes);
});

test("default creation prefers existing todo despite reorder; deleted todo falls back to the first persisted unfinished custom column", async t => {
  const f = await fixture(t), b = await f.list(), custom = randomUUID();
  const columns = [{ id: "done", label: null }, { id: custom, label: "First unfinished" }, ...b.columns.filter(c => c.id !== "done").reverse().map(({ id, label }) => ({ id, label }))];
  await f.call({ action: "set-columns", expectedColumnsRevision: b.columnsRevision, columns });
  assert.equal((await f.call(create("Prefer todo"))).task.columnId, "todo");
  await f.call(removal(await f.list(), "todo", custom));
  assert.equal((await f.call(create("Prefer custom"))).task.columnId, custom);
});

test("snapshot guards reject new tasks, incoming moves, edits, archive changes, column changes and forged partial source sets", async t => {
  for (const change of ["create", "move", "outgoing", "reorder-source", "reorder-target", "edit", "archive", "columns", "partial", "subset", "digest-order", "digest-id", "digest-revision", "digest-archive", "digest-column"]) {
    const f = await fixture(t), a = (await f.call(create("A"))).task, other = (await f.call(create("Other"))).task;
    await f.call(await f.move(other.id, "review")); await f.call(create("Second source"));
    if (change === "reorder-target") { const target = (await f.call(create("Second target"))).task; await f.call(await f.move(target.id, "review")); }
    const b = await f.list(), r = removal(b, "todo", "review");
    if (change === "create") await f.call(create("New source"));
    if (change === "move") await f.call(await f.move(other.id, "todo"));
    if (change === "outgoing") await f.call(await f.move(a.id, "review"));
    if (change === "reorder-source") await f.call(await f.move(a.id, "todo"));
    if (change === "reorder-target") await f.call(await f.move(other.id, "review"));
    if (change === "edit") await f.call({ action: "edit", id: a.id, expectedRevision: a.revision, title: "Edited", description: "", completionCriteria: "", priority: 1, labels: [] });
    if (change === "archive") await f.call({ action: "set-archive", id: a.id, archived: true, expectedArchiveRevision: 0, operationId: randomUUID() });
    if (change === "columns") await f.call({ action: "set-columns", expectedColumnsRevision: b.columnsRevision, columns: [...b.columns].reverse().map(({ id, label }) => ({ id, label })) });
    if (change === "partial") r.expectedSourceDigest = taskColumnRemovalDigest([], "todo");
    if (change === "subset") r.expectedSourceDigest = taskColumnRemovalDigest(b.tasks.filter(task => task.id !== a.id), "todo");
    if (change === "digest-order") r.expectedSourceDigest = taskColumnRemovalDigest([...b.tasks].reverse(), "todo");
    if (change === "digest-column") r.expectedSourceDigest = b.columnRemovalDigests.review;
    if (change === "digest-id" || change === "digest-revision" || change === "digest-archive") {
      const partial = structuredClone(b.tasks); const task = partial.find(task => task.id === a.id);
      if (change === "digest-id") task.id = randomUUID();
      if (change === "digest-revision") task.revision++;
      if (change === "digest-archive") task.archiveRevision++;
      r.expectedSourceDigest = taskColumnRemovalDigest(partial, "todo");
    }
    const bytes = await readFile(f.file); await assert.rejects(f.call(r), { code: "conflict" }); assert.deepEqual(await readFile(f.file), bytes);
  }
});

test("independent knowledge after removal preview retains its latest history; digest and exact receipt do not rebase or roll it back", async t => {
  const f = await fixture(t), task = (await f.call(create("Knowledge source"))).task;
  const r = removal(await f.list(), "todo", "review");
  const published = await f.call({ action: "publish-context", id: task.id, operationId: randomUUID(), expectedCurrentVersionId: null, content: { goal: "Latest", decisions: "Keep", progress: "Reviewed", nextSteps: "Continue" } });
  assert.equal(published.board.columnRemovalDigests.todo, r.expectedSourceDigest);
  const saved = await f.call(r); assert.deepEqual(saved.tasks[0].sharedContext, published.task.sharedContext);
  await f.call({ action: "set-archive", id: task.id, archived: true, expectedArchiveRevision: 0, operationId: randomUUID() });
  const current = await f.list(), bytes = await readFile(f.file);
  assert.deepEqual(await f.call(r), current); assert.deepEqual(await readFile(f.file), bytes);
});

test("two fresh processes: delete/delete, delete/create and delete/incoming move serialize with no dangling tasks", async t => {
  for (const race of ["delete", "create", "move"]) {
    const f = await fixture(t), a = (await f.call(create("A"))).task, other = (await f.call(create("Other"))).task;
    await f.call(await f.move(other.id, "review")); let b = await f.list();
    // Reduce to two unfinished columns, so concurrent deletions cannot delete both.
    for (const id of ["blocked", "in-progress"]) b = await f.call(removal(b, id, "todo"));
    const r = removal(b, "todo", "review");
    const competitor = race === "delete" ? removal(b, "review", "todo") : race === "create" ? create("Concurrent") : await f.move(other.id, "todo");
    const replies = await Promise.all([fresh(f, r), fresh(f, competitor)]);
    b = await f.list(); assert.ok(b.columns.some(c => c.id !== "done")); assert.ok(b.tasks.every(task => b.columns.some(c => c.id === task.columnId)));
    assert.equal(new Set(b.tasks.map(t => t.id)).size, b.tasks.length); assert.ok(b.tasks.some(t => t.id === a.id));
    if (race === "delete") { assert.equal(replies.filter(r => r.value).length, 1); assert.equal(replies.find(r => r.code).code, "conflict"); }
    if (race === "create") { assert.ok(replies[1].value); assert.equal(b.tasks.length, 3); if (replies[0].value) assert.equal(replies[1].value.task.columnId, "review"); else assert.equal(replies[0].code, "conflict"); }
    if (race === "move") { assert.equal(replies.filter(r => r.value).length, 1); assert.ok(["conflict", "invalid-input"].includes(replies.find(r => r.code).code)); }
  }
});

test("real write/rename failures never half-commit; exact retry persists once and latest removal receipt survives fresh open", { skip: process.platform === "win32" ? "POSIX failure injection needs Windows ACL equivalent" : false }, async t => {
  const f = await fixture(t); await f.call(create("A")); const b = await f.list(), r = removal(b, "todo", "review"), bytes = await readFile(f.file);
  await chmod(join(f.agentDir, "tasks"), 0o500);
  try { await assert.rejects(f.call(r), { code: "storage-unavailable" }); assert.deepEqual(await readFile(f.file), bytes); }
  finally { await chmod(join(f.agentDir, "tasks"), 0o700); }
  // Real filesystem rename refusal after the synced temporary file has been written.
  assert.equal((await fresh(f, r, true)).code, "storage-unavailable");
  assert.deepEqual(await readFile(f.file), bytes);
  assert.equal((await readdir(join(f.agentDir, "tasks"))).some(name => name.endsWith(".tmp")), false);
  const saved = await f.call(r), stable = await readFile(f.file); assert.deepEqual((await fresh(f, r)).value, saved); assert.deepEqual(await readFile(f.file), stable);
  await f.call(removal(saved, "blocked", "review")); await assert.rejects(f.call(r), { code: "conflict" });
});

test("strict removal input, revision overflow and malformed receipt refuse without rewriting bytes", async t => {
  const f = await fixture(t); await f.call(create("A")); const b = await f.list(), r = removal(b, "todo", "review"), bytes = await readFile(f.file);
  for (const changes of [{ unexpected: true }, { operationId: "../bad" }, { expectedOrderRevision: -1 }, { expectedColumnsRevision: 0.5 }, { confirmCompletion: undefined }, { expectedSourceDigest: undefined }, { expectedSourceDigest: null }, { expectedSourceDigest: "0".repeat(63) }, { expectedSourceDigest: "G".repeat(64) }, { expectedSourceDigest: "0".repeat(64) + "\n" }, { expectedSourceDigest: Array(1) }, { expectedTasks: [] }]) { await assert.rejects(f.call({ ...r, ...changes }), { code: "invalid-input" }); assert.deepEqual(await readFile(f.file), bytes); }
  const good = JSON.parse(bytes);
  for (const mutate of [d => { d.columnsRevision = Number.MAX_SAFE_INTEGER; }, d => { d.orderRevision = Number.MAX_SAFE_INTEGER; }, d => { d.tasks[0].revision = Number.MAX_SAFE_INTEGER; }]) {
    const d = structuredClone(good); mutate(d); await writeFile(f.file, JSON.stringify(d)); const current = await f.list(), before = await readFile(f.file);
    await assert.rejects(f.call(removal(current, "todo", "review")), { code: "storage-unavailable" }); assert.deepEqual(await readFile(f.file), before);
  }
  for (const receipt of [null, {}, { operationId: randomUUID(), fingerprint: "bad" }]) { await writeFile(f.file, JSON.stringify({ ...good, columnRemovalReceipt: receipt })); const before = await readFile(f.file); await assert.rejects(f.list(), { code: "storage-unavailable" }); assert.deepEqual(await readFile(f.file), before); }
});
