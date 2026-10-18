import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile, readdir, chmod, utimes } from "node:fs/promises";
import lockfile from "proper-lockfile";
import { execFileSync, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createJiti } from "jiti";
import test from "node:test";
import { moveRequest } from "./task-test-helpers.mjs";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { taskOperation } = await jiti.import("./task-operations.ts");
async function workspace(t) {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-web-task-"));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  return { agentDir };
}
const create = (overrides = {}) => ({ action: "create", id: randomUUID(), title: "Ship the fix", description: "Investigate <script> and /private/path", completionCriteria: "Tests pass; user confirms", cwd: null, ...overrides });

test("create, move and reopen preserve independent tasks and stable columns", async (t) => {
  const options = await workspace(t);
  const initial = await taskOperation({ action: "list" }, options);
  assert.deepEqual(initial.columns.map((c) => c.id), ["todo", "in-progress", "review", "blocked", "done"]);
  assert.equal(initial.columns.filter((c) => c.isCompletion).length, 1);
  const input = create();
  const { task } = await taskOperation(input, options);
  assert.equal(task.project, null);
  assert.equal(task.columnId, "todo");
  assert.equal(task.description, input.description);
  assert.equal(task.completionCriteria, input.completionCriteria);
  const moved = await taskOperation(await moveRequest({ action: "move", id: task.id, columnId: "done", expectedRevision: task.revision }, options), options);
  assert.equal(moved.task.columnId, "done");
  const reopened = await taskOperation({ action: "list" }, { agentDir: options.agentDir });
  assert.deepEqual(reopened.tasks, [moved.task]);
  assert.deepEqual(await readdir(options.agentDir), ["tasks"]);
});

test("concurrent creates, retry and revision conflicts never lose tasks", async (t) => {
  const options = await workspace(t);
  const input = create();
  const repeated = await Promise.all(Array.from({ length: 8 }, () => taskOperation(input, options)));
  assert.equal(new Set(repeated.map((result) => result.task.id)).size, 1);
  await assert.rejects(taskOperation({ ...input, title: "Different" }, options), { code: "conflict" });
  const otherInputs = Array.from({ length: 12 }, () => create());
  await Promise.all(otherInputs.map((value) => taskOperation(value, options)));
  assert.equal((await taskOperation({ action: "list" }, options)).tasks.length, 13);
  const move = await moveRequest({ action: "move", id: input.id, columnId: "review", expectedRevision: 1 }, options);
  const contenders = [move, { ...move, operationId: randomUUID(), columnId: "blocked" }];
  const results = await Promise.allSettled(contenders.map((request) => taskOperation(request, options)));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.find((result) => result.status === "rejected").reason.code, "conflict");
  const winner = results.find((result) => result.status === "fulfilled").value.task;
  const winningRequest = contenders[results.findIndex((result) => result.status === "fulfilled")];
  assert.equal(winner.columnId, winningRequest.columnId);
  assert.equal((await taskOperation(winningRequest, options)).task.revision, 2);
});

