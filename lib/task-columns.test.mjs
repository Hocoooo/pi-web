import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const { taskOperation } = await createJiti(import.meta.url).import("./task-operations.ts");
const create = (cwd = null) => ({ action: "create", id: randomUUID(), title: "Original", description: "Text", completionCriteria: "User confirms", cwd });
const config = (board, columns = board.columns) => ({ action: "set-columns", expectedColumnsRevision: board.columnsRevision, columns: columns.map(({ id, label }) => ({ id, label })) });
const move = (board, id, columnId) => ({ action: "move", id, columnId, expectedRevision: board.tasks.find((task) => task.id === id).revision, expectedOrderRevision: board.orderRevision, operationId: randomUUID(), position: { edge: "end" } });
async function fixture(t) {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-web-task-columns-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const options = { agentDir }, file = path.join(agentDir, "tasks", "board.json");
  const list = () => taskOperation({ action: "list" }, options);
  return { options, file, list };
}
function fresh(input, options) {
  const script = `import {createJiti} from 'jiti';const {taskOperation}=await createJiti(import.meta.url).import('./lib/task-operations.ts');try{console.log(JSON.stringify({value:await taskOperation(JSON.parse(process.argv[1]),{agentDir:process.argv[2]})}));}catch(e){console.log(JSON.stringify({code:e.code}));}`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(input), options.agentDir], { cwd: process.cwd(), env: process.env });
    let output = "", errors = "";
    child.stdout.on("data", (data) => output += data); child.stderr.on("data", (data) => errors += data);
    child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(errors)));
  });
}

test("global rename/add/reorder persists across processes without altering task state or original creation identity", async (t) => {
  const f = await fixture(t); const project = path.join(f.options.agentDir, "project"); await mkdir(project);
  const inputs = [create(), create(project)];
  for (const input of inputs) await taskOperation(input, f.options);
  let board = await f.list(); board = (await taskOperation(move(board, inputs[0].id, "done"), f.options)).board;
  const original = JSON.parse(await readFile(f.file, "utf8"));
  const extra = { id: randomUUID(), label: "已完成" };
  const columns = [board.columns[4], extra, ...board.columns.slice(0, 4)].map((column) => column.id === "done" ? { ...column, label: "Needs more work" } : column);
  const saved = await taskOperation(config(board, columns), f.options);
  assert.equal(saved.columnsRevision, 1); assert.equal(saved.orderRevision, board.orderRevision);
  assert.deepEqual(saved.tasks, board.tasks);
  assert.deepEqual(saved.columns.filter((column) => column.isCompletion).map((column) => column.id), ["done"]);
  assert.equal(saved.columns.find((column) => column.id === extra.id).isCompletion, false);
  assert.deepEqual((await fresh({ action: "list" }, f.options)).value, saved);
  const persisted = JSON.parse(await readFile(f.file, "utf8")); assert.deepEqual(persisted.tasks, original.tasks);
  for (const input of inputs) assert.deepEqual((await taskOperation(input, f.options)).task, saved.tasks.find((task) => task.id === input.id));
  const moved = await taskOperation(move(saved, inputs[1].id, extra.id), f.options);
  assert.equal(moved.task.columnId, extra.id); assert.equal(moved.board.columns.find((column) => column.id === moved.task.columnId).isCompletion, false);
  assert.equal((await taskOperation(create(), f.options)).task.columnId, "todo");
});

test("initialization and locked v1/v2 migration occur once and preserve 02 fields, 03 order and receipts", async (t) => {
  for (const version of [1, 2]) {
    const f = await fixture(t); const input = create(); await taskOperation(input, f.options);
    let board = await f.list();
    await taskOperation({ action: "edit", id: input.id, expectedRevision: 1, title: "Edited", description: "Changed", completionCriteria: "Kept", priority: 3, labels: ["tag"] }, f.options);
    board = await f.list(); const request = move(board, input.id, "done"); await taskOperation(request, f.options);
    const legacy = JSON.parse(await readFile(f.file, "utf8")); legacy.version = version; delete legacy.sessionRelations; delete legacy.columns; delete legacy.columnsRevision;
    if (version === 1) delete legacy.orderRevision;
    await writeFile(f.file, JSON.stringify(legacy));
    const readers = await Promise.all(Array.from({ length: 3 }, () => fresh({ action: "list" }, f.options)));
    for (const reader of readers) assert.deepEqual(reader.value, readers[0].value);
    const persisted = JSON.parse(await readFile(f.file, "utf8")); assert.equal(persisted.version, 7);
    assert.equal(persisted.columns.length, 5); assert.equal(persisted.columnsRevision, 0);
    assert.equal(persisted.orderRevision, version === 1 ? 0 : legacy.orderRevision);
    assert.deepEqual(persisted.tasks, legacy.tasks);
    const bytes = await readFile(f.file, "utf8");
    assert.deepEqual((await fresh(input, f.options)).value.task, readers[0].value.tasks[0]);
    assert.deepEqual((await fresh(request, f.options)).value.board, readers[0].value);
    assert.equal(await readFile(f.file, "utf8"), bytes);
  }
  const f = await fixture(t);
  const readers = await Promise.all(Array.from({ length: 4 }, () => fresh({ action: "list" }, f.options)));
  for (const reader of readers) assert.equal(reader.value.columns.length, 5);
  const board = readers[0].value;
  const saved = await taskOperation(config(board, [...board.columns, { id: randomUUID(), label: "Extra" }]), f.options);
  for (let i = 0; i < 3; i++) assert.deepEqual((await fresh({ action: "list" }, f.options)).value, saved);
});

