import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, chmod } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { taskOperation } = await jiti.import("./task-operations.ts");
const create = (title) => ({ action: "create", id: randomUUID(), title, description: "Original", completionCriteria: "User confirms", cwd: null });
async function fixture(t) {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-web-task-order-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const options = { agentDir };
  const inputs = ["A", "hidden", "B", "C"].map(create);
  for (const input of inputs) await taskOperation(input, options);
  const list = () => taskOperation({ action: "list" }, options);
  return { options, inputs, list, file: path.join(agentDir, "tasks", "board.json") };
}
const ids = (board, column = "todo") => board.tasks.filter((task) => task.columnId === column).map((task) => task.title);
function move(board, id, columnId, position) {
  return { action: "move", id, columnId, position, expectedRevision: board.tasks.find((task) => task.id === id)?.revision ?? 1,
    expectedOrderRevision: board.orderRevision, operationId: randomUUID() };
}
function fresh(input, options) {
  const script = `import {createJiti} from 'jiti'; const {taskOperation}=await createJiti(import.meta.url).import('./lib/task-operations.ts'); try {console.log(JSON.stringify({value:await taskOperation(JSON.parse(process.argv[1]),{agentDir:process.argv[2]})}));} catch(e) {console.log(JSON.stringify({code:e.code}));}`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(input), options.agentDir], { cwd: process.cwd(), env: process.env });
    let output = "", errors = "";
    child.stdout.on("data", (data) => output += data); child.stderr.on("data", (data) => errors += data);
    child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(errors)));
  });
}

test("single-neighbor moves preserve unseen tasks and persist deterministic column and status order", async (t) => {
  const f = await fixture(t); const [a, hidden, b, c] = f.inputs;
  const initial = await f.list(); const hiddenRecord = initial.tasks.find((task) => task.id === hidden.id);
  const first = await taskOperation(move(initial, c.id, "todo", { before: b.id }), f.options);
  assert.deepEqual(ids(first.board), ["A", "hidden", "C", "B"]);
  assert.deepEqual(first.board.tasks.find((task) => task.id === hidden.id), hiddenRecord);
  assert.equal(first.board.orderRevision, initial.orderRevision + 1);
  assert.equal(first.task.revision, 2);
  assert.deepEqual(await f.list(), first.board);
  const second = await taskOperation(move(first.board, b.id, "done", { edge: "start" }), f.options);
  assert.deepEqual(ids(second.board), ["A", "hidden", "C"]); assert.deepEqual(ids(second.board, "done"), ["B"]);
  const third = await taskOperation(move(second.board, a.id, "done", { after: b.id }), f.options);
  assert.deepEqual(ids(third.board, "done"), ["B", "A"]);
  assert.deepEqual((await fresh({ action: "list" }, f.options)).value, third.board);
  assert.equal(new Set(third.board.tasks.map((task) => task.id)).size, 4);
  for (const task of third.board.tasks) { assert.equal("moveReceipt" in task, false); assert.equal("creationFingerprint" in task, false); }
});

test("hundreds of consecutive insertions never use floating ranks or lose/duplicate records", async (t) => {
  const f = await fixture(t); let board = await f.list();
  for (let i = 0; i < 160; i++) {
    const last = board.tasks.filter((task) => task.columnId === "todo").at(-1);
    const first = board.tasks.find((task) => task.columnId === "todo");
    board = (await taskOperation(move(board, last.id, "todo", { before: first.id }), f.options)).board;
    assert.equal(board.tasks.length, 4); assert.equal(new Set(board.tasks.map((task) => task.id)).size, 4);
  }
  assert.deepEqual(ids(board), ["A", "hidden", "B", "C"]);
  assert.equal(board.orderRevision, 164);
  assert.deepEqual((await fresh({ action: "list" }, f.options)).value, board);
});

