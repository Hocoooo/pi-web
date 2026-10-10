import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { moveRequest } from "./task-test-helpers.mjs";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { taskOperation } = await jiti.import("./task-operations.ts");
const { compareTaskPriority } = await jiti.import("./task-types.ts");
const create = (extra = {}) => ({ action: "create", id: randomUUID(), title: "Original", description: "Original description", completionCriteria: "Original criteria", cwd: null, ...extra });
const edit = (task, extra = {}) => ({ action: "edit", id: task.id, expectedRevision: task.revision, title: task.title, description: task.description, completionCriteria: task.completionCriteria, priority: task.priority, labels: task.labels, ...extra });
async function workspace(t) {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-web-task-details-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  return { agentDir };
}
function fresh(input, options) {
  const script = `import {createJiti} from 'jiti'; const jiti=createJiti(import.meta.url); const {taskOperation}=await jiti.import('./lib/task-operations.ts'); console.log(JSON.stringify(await taskOperation(JSON.parse(process.argv[1]),{agentDir:process.argv[2]})));`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(input), options.agentDir], { cwd: process.cwd(), env: process.env });
    let output = "", error = "";
    child.stdout.on("data", (data) => { output += data; }); child.stderr.on("data", (data) => { error += data; });
    child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(error)));
  });
}

test("edit persists every detail and timestamp across fresh processes without changing project or state", async (t) => {
  const options = await workspace(t);
  const cwd = path.join(options.agentDir, "fixture-project"); await mkdir(cwd);
  const original = (await taskOperation(create({ cwd }), options)).task;
  assert.equal(original.priority, 1); assert.deepEqual(original.labels, []);
  const moved = (await taskOperation(await moveRequest({ action: "move", id: original.id, expectedRevision: 1, columnId: "done" }, options), options)).task;
  const result = (await taskOperation(edit(moved, { title: "  Updated  ", description: "<img src=x onerror=alert(1)> **text**", completionCriteria: "user confirms", priority: 3, labels: [" bug ", "bug", "Bug", "a,b"] }), options)).task;
  assert.equal(result.title, "Updated"); assert.equal(result.priority, 3); assert.deepEqual(result.labels, ["bug", "Bug", "a,b"]);
  assert.equal(result.description, "<img src=x onerror=alert(1)> **text**"); assert.equal(result.completionCriteria, "user confirms");
  assert.equal(result.revision, 3); assert.equal(result.createdAt, original.createdAt);
  assert.ok(Date.parse(result.updatedAt) > Date.parse(moved.updatedAt));
  assert.deepEqual(result.project, original.project); assert.equal(result.columnId, "done");
  assert.deepEqual((await fresh({ action: "list" }, options)).tasks, [result]);
  assert.deepEqual((await fresh(edit(result, { labels: [], priority: 0 }), options)).task.labels, []);
  assert.deepEqual((await readdir(options.agentDir)).sort(), ["fixture-project", "tasks"]);
});

test("priority has numeric ordered values and deterministic creation/UUID ties", async (t) => {
  const options = await workspace(t);
  const sample = (await taskOperation(create(), options)).task;
  const idA = "00000000-0000-0000-0000-000000000001", idB = "00000000-0000-0000-0000-000000000002";
  const tasks = [
    { ...sample, id: idB, priority: 1, createdAt: "2026-01-02T00:00:00.000Z" },
    { ...sample, id: idA, priority: 0 },
    { ...sample, id: idB, priority: 3 },
    { ...sample, id: idA, priority: 1, createdAt: "2026-01-01T00:00:00.000Z" },
    { ...sample, id: idB, priority: 1, createdAt: "2026-01-01T00:00:00.000Z" },
    { ...sample, id: idA, priority: 2 },
  ];
  assert.deepEqual([...tasks].sort(compareTaskPriority), [tasks[2], tasks[5], tasks[3], tasks[4], tasks[0], tasks[1]]);
  assert.equal(compareTaskPriority(sample, sample), 0);
});