test("legacy missing 01 metadata hydrates before column migration and original create retry", async (t) => {
  const f = await fixture(t); const input = create(); const task = (await taskOperation(input, f.options)).task;
  const legacy = { version: 1, tasks: [{ ...task }] };
  for (const key of ["priority", "labels"]) delete legacy.tasks[0][key];
  await writeFile(f.file, JSON.stringify(legacy));
  const board = await f.list(); assert.equal(board.tasks[0].priority, 1); assert.deepEqual(board.tasks[0].labels, []);
  assert.deepEqual((await taskOperation(input, f.options)).task, task);
  assert.equal(board.tasks[0].revision, task.revision); assert.equal(board.tasks[0].updatedAt, task.updatedAt);
});

test("06 v2 history migrates intact; column settings, knowledge and exact receipts never roll back authority", async (t) => {
  const f = await fixture(t), input = create();
  await taskOperation(input, f.options);
  const publish = (base, goal) => ({ action: "publish-context", id: input.id, expectedCurrentVersionId: base,
    operationId: randomUUID(), content: { goal, decisions: "Manual", progress: "Reviewed", nextSteps: "Continue" } });
  const firstRequest = publish(null, "First knowledge");
  const first = await taskOperation(firstRequest, f.options);
  const secondRequest = publish(first.task.sharedContext.currentVersionId, "Middle knowledge");
  const second = await taskOperation(secondRequest, f.options);
  const restoreRequest = { action: "restore-context", id: input.id, operationId: randomUUID(),
    expectedCurrentVersionId: second.task.sharedContext.currentVersionId, versionId: first.task.sharedContext.currentVersionId };
  await taskOperation(restoreRequest, f.options);
  const oldMove = move(await f.list(), input.id, "done"); await taskOperation(oldMove, f.options);
  const legacy = JSON.parse(await readFile(f.file, "utf8"));
  legacy.version = 2; delete legacy.sessionRelations; delete legacy.columns; delete legacy.columnsRevision;
  assert.equal(legacy.tasks[0].sharedContext.versions.length, 3);
  assert.ok(legacy.tasks[0].sharedContext.versions.every((version) => version.receipt));
  await writeFile(f.file, JSON.stringify(legacy));
  const readers = await Promise.all(Array.from({ length: 3 }, () => fresh({ action: "list" }, f.options)));
  for (const reader of readers) assert.deepEqual(reader.value, readers[0].value);
  const migrated = JSON.parse(await readFile(f.file, "utf8"));
  assert.equal(migrated.version, 7); assert.equal(migrated.columns.length, 5); assert.equal(migrated.columnsRevision, 0);
  assert.equal(migrated.orderRevision, legacy.orderRevision); assert.deepEqual(migrated.tasks, legacy.tasks);
  let board = readers[0].value;
  const custom = { id: randomUUID(), label: "Done" };
  board = await taskOperation(config(board, [custom, ...board.columns].map((column) => column.id === "done" ? { ...column, label: "Pending" } : column)), f.options);
  assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")).tasks, legacy.tasks);
  const thirdRequest = publish(board.tasks[0].sharedContext.currentVersionId, "Knowledge after columns");
  const published = await taskOperation(thirdRequest, f.options);
  assert.equal(published.board.columnsRevision, board.columnsRevision);
  assert.equal(published.board.orderRevision, board.orderRevision); assert.equal(published.task.revision, board.tasks[0].revision);
  const stableBytes = await readFile(f.file, "utf8");
  for (const request of [input, oldMove, firstRequest, secondRequest, restoreRequest, thirdRequest]) {
    const reply = (await fresh(request, f.options)).value;
    assert.deepEqual(reply.board, published.board); assert.deepEqual(reply.task, published.task);
    assert.equal(await readFile(f.file, "utf8"), stableBytes);
  }
  // The new unfinished column works with both editors and moves; independent domains retain authority.
  const newMove = move(published.board, input.id, custom.id);
  const moved = await taskOperation(newMove, f.options);
  const edit = { action: "edit", id: input.id, expectedRevision: moved.task.revision,
    title: "Custom-column details", description: "Edited", completionCriteria: "Confirm", priority: 3, labels: ["custom"] };
  const edited = await taskOperation(edit, f.options);
  const newPublish = publish(edited.task.sharedContext.currentVersionId, "Custom-column knowledge");
  const final = await taskOperation(newPublish, f.options);
  assert.equal(final.task.columnId, custom.id); assert.equal(final.task.title, edit.title);
  assert.equal(final.task.revision, edited.task.revision); assert.equal(final.board.orderRevision, moved.board.orderRevision);
  assert.equal(final.board.columnsRevision, board.columnsRevision); assert.equal(final.task.sharedContext.versions.length, 5);
  assert.deepEqual(final.task.sharedContext.versions.slice(0, 4), published.task.sharedContext.versions);
  assert.equal(final.board.columns.find((column) => column.id === custom.id).isCompletion, false);
  assert.equal(final.board.columns.find((column) => column.id === "done").isCompletion, true);
  const finalBytes = await readFile(f.file, "utf8");
  for (const request of [input, newMove, firstRequest, newPublish]) {
    assert.deepEqual((await fresh(request, f.options)).value.board, final.board);
    assert.equal(await readFile(f.file, "utf8"), finalBytes);
  }
  const stored = JSON.parse(finalBytes).tasks[0];
  assert.equal(stored.creationFingerprint, legacy.tasks[0].creationFingerprint);
  assert.equal(stored.moveReceipt.operationId, newMove.operationId);
  assert.deepEqual(stored.sharedContext.versions.slice(0, 3), legacy.tasks[0].sharedContext.versions);
  assert.deepEqual((await fresh({ action: "list" }, f.options)).value, final.board);
});