test("exact lost-response retry survives process reopen, rejects different same-column reorder identities", async (t) => {
  const f = await fixture(t); const board = await f.list(); const [a, , b, c] = f.inputs;
  const request = move(board, c.id, "todo", { before: a.id });
  const committed = await taskOperation(request, f.options); const saved = await readFile(f.file, "utf8");
  assert.deepEqual((await fresh(request, f.options)).value, committed);
  assert.equal(await readFile(f.file, "utf8"), saved);
  for (const different of [{ ...request, position: { after: b.id } }, { ...request, operationId: randomUUID() }, { ...request, expectedOrderRevision: board.orderRevision + 1 }]) {
    await assert.rejects(taskOperation(different, f.options), { code: "conflict" });
    assert.equal(await readFile(f.file, "utf8"), saved);
  }
  // An unrelated move can happen later: exact known receipt confirms without executing again.
  const later = await taskOperation(move(committed.board, b.id, "review", { edge: "end" }), f.options);
  assert.deepEqual((await fresh(request, f.options)).value.board, later.board);
  // Once a newer move for the same task replaces the receipt, an older retry safely conflicts.
  await taskOperation(move(later.board, c.id, "blocked", { edge: "end" }), f.options);
  await assert.rejects(taskOperation(request, f.options), { code: "conflict" });
});

test("no-op stores an exact receipt but preserves logical order, task revision and timestamp", async (t) => {
  const f = await fixture(t); const board = await f.list(); const request = move(board, f.inputs[0].id, "todo", { edge: "start" });
  const result = await taskOperation(request, f.options);
  assert.deepEqual(result.board, board); assert.deepEqual(result.task, board.tasks[0]);
  const saved = await readFile(f.file, "utf8");
  assert.deepEqual((await fresh(request, f.options)).value, result); assert.equal(await readFile(f.file, "utf8"), saved);
  await assert.rejects(taskOperation({ ...request, position: { edge: "end" } }, f.options), { code: "conflict" });
});

test("invalid anchors, revisions and visible-array replacement are refused without changing bytes", async (t) => {
  const f = await fixture(t); const board = await f.list(); const id = f.inputs[0].id;
  const request = move(board, id, "todo", { edge: "end" }); const saved = await readFile(f.file, "utf8");
  for (const change of [
    { position: { before: id } }, { position: { after: randomUUID() } }, { columnId: "done", position: { before: f.inputs[1].id } },
    { position: {} }, { position: { edge: "middle" } }, { position: { before: f.inputs[1].id, after: f.inputs[2].id } },
    { position: { before: "../../sessions" } }, { position: null }, { position: [] }, { tasks: [id] },
    { expectedOrderRevision: -1 }, { expectedOrderRevision: 1.5 }, { expectedOrderRevision: undefined },
    { operationId: "../../sessions" }, { operationId: undefined }, { columnId: "new-column" },
  ]) { await assert.rejects(taskOperation({ ...request, ...change }, f.options), { code: "invalid-input" }); assert.equal(await readFile(f.file, "utf8"), saved); }
  await assert.rejects(taskOperation({ ...request, expectedOrderRevision: board.orderRevision - 1 }, f.options), { code: "conflict" });
  await assert.rejects(taskOperation({ ...request, id: randomUUID() }, f.options), { code: "not-found" });
  assert.deepEqual(await f.list(), board);
});

test("global order guard rejects two-process neighbor/status competition even for different tasks", async (t) => {
  const f = await fixture(t); const board = await f.list();
  const requests = [move(board, f.inputs[0].id, "done", { edge: "end" }), move(board, f.inputs[3].id, "todo", { edge: "start" })];
  const results = await Promise.all(requests.map((request) => fresh(request, f.options)));
  assert.equal(results.filter((result) => result.value).length, 1); assert.equal(results.find((result) => result.code).code, "conflict");
  const saved = await f.list(); assert.equal(saved.orderRevision, board.orderRevision + 1); assert.equal(saved.tasks.length, 4);
  const win = results.findIndex((result) => result.value);
  assert.deepEqual((await fresh(requests[win], f.options)).value.board, saved);
  assert.deepEqual((await fresh(requests[1 - win], f.options)).code, "conflict");
  // Creating a new neighbor invalidates a previously prepared position too.
  const stale = move(saved, f.inputs[1].id, "review", { edge: "end" });
  await taskOperation(create("new neighbor"), f.options);
  await assert.rejects(taskOperation(stale, f.options), { code: "conflict" });
});

