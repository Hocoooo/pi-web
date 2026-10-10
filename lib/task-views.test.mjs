import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { taskOperation } = await jiti.import("./task-operations.ts");
const { withTaskStore } = await jiti.import("./task-store.ts");
const { publishContext } = await jiti.import("./task-context.ts");
async function seedLegacyContext(request, options) {
  await withTaskStore(options.agentDir, document => ({ value: null, changed: publishContext(document.tasks.find(t => t.id === request.id).sharedContext, request) }));
  return taskOperation({ action: "list" }, options);
}
const { emptyTaskFilter, projectTaskView, taskActivity } = await jiti.import("./task-view.ts");
const create = (title, cwd = null) => ({ action: "create", id: randomUUID(), title, description: "Search description", completionCriteria: "Confirm", cwd });
async function fixture(t) {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "p05-store-")); t.after(() => rm(agentDir, { recursive: true, force: true }));
  return { options: { agentDir }, file: path.join(agentDir, "tasks", "board.json"), list: () => taskOperation({ action: "list" }, { agentDir }) };
}
const save = (board, name = "Focus", filter = emptyTaskFilter()) => ({ action: "save-view", id: randomUUID(), operationId: randomUUID(), expectedViewsRevision: board.viewsRevision, name, filter, sort: "priority" });
const move = (board, task, columnId, position = { edge: "end" }) => ({ action: "move", id: task.id, columnId, position, expectedRevision: task.revision, expectedOrderRevision: board.orderRevision, operationId: randomUUID() });
function fresh(request, options) {
  const script = `import {createJiti} from 'jiti';const {taskOperation}=await createJiti(import.meta.url).import('./lib/task-operations.ts');try{console.log(JSON.stringify({value:await taskOperation(JSON.parse(process.argv[1]),{agentDir:process.argv[2]})}));}catch(e){console.log(JSON.stringify({code:e.code}));}`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(request), options.agentDir], { cwd: process.cwd(), env: process.env });
    let output = "", errors = ""; child.stdout.on("data", (data) => output += data); child.stderr.on("data", (data) => errors += data);
    child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(errors)));
  });
}
async function edit(task, options, patch = {}) { return (await taskOperation({ action: "edit", id: task.id, expectedRevision: task.revision, title: task.title, description: task.description, completionCriteria: task.completionCriteria, priority: task.priority, labels: task.labels, ...patch }, options)).task; }

test("combined filters, no project, all labels, stable IDs, real empty result and fail-closed unknown conditions", async (t) => {
  const f = await fixture(t); const project = path.join(f.options.agentDir, "project"); await mkdir(project);
  let a = (await taskOperation(create("Needle", project), f.options)).task;
  let b = (await taskOperation(create("Needle independent"), f.options)).task;
  a = await edit(a, f.options, { priority: 3, labels: ["one", "two"] }); b = await edit(b, f.options, { priority: 3, labels: ["one"] });
  const board = await f.list(), bytes = await readFile(f.file, "utf8");
  const view = (patch) => projectTaskView(board, { ...emptyTaskFilter(), ...patch }, "manual", new Set()).tasks.map((task) => task.id);
  assert.deepEqual(view({ text: "SEARCH DESCRIPTION", project: { key: a.project.projectKey }, columnIds: ["todo"], priorities: [3], labels: ["one", "two"], activity: "idle" }), [a.id]);
  assert.deepEqual(view({ project: { key: null }, text: "needle", labels: ["one"] }), [b.id]);
  assert.deepEqual(view({ project: { key: "missing" } }), []); assert.deepEqual(view({ labels: ["two"], priorities: [0] }), []);
  assert.equal(projectTaskView(board, { ...emptyTaskFilter(), columnIds: [randomUUID()] }, "manual", new Set()).invalid, true);
  assert.equal(projectTaskView(board, { ...emptyTaskFilter(), labels: null }, "manual", new Set()).invalid, true);
  assert.equal(await readFile(f.file, "utf8"), bytes);
});

test("working/idle/unknown lifecycle projections update without reading sessions or changing task state", async (t) => {
  const f = await fixture(t); await taskOperation(create("Linked"), f.options); await taskOperation(create("Independent"), f.options);
  const document = JSON.parse(await readFile(f.file, "utf8")); document.tasks[0].sessionIds = ["queue-session"];
  await writeFile(f.file, JSON.stringify(document)); const board = await f.list();
  const projection = (activity, running, stale = false) => projectTaskView(board, { ...emptyTaskFilter(), activity }, "manual", running, stale).tasks.map((task) => task.title);
  assert.deepEqual(projection("working", new Set(["queue-session"])), ["Linked"]);
  assert.deepEqual(projection("idle", new Set(["queue-session"])), ["Independent"]);
  assert.deepEqual(projection("idle", new Set()), ["Linked", "Independent"]);
  assert.deepEqual(projection("idle", new Set(), true), ["Independent"]);
  assert.deepEqual(projection("working", new Set(["queue-session"]), true), []);
  assert.equal(taskActivity(board.tasks[0], null, false), "unknown");
  assert.deepEqual((await f.list()).tasks, board.tasks);
});