test("same-revision no-op preserves revision/time/file; stale identical edits still conflict", async (t) => {
  const options = await workspace(t);
  const task = (await taskOperation(create(), options)).task;
  const file = path.join(options.agentDir, "tasks", "board.json"); const saved = await readFile(file, "utf8");
  assert.deepEqual((await taskOperation(edit(task), options)).task, task);
  assert.equal(await readFile(file, "utf8"), saved);
  const updated = (await taskOperation(edit(task, { priority: 2 }), options)).task;
  await assert.rejects(taskOperation(edit(updated, { expectedRevision: 1 }), options), { code: "conflict" });
  assert.deepEqual((await taskOperation({ action: "list" }, options)).tasks, [updated]);
});

test("concurrent edits and moves reject silent overwrites, including from fresh processes", async (t) => {
  const options = await workspace(t);
  const task = (await taskOperation(create(), options)).task;
  const results = await Promise.allSettled([fresh(edit(task, { labels: ["one"] }), options), fresh(edit(task, { labels: ["two"] }), options)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const winner = results.find((r) => r.status === "fulfilled").value.task;
  assert.deepEqual((await taskOperation({ action: "list" }, options)).tasks, [winner]);
  await assert.rejects(taskOperation(edit(task, { title: "stale" }), options), { code: "conflict" });
  const moved = (await taskOperation(await moveRequest({ action: "move", id: task.id, columnId: "blocked", expectedRevision: winner.revision }, options), options)).task;
  await assert.rejects(taskOperation(edit(winner, { priority: 3 }), options), { code: "conflict" });
  assert.deepEqual((await taskOperation({ action: "list" }, options)).tasks, [moved]);
});

test("strict detail validation rejects invalid values and forbidden state/project fields without writes", async (t) => {
  const options = await workspace(t);
  const task = (await taskOperation(create(), options)).task;
  const file = path.join(options.agentDir, "tasks", "board.json"); const saved = await readFile(file, "utf8");
  for (const change of [
    { title: " " }, { title: "x".repeat(201) }, { description: null }, { description: "x".repeat(20001) }, { completionCriteria: [] }, { completionCriteria: "x".repeat(20001) },
    { priority: -1 }, { priority: 4 }, { priority: "2" }, { priority: 1.5 }, { priority: null }, { priority: undefined },
    { labels: "bug" }, { labels: [null] }, { labels: ["a\nb"] }, { labels: ["a\rb"] }, { labels: [" "] }, { labels: ["x".repeat(51)] }, { labels: Array(21).fill("bug") }, { labels: undefined },
    { expectedRevision: 0 }, { expectedRevision: 1.5 }, { expectedRevision: undefined }, { id: "../../sessions" },
    { columnId: "done" }, { project: null }, { projectKey: "other" }, { cwd: "/private" }, { creationFingerprint: "bad" }, { updatedAt: "fake" },
  ]) await assert.rejects(taskOperation(edit(task, change), options), { code: "invalid-input" });
  await assert.rejects(taskOperation(edit(task, { id: randomUUID() }), options), { code: "not-found" });
  assert.equal(await readFile(file, "utf8"), saved);
});

test("sparse JS label arrays are rejected without changing bytes, revision or timestamps", async (t) => {
  const options = await workspace(t);
  const task = (await taskOperation(create(), options)).task;
  const file = path.join(options.agentDir, "tasks", "board.json");
  const saved = await readFile(file, "utf8");
  const leadingHole = Array(2); leadingHole[1] = "label";
  const trailingHole = Array(2); trailingHole[0] = "label";
  const interiorHole = Array(3); interiorHole[0] = "one"; interiorHole[2] = "two";
  // Pass actual sparse arrays to the public JS boundary, not JSON (which turns holes into null).
  for (const labels of [Array(1), Array(3), leadingHole, trailingHole, interiorHole]) {
    await assert.rejects(taskOperation(edit(task, { labels }), options), { code: "invalid-input" });
    assert.equal(await readFile(file, "utf8"), saved);
    const reopened = (await fresh({ action: "list" }, options)).tasks;
    assert.deepEqual(reopened, [task]);
    assert.equal(reopened[0].revision, task.revision);
    assert.equal(reopened[0].createdAt, task.createdAt);
    assert.equal(reopened[0].updatedAt, task.updatedAt);
  }
});

test("ticket 01 v1 records hydrate defaults and ORIGINAL create identity before the first real edit", async (t) => {
  const options = await workspace(t);
  const cwd = path.join(options.agentDir, "legacy-project"); await mkdir(cwd);
  const input = create({ cwd }); const task = (await taskOperation(input, options)).task;
  const file = path.join(options.agentDir, "tasks", "board.json");
  for (const hasFingerprint of [false, true]) {
    const document = JSON.parse(await readFile(file, "utf8"));
    document.version = 1; delete document.sessionRelations; delete document.orderRevision;
    document.tasks = [{ ...task }];
    if (hasFingerprint) document.tasks[0].creationFingerprint = JSON.parse(await readFile(file, "utf8")).tasks[0].creationFingerprint;
    delete document.tasks[0].priority; delete document.tasks[0].labels;
    await writeFile(file, JSON.stringify(document));
    assert.deepEqual((await fresh({ action: "list" }, options)).tasks, [task]);
    const updated = (await fresh(edit(task, { title: "Changed", description: "Changed explanation", completionCriteria: "Changed criteria", priority: 2, labels: ["legacy"] }), options)).task;
    const persisted = JSON.parse(await readFile(file, "utf8")).tasks[0];
    assert.equal(persisted.priority, 2); assert.deepEqual(persisted.labels, ["legacy"]); assert.match(persisted.creationFingerprint, /^[0-9a-f]{64}$/);
    await rm(cwd, { recursive: true, force: true });
    assert.deepEqual((await fresh(input, options)).task, updated);
    await assert.rejects(taskOperation({ ...input, title: "Changed", description: "Changed explanation", completionCriteria: "Changed criteria" }, options), { code: "conflict" });
  }
});

test("invalid persisted attributes are refused, never reset to defaults", async (t) => {
  const options = await workspace(t);
  await taskOperation(create(), options);
  const file = path.join(options.agentDir, "tasks", "board.json"); const saved = JSON.parse(await readFile(file, "utf8"));
  for (const change of [{ priority: null }, { priority: 8 }, { priority: "normal" }, { labels: null }, { labels: ["a\nb"] }, { labels: ["a\rb"] }, { labels: [" "] }, { labels: ["x".repeat(51)] }, { labels: Array(21).fill("x") }]) {
    const text = JSON.stringify({ ...saved, tasks: [{ ...saved.tasks[0], ...change }] });
    await writeFile(file, text);
    await assert.rejects(taskOperation({ action: "list" }, options), { code: "storage-unavailable" });
    await assert.rejects(taskOperation(edit(saved.tasks[0]), options), { code: "storage-unavailable" });
    assert.equal(await readFile(file, "utf8"), text);
  }
});

test("failed edit leaves saved content/time intact and can retry after real filesystem recovery", { skip: process.platform === "win32" ? "POSIX chmod fixture; Windows ACL needs Windows host" : false }, async (t) => {
  const options = await workspace(t);
  const task = (await taskOperation(create(), options)).task;
  const file = path.join(options.agentDir, "tasks", "board.json"); const saved = await readFile(file, "utf8");
  const request = edit(task, { labels: ["retry"], priority: 3 });
  await chmod(path.dirname(file), 0o500);
  try {
    await assert.rejects(taskOperation(request, options), { code: "storage-unavailable" });
    assert.equal(await readFile(file, "utf8"), saved);
  } finally { await chmod(path.dirname(file), 0o700); }
  const result = (await taskOperation(request, options)).task;
  assert.equal(result.revision, 2); assert.deepEqual(result.labels, ["retry"]);
  assert.deepEqual((await fresh({ action: "list" }, options)).tasks, [result]);
  assert.deepEqual(await readdir(path.dirname(file)), ["board.json"]);
});
