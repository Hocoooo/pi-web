import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { taskOperation } = await jiti.import("./task-operations.ts");
const { withTaskStore } = await jiti.import("./task-store.ts");
const { publishContext } = await jiti.import("./task-context.ts");
// Build historical data, not a supported public publication path.
async function seedLegacyContext(request, options) {
  await withTaskStore(options.agentDir, document => ({ value: null, changed: publishContext(document.tasks.find(t => t.id === request.id).sharedContext, request) }));
  const board = await taskOperation({ action: "list" }, options);
  return { board, task: board.tasks.find(t => t.id === request.id) };
}
const { resolveProject, invalidateProjectCache } = await jiti.import("./worktree.ts");
const { projectIdentityKey } = await jiti.import("./project-identity.ts");
const git = (...args) => execFileSync("git", args, { stdio: "pipe" }).toString().trim();
const create = (cwd = null) => ({ action: "create", id: randomUUID(), title: "Original", description: "Original text", completionCriteria: "User checks", cwd });
async function fixture(t) {
  const agentDir = await mkdtemp(join(tmpdir(), "m04-"));
  const options = { agentDir }, file = join(agentDir, "tasks", "board.json");
  const list = () => taskOperation({ action: "list" }, options);
  t.after(async () => { invalidateProjectCache(); await rm(agentDir, { recursive: true, force: true }); });
  return { agentDir, options, file, list };
}
async function session(f, cwd) {
  const dir = join(f.agentDir, "sessions", "fixture"); await mkdir(dir, { recursive: true });
  const manager = SessionManager.create(cwd, dir);
  manager.appendMessage({ role: "user", content: "Synthetic immutable history", timestamp: Date.now() });
  return manager;
}
function fresh(input, options) {
  const script = `import {createJiti} from 'jiti';const {taskOperation}=await createJiti(import.meta.url).import('./lib/task-operations.ts');try{console.log(JSON.stringify({value:await taskOperation(JSON.parse(process.argv[1]),{agentDir:process.argv[2]})}));}catch(e){console.log(JSON.stringify({code:e.code}));}`;
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PI_CODING_AGENT_DIR: options.agentDir };
    for (const key of ["PI_PACKAGE_DIR", "JITI_ALIAS", "JITI_RESOLVE_ALIAS"]) delete env[key];
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(input), options.agentDir], { cwd: process.cwd(), env });
    let output = "", errors = ""; child.stdout.on("data", (d) => output += d); child.stderr.on("data", (d) => errors += d);
    child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(errors)));
  });
}

test("authoritative link/source-create reject stale A display identity after the same real Git checkout becomes B", async (t) => {
  const f = await fixture(t), a = join(f.agentDir, "a"), b = join(f.agentDir, "b"), checkout = join(f.agentDir, "checkout");
  for (const repo of [a, b]) {
    git("init", repo); git("-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture");
  }
  git("-C", a, "worktree", "add", "-b", "fixture-a", checkout);
  const source = await session(f, checkout), bytes = await readFile(source.getSessionFile());
  const task = (await taskOperation(create(a), f.options)).task;
  const cachedA = await resolveProject(checkout);
  assert.equal(projectIdentityKey(cachedA.projectRoot), task.project.projectKey);
  git("-C", a, "worktree", "remove", checkout);
  git("-C", b, "worktree", "add", "-b", "fixture-b", checkout);
  assert.deepEqual(await resolveProject(checkout), cachedA, "sidebar still serves its display cache contract");
  const board = await f.list(), before = await readFile(f.file, "utf8");
  await assert.rejects(taskOperation({ action: "link", id: task.id, expectedRevision: task.revision, sessionIds: [source.getSessionId()] }, f.options), { code: "invalid-input" });
  assert.equal(await readFile(f.file, "utf8"), before); assert.deepEqual(await f.list(), board);
  const request = { action: "createFromSession", id: randomUUID(), title: "B source", description: "", completionCriteria: "", sourceSessionId: source.getSessionId() };
  const created = await taskOperation(request, f.options);
  assert.equal(created.task.project.projectKey, projectIdentityKey((await resolveProject(b)).projectRoot));
  assert.notEqual(created.task.project.projectKey, task.project.projectKey);
  assert.equal(created.task.project.cwd, checkout); assert.deepEqual(created.task.sessionIds, [source.getSessionId()]);
  assert.deepEqual(await readFile(source.getSessionFile()), bytes);
  assert.deepEqual(await resolveProject(checkout), cachedA, "write authority neither invalidates nor replaces sidebar cache");
  await unlink(source.getSessionFile()); git("-C", b, "worktree", "remove", checkout);
  const saved = await readFile(f.file, "utf8");
  assert.deepEqual((await fresh(request, f.options)).value, created, "committed source fingerprint confirms before re-resolving removed source");
  assert.equal(await readFile(f.file, "utf8"), saved);
});