test("deterministic priority/updated ties and mode changes never write manual order", async (t) => {
  const f = await fixture(t); for (const name of ["A", "B", "C"]) await taskOperation(create(name), f.options);
  const document = JSON.parse(await readFile(f.file, "utf8"));
  for (const task of document.tasks) { task.createdAt = "2026-01-01T00:00:00.000Z"; task.updatedAt = "2026-01-02T00:00:00.000Z"; }
  document.tasks[1].priority = 3; await writeFile(f.file, JSON.stringify(document));
  const board = await f.list(), bytes = await readFile(f.file, "utf8");
  const ids = (sort) => projectTaskView(board, emptyTaskFilter(), sort, new Set()).tasks.map((task) => task.id);
  const sortedIds = board.tasks.map((task) => task.id).sort();
  assert.deepEqual(ids("updated"), sortedIds); assert.equal(ids("priority")[0], board.tasks[1].id);
  assert.deepEqual(ids("priority").slice(1), [board.tasks[0].id, board.tasks[2].id].sort());
  assert.deepEqual(ids("manual"), board.tasks.map((task) => task.id)); assert.equal(await readFile(f.file, "utf8"), bytes);
});

test("saved conditions survive fresh processes, exact lost-response retry and cross-domain mutations", async (t) => {
  const f = await fixture(t); const input = create("Original"); const original = (await taskOperation(input, f.options)).task;
  let board = await f.list(); const moveRequest = move(board, original, "done"); board = (await taskOperation(moveRequest, f.options)).board;
  const context = { action: "publish-context", id: original.id, expectedCurrentVersionId: null, operationId: randomUUID(), content: { goal: "Keep", decisions: "", progress: "", nextSteps: "" } };
  board = await seedLegacyContext(context, f.options);
  const custom = randomUUID(); board = await taskOperation({ action: "set-columns", expectedColumnsRevision: board.columnsRevision, columns: [...board.columns.map(({ id, label }) => ({ id, label })), { id: custom, label: "Custom" }] }, f.options);
  const before = JSON.parse(await readFile(f.file, "utf8"));
  const request = save(board, "  Named  ", { ...emptyTaskFilter(), columnIds: [custom], labels: ["tag"], project: { key: null } });
  const saved = await taskOperation(request, f.options); assert.equal(saved.savedViews[0].name, "Named"); assert.equal(saved.viewsRevision, 1);
  assert.deepEqual(saved.tasks, board.tasks); assert.deepEqual(JSON.parse(await readFile(f.file, "utf8")).tasks, before.tasks);
  assert.equal(saved.orderRevision, board.orderRevision); assert.equal(saved.columnsRevision, board.columnsRevision); assert.equal("receipt" in saved.savedViews[0], false);
  assert.deepEqual((await fresh({ action: "list" }, f.options)).value, saved);
  const second = await taskOperation(save(saved, "Other"), f.options), bytes = await readFile(f.file, "utf8");
  for (const requestToRetry of [request, input, moveRequest, context]) {
    const response = await fresh(requestToRetry, f.options);
    if (requestToRetry.action === "publish-context") assert.equal(response.code, "invalid-input");
    else assert.deepEqual("board" in response.value ? response.value.board : response.value, second);
    assert.equal(await readFile(f.file, "utf8"), bytes);
  }
  await assert.rejects(taskOperation({ ...request, name: "Changed" }, f.options), { code: "conflict" });
  await assert.rejects(taskOperation(save(second, "Named"), f.options), { code: "conflict" });
});

test("two-process saving conflicts; view CAS independent from task moves and no duplicate records", async (t) => {
  const f = await fixture(t); const task = (await taskOperation(create("A"), f.options)).task, board = await f.list();
  const responses = await Promise.all([fresh(save(board, "A"), f.options), fresh(save(board, "B"), f.options)]);
  assert.equal(responses.filter((r) => r.value).length, 1); assert.equal(responses.find((r) => r.code).code, "conflict");
  const next = await f.list(); assert.equal(next.savedViews.length, 1);
  const both = await Promise.all([fresh(save(next, "Next"), f.options), fresh(move(next, task, "review"), f.options)]);
  assert.ok(both.every((r) => r.value)); assert.equal((await f.list()).savedViews.length, 2);
});