test("06 invalid legacy knowledge is rejected during v1/v2 column migration without resetting bytes", async (t) => {
  const f = await fixture(t); await taskOperation(create(), f.options);
  const good = JSON.parse(await readFile(f.file, "utf8"));
  for (const version of [1, 2]) for (const sharedContext of [null, {}, { currentVersionId: randomUUID(), versions: [] }]) {
    const legacy = { version, ...(version === 2 ? { orderRevision: good.orderRevision } : {}), tasks: [{ ...good.tasks[0], sharedContext }] };
    const bytes = JSON.stringify(legacy); await writeFile(f.file, bytes);
    assert.equal((await fresh({ action: "list" }, f.options)).code, "storage-unavailable");
    assert.equal(await readFile(f.file, "utf8"), bytes);
  }
});

test("two-process column competition and stale no-op conflict without silent overwrite", async (t) => {
  const f = await fixture(t); const board = await f.list();
  const requests = ["A", "B"].map((label) => config(board, board.columns.map((column) => ({ ...column, label }))));
  const results = await Promise.all(requests.map((request) => fresh(request, f.options)));
  assert.equal(results.filter((result) => result.value).length, 1); assert.equal(results.find((result) => result.code).code, "conflict");
  const saved = await f.list(); assert.equal(saved.columnsRevision, 1);
  const bytes = await readFile(f.file, "utf8");
  await assert.rejects(taskOperation({ ...config(saved), expectedColumnsRevision: 0 }, f.options), { code: "conflict" });
  assert.deepEqual(await taskOperation(config(saved), f.options), saved); assert.equal(await readFile(f.file, "utf8"), bytes);
});

test("column edits and 03 moves use independent revisions; exact receipt and stale task-order guards survive", async (t) => {
  const f = await fixture(t); const input = create(); await taskOperation(input, f.options); const initial = await f.list();
  const request = move(initial, input.id, "done");
  const settings = config(initial, [...initial.columns].reverse());
  const results = await Promise.all([fresh(request, f.options), fresh(settings, f.options)]);
  assert.ok(results.every((result) => result.value));
  const board = await f.list(); assert.equal(board.columnsRevision, 1); assert.equal(board.orderRevision, initial.orderRevision + 1);
  assert.deepEqual((await fresh(request, f.options)).value.board, board);
  await assert.rejects(taskOperation({ ...request, operationId: randomUUID() }, f.options), { code: "conflict" });
  const edit = { action: "edit", id: input.id, expectedRevision: board.tasks[0].revision, title: "Edited", description: "Changed", completionCriteria: "Kept", priority: 2, labels: ["x"] };
  await taskOperation(edit, f.options);
  assert.equal((await f.list()).columnsRevision, board.columnsRevision);
});