test("v1/v2/main-v3 migrate jointly to v5 retaining custom columns, 06 history/receipts, 03 order/receipt and 02 create identity", async (t) => {
  for (const version of [1, 2, 3]) {
    const f = await fixture(t), input = create(); await taskOperation(input, f.options);
    const second = create(); await taskOperation(second, f.options);
    const publish = { action: "publish-context", id: input.id, expectedCurrentVersionId: null, operationId: randomUUID(), content: { goal: "First", decisions: "Manual", progress: "", nextSteps: "" } };
    const first = await seedLegacyContext(publish, f.options);
    const next = { ...publish, operationId: randomUUID(), expectedCurrentVersionId: first.task.sharedContext.currentVersionId, content: { ...publish.content, goal: "Second" } };
    const middle = await seedLegacyContext(next, f.options);
    const restore = { action: "restore-context", id: input.id, operationId: randomUUID(), expectedCurrentVersionId: middle.task.sharedContext.currentVersionId, versionId: first.task.sharedContext.currentVersionId };
    await seedLegacyContext(restore, f.options);
    const custom = { id: randomUUID(), label: "Custom unfinished" };
    if (version === 3) {
      const board = await f.list();
      await taskOperation({ action: "set-columns", expectedColumnsRevision: board.columnsRevision, columns: [custom, ...board.columns.map(({ id, label }) => ({ id, label }))] }, f.options);
    }
    let board = await f.list();
    const move = { action: "move", id: input.id, expectedRevision: board.tasks[0].revision, expectedOrderRevision: board.orderRevision, operationId: randomUUID(), columnId: version === 3 ? custom.id : "done", position: { edge: "end" } };
    await taskOperation(move, f.options);
    const old = JSON.parse(await readFile(f.file, "utf8")); old.version = version; delete old.sessionRelations;
    for (const task of old.tasks) delete task.sessionIds;
    if (version < 3) { delete old.columns; delete old.columnsRevision; }
    if (version === 1) delete old.orderRevision;
    await writeFile(f.file, JSON.stringify(old));
    const readers = await Promise.all(Array.from({ length: 3 }, () => fresh({ action: "list" }, f.options)));
    for (const reader of readers) assert.deepEqual(reader.value, readers[0].value);
    const migrated = JSON.parse(await readFile(f.file, "utf8"));
    assert.equal(migrated.version, 7); assert.deepEqual(migrated.tasks, old.tasks.map((task) => ({ ...task, sessionIds: [] })));
    assert.equal(migrated.orderRevision, version === 1 ? 0 : old.orderRevision);
    assert.equal(migrated.columnsRevision, old.columnsRevision ?? 0);
    if (version === 3) assert.deepEqual(migrated.columns, old.columns);
    else assert.equal(migrated.columns.length, 5);
    const stable = await readFile(f.file, "utf8");
    for (const retry of [input, second, move, publish, next, restore]) {
      const result = await fresh(retry, f.options);
      if (retry.action === "publish-context" || retry.action === "restore-context") assert.equal(result.code, "invalid-input");
      else assert.deepEqual(result.value.board, readers[0].value);
      assert.equal(await readFile(f.file, "utf8"), stable);
    }
    // The unpublished isolated 04-only v3 is not silently accepted as main v3.
    const isolated = { ...migrated, version: 3 }; delete isolated.columns; delete isolated.columnsRevision;
    const invalid = JSON.stringify(isolated); await writeFile(f.file, invalid);
    assert.equal((await fresh({ action: "list" }, f.options)).code, "storage-unavailable");
    assert.equal(await readFile(f.file, "utf8"), invalid);
  }
});