test("additive v4 absence-only migration preserves all bytes of other domains and refuses invalid/partial views", async (t) => {
  const f = await fixture(t); await taskOperation(create("Legacy"), f.options);
  const good = JSON.parse(await readFile(f.file, "utf8")); delete good.savedViews; delete good.viewsRevision;
  for (const version of [1, 2, 3, 4]) {
    const legacy = { ...good, version }; delete legacy.sessionRelations; if (version < 3) { delete legacy.columns; delete legacy.columnsRevision; } if (version === 1) delete legacy.orderRevision;
    await writeFile(f.file, JSON.stringify(legacy));
    const readers = await Promise.all([fresh({ action: "list" }, f.options), fresh({ action: "list" }, f.options)]);
    assert.deepEqual(readers[0], readers[1]); const persisted = JSON.parse(await readFile(f.file, "utf8"));
    assert.equal(persisted.version, 7); assert.deepEqual(persisted.tasks, good.tasks); assert.equal(persisted.viewsRevision, 0); assert.deepEqual(persisted.savedViews, []);
  }
  for (const patch of [{ savedViews: [] }, { viewsRevision: 0 }, { savedViews: null, viewsRevision: 0 }, { savedViews: [], viewsRevision: -1 }, { savedViews: [{}], viewsRevision: 0 }]) {
    const bytes = JSON.stringify({ ...good, ...patch }); await writeFile(f.file, bytes);
    await assert.rejects(f.list(), { code: "storage-unavailable" }); assert.equal(await readFile(f.file, "utf8"), bytes);
  }
});

test("strict save validation rejects malformed/sparse/unknown conditions without widening or modifying storage", async (t) => {
  const f = await fixture(t), board = await f.list(), request = save(board), bytes = await readFile(f.file, "utf8");
  for (const patch of [{ name: " " }, { name: "a\nb" }, { name: "x".repeat(101) }, { id: "../x" }, { expectedViewsRevision: -1 }, { query: "free query" },
    ...[{ columnIds: Array(1) }, { columnIds: [randomUUID()] }, { priorities: [4] }, { labels: Array(1) }, { labels: [" a "] }, { project: {} }, { project: { key: null, extra: true } }, { activity: "failed" }, { text: "x".repeat(201) }].map((change) => ({ filter: { ...request.filter, ...change } }))]) {
    await assert.rejects(taskOperation({ ...request, ...patch }, f.options), { code: "invalid-input" }); assert.equal(await readFile(f.file, "utf8"), bytes);
  }
});

test("filtered neighbor/visible-empty-column moves affect one task, preserve hidden order and move out of range", async (t) => {
  const f = await fixture(t); for (const title of ["Visible A", "Hidden A", "Visible B", "Hidden B"]) await taskOperation(create(title), f.options);
  let board = await f.list(); const originals = board.tasks; const visible = projectTaskView(board, { ...emptyTaskFilter(), text: "Visible" }, "manual", new Set()).tasks;
  board = (await taskOperation(move(board, visible[1], "todo", { before: visible[0].id }), f.options)).board;
  assert.deepEqual(board.tasks.filter((task) => task.title.startsWith("Hidden")), originals.filter((task) => task.title.startsWith("Hidden")));
  const hidden = board.tasks.find((task) => task.title === "Hidden A"); board = (await taskOperation(move(board, hidden, "review"), f.options)).board;
  const moving = board.tasks.find((task) => task.title === "Visible B"); board = (await taskOperation(move(board, moving, "review"), f.options)).board;
  assert.equal(board.tasks.find((task) => task.id === hidden.id).columnId, "review"); assert.equal(board.tasks.length, 4);
  assert.deepEqual(projectTaskView(board, { ...emptyTaskFilter(), text: "Visible", columnIds: ["todo"] }, "manual", new Set()).tasks.map((task) => task.title), ["Visible A"]);
  assert.deepEqual((await fresh({ action: "list" }, f.options)).value, board);
});

test("real POSIX failure then same save request succeeds once", { skip: process.platform === "win32" ? "POSIX chmod; Windows ACL not exercised" : false }, async (t) => {
  const f = await fixture(t), request = save(await f.list()), bytes = await readFile(f.file, "utf8");
  await chmod(path.dirname(f.file), 0o500);
  try { await assert.rejects(taskOperation(request, f.options), { code: "storage-unavailable" }); assert.equal(await readFile(f.file, "utf8"), bytes); }
  finally { await chmod(path.dirname(f.file), 0o700); }
  const saved = await taskOperation(request, f.options); assert.equal(saved.savedViews.length, 1); assert.deepEqual(await taskOperation(request, f.options), saved);
});