test("strict column validation rejects forged completion, deletion, invalid names/IDs, duplicate/sparse configs and overflows", async (t) => {
  const f = await fixture(t); const board = await f.list(); const base = config(board);
  const extra = { id: randomUUID(), label: "Extra" }; const bytes = await readFile(f.file, "utf8");
  for (const change of [
    { columns: [...base.columns, { ...extra, isCompletion: true }] },
    { columns: base.columns.map((column) => ({ ...column, isCompletion: column.id === "todo" })) },
    { columns: base.columns.slice(1) }, { columns: base.columns.slice(0, 4) }, { columns: [base.columns[4]] },
    { columns: [...base.columns, { ...extra, label: " " }] }, { columns: [...base.columns, { ...extra, label: "a\nb" }] },
    { columns: [...base.columns, { ...extra, label: "x".repeat(101) }] }, { columns: [...base.columns, { ...extra, label: null }] },
    { columns: [...base.columns, { ...extra, id: "../../sessions" }] }, { columns: [...base.columns, { ...extra, id: "other" }] },
    { columns: [...base.columns, base.columns[0]] }, { columns: Array(5) }, { columns: null },
    { columns: [...base.columns, ...Array.from({ length: 96 }, () => ({ id: randomUUID(), label: "X" }))] },
    { expectedColumnsRevision: -1 }, { expectedColumnsRevision: 1.5 }, { expectedColumnsRevision: undefined }, { projectKey: "project" },
  ]) { await assert.rejects(taskOperation({ ...base, ...change }, f.options), { code: "invalid-input" }); assert.equal(await readFile(f.file, "utf8"), bytes); }
  const saved = await taskOperation(config(board, [...base.columns, extra]), f.options);
  await assert.rejects(taskOperation(config(saved, base.columns), f.options), { code: "invalid-input" });
  const document = JSON.parse(await readFile(f.file, "utf8")); document.columnsRevision = Number.MAX_SAFE_INTEGER;
  await writeFile(f.file, JSON.stringify(document)); const full = await f.list(); const before = await readFile(f.file, "utf8");
  await assert.rejects(taskOperation(config(full, [...full.columns].reverse()), f.options), { code: "storage-unavailable" });
  assert.equal(await readFile(f.file, "utf8"), before);
});

test("v3 corruption is refused without reset, default duplication or dangling task references", async (t) => {
  const f = await fixture(t); await taskOperation(create(), f.options); const good = JSON.parse(await readFile(f.file, "utf8"));
  for (const change of [
    { columns: undefined }, { columnsRevision: undefined }, { columnsRevision: -1 }, { columnsRevision: null },
    { columns: good.columns.slice(1) }, { columns: [...good.columns, { id: randomUUID(), label: "Other", isCompletion: true }] },
    { columns: [...good.columns, good.columns[0]] }, { tasks: [{ ...good.tasks[0], columnId: randomUUID() }] },
    { columns: good.columns.map((column) => ({ ...column, label: " " })) }, { columns: null },
  ]) {
    const bytes = JSON.stringify({ ...good, ...change }); await writeFile(f.file, bytes);
    await assert.rejects(f.list(), { code: "storage-unavailable" }); assert.equal(await readFile(f.file, "utf8"), bytes);
  }
  await writeFile(f.file, JSON.stringify(good)); assert.equal((await f.list()).tasks.length, 1);
});

test("syntactically valid but nonexistent column move is rejected by locked server configuration", async (t) => {
  const f = await fixture(t); const input = create(); await taskOperation(input, f.options); const board = await f.list(); const bytes = await readFile(f.file, "utf8");
  await assert.rejects(taskOperation(move(board, input.id, randomUUID()), f.options), { code: "invalid-input" });
  assert.equal(await readFile(f.file, "utf8"), bytes);
});

test("real POSIX write failure retains saved settings and tasks; retry saves draft once", { skip: process.platform === "win32" ? "POSIX chmod fixture; Windows ACL requires Windows" : false }, async (t) => {
  const f = await fixture(t); await taskOperation(create(), f.options); const board = await f.list(); const bytes = await readFile(f.file, "utf8");
  const request = config(board, [...board.columns].reverse());
  await chmod(path.dirname(f.file), 0o500);
  try { await assert.rejects(taskOperation(request, f.options), { code: "storage-unavailable" }); assert.equal(await readFile(f.file, "utf8"), bytes); }
  finally { await chmod(path.dirname(f.file), 0o700); }
  assert.deepEqual(await f.list(), board);
  const saved = await taskOperation(request, f.options); assert.equal(saved.columnsRevision, 1); assert.deepEqual(saved.tasks, board.tasks);
  assert.deepEqual((await fresh({ action: "list" }, f.options)).value, saved);
});