test("explicit v1 migration preserves array, 02 fields and immutable create fingerprint", async (t) => {
  const f = await fixture(t); const board = await f.list(); const first = board.tasks[0];
  const edited = (await taskOperation({ action: "edit", id: first.id, expectedRevision: first.revision, title: "Edited", description: "Changed", completionCriteria: "Updated", priority: 3, labels: ["kept"] }, f.options)).task;
  const v1 = JSON.parse(await readFile(f.file, "utf8")); v1.version = 1; delete v1.sessionRelations; delete v1.orderRevision; v1.tasks.reverse();
  const identity = v1.tasks.find((task) => task.id === first.id).creationFingerprint;
  await writeFile(f.file, JSON.stringify(v1));
  const migrationReaders = await Promise.all(Array.from({ length: 3 }, () => fresh({ action: "list" }, f.options)));
  const migrated = migrationReaders[0].value;
  for (const reader of migrationReaders) assert.deepEqual(reader.value, migrated);
  assert.equal(migrated.orderRevision, 0); assert.deepEqual(migrated.tasks.map((task) => task.id), v1.tasks.map((task) => task.id));
  assert.deepEqual(migrated.tasks.find((task) => task.id === first.id), edited);
  const persisted = JSON.parse(await readFile(f.file, "utf8")); assert.equal(persisted.version, 7);
  assert.equal(persisted.tasks.find((task) => task.id === first.id).creationFingerprint, identity);
  assert.deepEqual((await fresh(f.inputs[0], f.options)).value.task, edited);
  const saved = await readFile(f.file, "utf8");
  for (const bad of [{ ...persisted, orderRevision: null }, { ...persisted, orderRevision: -1 }, { ...persisted, version: 99 }, { ...persisted, tasks: [{ ...persisted.tasks[0], moveReceipt: { operationId: "bad", fingerprint: identity } }] }]) {
    const text = JSON.stringify(bad); await writeFile(f.file, text);
    await assert.rejects(f.list(), { code: bad.version === 99 ? "unsupported-version" : "storage-unavailable" });
    assert.equal(await readFile(f.file, "utf8"), text);
  }
  await writeFile(f.file, saved); assert.deepEqual(await f.list(), migrated);
});

test("safe-integer revision limits refuse new changes instead of degrading precision", async (t) => {
  const f = await fixture(t); const document = JSON.parse(await readFile(f.file, "utf8"));
  document.orderRevision = Number.MAX_SAFE_INTEGER; await writeFile(f.file, JSON.stringify(document));
  let board = await f.list(); let bytes = await readFile(f.file, "utf8");
  await assert.rejects(taskOperation(move(board, f.inputs[0].id, "done", { edge: "end" }), f.options), { code: "storage-unavailable" });
  await assert.rejects(taskOperation(create("overflow"), f.options), { code: "storage-unavailable" });
  assert.equal(await readFile(f.file, "utf8"), bytes);
  document.orderRevision = 4; document.tasks[0].revision = Number.MAX_SAFE_INTEGER;
  await writeFile(f.file, JSON.stringify(document)); board = await f.list(); bytes = await readFile(f.file, "utf8");
  await assert.rejects(taskOperation(move(board, f.inputs[0].id, "done", { edge: "end" }), f.options), { code: "storage-unavailable" });
  const task = board.tasks[0];
  await assert.rejects(taskOperation({ action: "edit", id: task.id, expectedRevision: task.revision, title: "overflow", description: task.description, completionCriteria: task.completionCriteria, priority: task.priority, labels: task.labels }, f.options), { code: "storage-unavailable" });
  assert.equal(await readFile(f.file, "utf8"), bytes);
});

test("real filesystem failure does not persist status, order or receipt; exact retry recovers", { skip: process.platform === "win32" ? "POSIX chmod fixture; Windows ACL requires Windows" : false }, async (t) => {
  const f = await fixture(t); const board = await f.list(); const request = move(board, f.inputs[0].id, "done", { edge: "end" });
  const saved = await readFile(f.file, "utf8"); await chmod(path.dirname(f.file), 0o500);
  try { await assert.rejects(taskOperation(request, f.options), { code: "storage-unavailable" }); assert.equal(await readFile(f.file, "utf8"), saved); }
  finally { await chmod(path.dirname(f.file), 0o700); }
  assert.deepEqual(await f.list(), board);
  const result = await taskOperation(request, f.options); assert.equal(result.task.columnId, "done");
  assert.deepEqual((await fresh(request, f.options)).value, result);
});