test("source-create/batch links coexist with columns, knowledge, detail CAS, manual order and exact historical retries", async (t) => {
  const f = await fixture(t), chat = join(f.agentDir, "chat-workspace"); await mkdir(chat);
  const [a, b, c] = await Promise.all([session(f, chat), session(f, chat), session(f, chat)]);
  const source = { action: "createFromSession", id: randomUUID(), title: "Source", description: "Original", completionCriteria: "User approves", sourceSessionId: a.getSessionId() };
  const created = await taskOperation(source, f.options);
  const link = { action: "link", id: source.id, expectedRevision: created.task.revision, sessionIds: [b.getSessionId(), c.getSessionId()] };
  const linked = await taskOperation(link, f.options); assert.equal(linked.board.orderRevision, created.board.orderRevision);
  const ordinary = create(); await taskOperation(ordinary, f.options);
  let board = await f.list(); const custom = { id: randomUUID(), label: "Not done" };
  board = await taskOperation({ action: "set-columns", expectedColumnsRevision: board.columnsRevision, columns: [custom, ...board.columns.map(({ id, label }) => ({ id, label }))] }, f.options);
  const publish = { action: "publish-context", id: source.id, expectedCurrentVersionId: null, operationId: randomUUID(), content: { goal: "Knowledge", decisions: "Manual", progress: "", nextSteps: "" } };
  const published = await seedLegacyContext(publish, f.options);
  const move = { action: "move", id: source.id, expectedRevision: linked.task.revision, expectedOrderRevision: board.orderRevision, operationId: randomUUID(), columnId: custom.id, position: { edge: "end" } };
  const moved = await taskOperation(move, f.options);
  const edit = { action: "edit", id: source.id, expectedRevision: moved.task.revision, title: "Edited", description: "Updated", completionCriteria: "Check", priority: 3, labels: ["x"] };
  const edited = await taskOperation(edit, f.options);
  const more = { ...publish, operationId: randomUUID(), expectedCurrentVersionId: published.task.sharedContext.currentVersionId, content: { ...publish.content, goal: "Second" } };
  const later = await seedLegacyContext(more, f.options);
  const restore = { action: "restore-context", id: source.id, operationId: randomUUID(), expectedCurrentVersionId: later.task.sharedContext.currentVersionId, versionId: published.task.sharedContext.currentVersionId };
  const final = await seedLegacyContext(restore, f.options);
  assert.deepEqual(final.task.sessionIds, [a, b, c].map((s) => s.getSessionId()));
  assert.equal(final.task.revision, edited.task.revision); assert.equal(final.board.orderRevision, moved.board.orderRevision);
  assert.equal(final.board.columnsRevision, 1); assert.equal(final.task.columnId, custom.id); assert.equal(final.task.sharedContext.versions.length, 3);
  const stable = await readFile(f.file, "utf8");
  for (const retry of [source, ordinary, link, move, publish, more, restore]) {
    const result = await fresh(retry, f.options);
    if (retry.action === "publish-context" || retry.action === "restore-context") assert.equal(result.code, "invalid-input");
    else assert.deepEqual(result.value.board, final.board);
    assert.equal(await readFile(f.file, "utf8"), stable);
  }
  await assert.rejects(taskOperation(edit, f.options), { code: "conflict" });
  assert.equal(await readFile(f.file, "utf8"), stable);
  const stored = JSON.parse(stable).tasks.find((task) => task.id === source.id);
  assert.ok(stored.creationFingerprint); assert.equal(stored.moveReceipt.operationId, move.operationId);
  assert.ok(stored.sharedContext.versions.every((v) => v.receipt));
});