test("committed creates retry after directory removal and project resolution changes without changing revision", async (t) => {
  const options = await workspace(t);
  const root = path.join(options.agentDir, "retry-repository");
  const cwd = path.join(options.agentDir, "retry-directory");
  await mkdir(cwd);
  const input = create({ cwd });
  const first = (await taskOperation(input, options)).task;
  const moved = (await taskOperation(await moveRequest({ action: "move", id: first.id, columnId: "review", expectedRevision: first.revision }, options), options)).task;
  // Replace the non-Git directory with a linked worktree: same selected cwd,
  // genuinely different server project identity in a fresh process.
  execFileSync("git", ["init", root]);
  execFileSync("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "fixture"]);
  await rm(cwd, { recursive: true });
  execFileSync("git", ["-C", root, "worktree", "add", "-b", "retry", cwd]);
  const changedProject = (await inProcess(create({ cwd }), options)).task;
  assert.notEqual(changedProject.project.projectKey, first.project.projectKey);
  assert.deepEqual((await inProcess(input, options)).task, moved);
  await rm(cwd, { recursive: true });
  assert.deepEqual((await inProcess({ action: "list" }, options)).tasks, [moved, changedProject]);
  assert.deepEqual((await inProcess(input, options)).task, moved);
  for (const change of [{ title: "Different" }, { description: "Different" }, { completionCriteria: "Different" }, { cwd: null }]) {
    await assert.rejects(taskOperation({ ...input, ...change }, options), { code: "conflict" });
  }
  await assert.rejects(taskOperation(create({ cwd }), options), { code: "invalid-input" });
  assert.deepEqual((await taskOperation({ action: "list" }, options)).tasks, [moved, changedProject]);
});

test("create retry identity stays immutable when stored current text changes; earlier v1 records hydrate it", async (t) => {
  const options = await workspace(t);
  const input = create();
  const original = (await taskOperation(input, options)).task;
  assert.equal("creationFingerprint" in original, false, "retry metadata stays internal");
  const file = path.join(options.agentDir, "tasks", "board.json");
  const legacy = JSON.parse(await readFile(file, "utf8"));
  legacy.version = 1; delete legacy.sessionRelations; delete legacy.orderRevision;
  delete legacy.tasks[0].creationFingerprint;
  await writeFile(file, JSON.stringify(legacy));
  // A supported mutation persists legacy hydration before any future editing.
  const moved = (await taskOperation(await moveRequest({ action: "move", id: input.id, columnId: "review", expectedRevision: 1 }, options), options)).task;
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.match(saved.tasks[0].creationFingerprint, /^[0-9a-f]{64}$/);
  // Synthetic future data, NOT an implementation of ticket 02's edit operation.
  Object.assign(saved.tasks[0], { title: "Edited title", description: "Edited description", completionCriteria: "Edited requirements", revision: 3 });
  await writeFile(file, JSON.stringify(saved));
  const edited = { ...moved, title: "Edited title", description: "Edited description", completionCriteria: "Edited requirements", revision: 3 };
  assert.deepEqual((await inProcess(input, options)).task, edited);
  await assert.rejects(taskOperation({ ...input, title: edited.title, description: edited.description, completionCriteria: edited.completionCriteria }, options), { code: "conflict" });
  assert.deepEqual((await inProcess({ action: "list" }, options)).tasks, [edited]);
});

test("project identity follows server roots, distinguishes same basenames, and accepts no project", async (t) => {
  const options = await workspace(t);
  const first = path.join(options.agentDir, "a", "project");
  const second = path.join(options.agentDir, "b", "project");
  await mkdir(first, { recursive: true }); await mkdir(second, { recursive: true });
  const a = (await taskOperation(create({ cwd: first }), options)).task;
  const b = (await taskOperation(create({ cwd: second }), options)).task;
  assert.notEqual(a.project.projectKey, b.project.projectKey);
  assert.equal(a.project.cwd, first);
  await mkdir(path.join(options.agentDir, "chat-workspace"));
  assert.equal((await taskOperation(create({ cwd: path.join(options.agentDir, "chat-workspace") }), options)).task.project, null);
  await assert.rejects(taskOperation(create({ cwd: path.join(options.agentDir, "missing") }), options), { code: "invalid-input" });
  const repository = path.join(options.agentDir, "repository");
  execFileSync("git", ["init", repository]);
  execFileSync("git", ["-C", repository, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "fixture"]);
  const main = (await taskOperation(create({ cwd: repository }), options)).task;
  const worktree = path.join(options.agentDir, "worktree");
  execFileSync("git", ["-C", repository, "worktree", "add", "-b", "fixture", worktree]);
  const linked = (await taskOperation(create({ cwd: worktree }), options)).task;
  assert.equal(linked.project.projectKey, main.project.projectKey);
  assert.equal(linked.project.cwd, worktree);
});

test("untrusted fields and IDs cannot become tasks or filesystem targets", async (t) => {
  const options = await workspace(t);
  for (const input of [null, [], {}, create({ title: " " }), create({ title: "x".repeat(201) }), create({ description: "x".repeat(20001) }), create({ completionCriteria: [] }), create({ cwd: [] }), create({ id: "../../sessions" }), create({ projectKey: "/private" }), create({ columnId: "done" }), { action: "move", id: randomUUID(), columnId: "unknown", expectedRevision: 1 }, { action: "move", id: randomUUID(), columnId: "done", expectedRevision: 0 }]) {
    await assert.rejects(taskOperation(input, options), { code: "invalid-input" });
  }
  assert.deepEqual(await readdir(options.agentDir), []);
});

test("schema version dispatch and failure recovery preserve the last saved document", async (t) => {
  const options = await workspace(t);
  const { task } = await taskOperation(create(), options);
  const file = path.join(options.agentDir, "tasks", "board.json");
  const saved = await readFile(file, "utf8");
  for (const [text, code] of [["{partial", "storage-unavailable"], [JSON.stringify({ version: 99, tasks: [] }), "unsupported-version"], [JSON.stringify({ version: 1, tasks: [{ id: task.id }] }), "storage-unavailable"]]) {
    await writeFile(file, text);
    await assert.rejects(taskOperation({ action: "list" }, options), { code });
    await assert.rejects(taskOperation(create(), options), { code });
    assert.equal(await readFile(file, "utf8"), text);
  }
  await writeFile(file, saved);
  assert.deepEqual((await taskOperation({ action: "list" }, options)).tasks, [task]);
  const recovered = await taskOperation(create(), options);
  assert.equal(recovered.task.revision, 1);
  assert.equal((await taskOperation({ action: "list" }, options)).tasks.length, 2);
  assert.deepEqual((await readdir(path.dirname(file))).filter((name) => name !== "board.json"), []);
});

test("denied writes leave saved tasks intact and recover after access is restored", { skip: process.platform === "win32" ? "POSIX chmod fixture; Windows ACL denial requires a Windows host" : false }, async (t) => {
  const options = await workspace(t);
  await taskOperation(create(), options);
  const file = path.join(options.agentDir, "tasks", "board.json");
  const saved = await readFile(file, "utf8");
  const directory = path.dirname(file);
  await chmod(directory, 0o500);
  try {
    await assert.rejects(taskOperation(create(), options), { code: "storage-unavailable" });
    assert.equal(await readFile(file, "utf8"), saved);
  } finally { await chmod(directory, 0o700); }
  await taskOperation(create(), options);
  assert.equal((await taskOperation({ action: "list" }, options)).tasks.length, 2);
  assert.deepEqual((await readdir(directory)).filter((name) => name !== "board.json"), []);
});

test("a busy store reports failure, and a stale abandoned lock is recovered", async (t) => {
  const options = await workspace(t);
  await taskOperation(create(), options);
  const file = path.join(options.agentDir, "tasks", "board.json");
  const saved = await readFile(file, "utf8");
  const release = await lockfile.lock(file, { realpath: false });
  try {
    await assert.rejects(taskOperation(create(), options), { code: "storage-unavailable" });
    assert.equal(await readFile(file, "utf8"), saved);
  } finally { await release(); }
  await mkdir(`${file}.lock`);
  const abandoned = new Date(Date.now() - 60_000);
  await utimes(`${file}.lock`, abandoned, abandoned);
  assert.equal((await taskOperation({ action: "list" }, options)).tasks.length, 1);
  await taskOperation(create(), options);
  assert.equal((await taskOperation({ action: "list" }, options)).tasks.length, 2);
});

function inProcess(input, options) {
  const script = `import { createJiti } from 'jiti'; const jiti = createJiti(import.meta.url); const { taskOperation } = await jiti.import('./lib/task-operations.ts'); console.log(JSON.stringify(await taskOperation(JSON.parse(process.argv[1]), { agentDir: process.argv[2] })));`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(input), options.agentDir], { cwd: process.cwd(), env: process.env });
    let output = "", error = "";
    child.stdout.on("data", (data) => { output += data; }); child.stderr.on("data", (data) => { error += data; });
    child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(error)));
  });
}
test("fresh processes reopen and concurrently commit the same temporary store", async (t) => {
  const options = await workspace(t);
  const input = create();
  const first = await inProcess(input, options);
  assert.equal(first.task.id, input.id);
  assert.deepEqual((await inProcess({ action: "list" }, options)).tasks, [first.task]);
  const created = await Promise.all(Array.from({ length: 4 }, () => inProcess(create(), options)));
  assert.equal(created.length, 4);
  assert.equal((await taskOperation({ action: "list" }, options)).tasks.length, 5);
});
