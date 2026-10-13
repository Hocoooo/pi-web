import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createTaskTestJiti } from "../../../lib/__fixtures__/task-jiti.mjs";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const agentDir = await mkdtemp(join(tmpdir(), "pi-web-task-project-api-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const projectA = join(agentDir, "project-a"), projectB = join(agentDir, "project-b");
await mkdir(projectA); await mkdir(projectB);
const jiti = createTaskTestJiti(import.meta.url);
const { GET, POST } = await jiti.import("./route.ts");
test.after(async () => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  await rm(agentDir, { recursive: true, force: true });
});
const post = input => POST(new Request("http://localhost/api/tasks", { method: "POST", body: JSON.stringify(input) }));
async function ok(input) {
  const response = await post(input);
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}
const board = async () => (await GET()).json();
const createRequest = (cwd = null) => ({ action: "create", id: randomUUID(), title: "Project task", description: "Keep description", completionCriteria: "Keep criteria", cwd });
async function session(cwd) {
  const directory = join(agentDir, "sessions", randomUUID());
  await mkdir(directory, { recursive: true });
  const native = SessionManager.create(cwd, directory);
  native.appendMessage({ role: "user", content: "Project change must not alter this conversation", timestamp: Date.now() });
  return native;
}
const preview = (task, cwd) => ok({ action: "preview-project", id: task.id, cwd });
const change = (task, cwd, snapshot) => ({ action: "change-project", id: task.id, cwd,
  expectedRevision: snapshot.revision, previewToken: snapshot.token, operationId: randomUUID() });

test("a task can select a directory, change its project, and return to no project without changing its details", async () => {
  const task = (await ok(createRequest(projectA))).task;
  const before = await board();
  const snapshot = await preview(task, projectB);
  assert.equal(snapshot.project.cwd, projectB);
  assert.deepEqual(snapshot.detachSessionIds, []);
  assert.deepEqual(await board(), before, "preview does not write the board");
  const changed = (await ok(change(task, projectB, snapshot))).task;
  assert.equal(changed.project.cwd, projectB);
  assert.equal(changed.project.projectRoot, projectB);
  assert.equal(changed.revision, task.revision + 1);
  assert.equal(changed.title, "Project task");
  assert.equal(changed.description, "Keep description");
  assert.equal(changed.completionCriteria, "Keep criteria");
  assert.equal(changed.columnId, task.columnId);
  assert.equal((await board()).orderRevision, before.orderRevision);
  const cleared = (await ok(change(changed, null, await preview(changed, null)))).task;
  assert.equal(cleared.project, null);
  assert.equal((await board()).tasks.find(t => t.id === task.id).project, null);
});

test("a committed project change can be retried after its directory disappears without replaying or changing creation identity", async () => {
  const cwd = join(agentDir, randomUUID()); await mkdir(cwd);
  const creation = createRequest(projectA);
  const task = (await ok(creation)).task;
  const request = change(task, cwd, await preview(task, cwd));
  const changed = await ok(request);
  await rm(cwd, { recursive: true });
  assert.deepEqual(await ok(request), changed);
  assert.deepEqual((await ok(creation)).task, changed.task, "create retries still confirm the original creation");
  const altered = await post({ ...request, cwd: projectB });
  assert.equal(altered.status, 409);
  assert.deepEqual(await board(), changed.board);
});

test("available projects combine Pi conversations and task-only projects without duplicate roots or a chat workspace entry", async () => {
  const known = join(agentDir, "known-project"), taskOnly = join(agentDir, "task-only");
  const chat = join(agentDir, "chat-workspace");
  await mkdir(known); await mkdir(taskOnly); await mkdir(chat);
  await session(known); await session(known); await session(chat);
  await ok(createRequest(taskOnly));
  const response = await post({ action: "projects" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const { projects } = await response.json();
  assert.equal(projects.filter(p => p.projectRoot === known).length, 1);
  assert.equal(projects.filter(p => p.projectRoot === taskOnly).length, 1);
  assert.ok(projects.every(p => p.projectRoot !== chat));
  assert.ok(projects.every(p => Object.keys(p).sort().join() === "cwd,projectKey,projectRoot"));
});

test("stale confirmation, forged project identity, and invalid directories cannot partially unlink conversations", async () => {
  const native = await session(projectA), sessionId = native.getSessionId();
  let task = (await ok({ ...createRequest(), action: "createFromSession", cwd: undefined, sourceSessionId: sessionId })).task;
  const stale = change(task, projectB, await preview(task, projectB));
  task = (await ok({ action: "edit", id: task.id, expectedRevision: task.revision, title: "Other tab edit", description: "", completionCriteria: "", priority: 1, labels: [] })).task;
  const before = await board();
  assert.equal((await post(stale)).status, 409);
  const fresh = change(task, projectB, await preview(task, projectB));
  for (const input of [{ ...fresh, projectKey: "forged" }, { ...fresh, previewToken: "0".repeat(64) },
    { ...fresh, cwd: join(agentDir, "missing") }, { ...fresh, operationId: "bad" },
    { action: "projects", cwd: projectA }, { action: "preview-project", id: task.id }]) {
    assert.ok((await post(input)).status >= 400);
    assert.deepEqual(await board(), before);
  }
  assert.equal((await ok({ action: "session-task", sessionId })).task.id, task.id);
});

test("same-repository worktree changes keep linked conversations and reject a directory whose identity changed after preview", async () => {
  const repo = join(agentDir, "repo"), worktree = join(agentDir, "worktree");
  await mkdir(repo);
  const git = (...args) => execFileSync("git", args, { stdio: "pipe" });
  git("init", repo);
  git("-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "fixture");
  git("-C", repo, "worktree", "add", "-b", "fixture", worktree);
  const native = await session(repo);
  const task = (await ok({ ...createRequest(), action: "createFromSession", cwd: undefined, sourceSessionId: native.getSessionId() })).task;
  const snapshot = await preview(task, worktree);
  assert.deepEqual(snapshot.detachSessionIds, []);
  const changed = (await ok(change(task, worktree, snapshot))).task;
  assert.equal(changed.project.projectKey, task.project.projectKey);
  assert.deepEqual(changed.sessionIds, task.sessionIds);
  const next = change(changed, worktree, await preview(changed, worktree));
  git("-C", repo, "worktree", "remove", worktree);
  await mkdir(worktree);
  const before = await board();
  assert.equal((await post(next)).status, 409);
  assert.deepEqual(await board(), before);
});

test("missing conversations are explicitly listed for confirmation and their stale relations can be cleared", async () => {
  const native = await session(projectA), sessionId = native.getSessionId();
  const task = (await ok({ ...createRequest(), action: "createFromSession", cwd: undefined, sourceSessionId: sessionId })).task;
  await rm(native.getSessionFile());
  const snapshot = await preview(task, projectB);
  assert.deepEqual(snapshot.detachSessionIds, [sessionId]);
  assert.deepEqual((await ok(change(task, projectB, snapshot))).task.sessionIds, []);
  assert.equal((await ok({ action: "session-task", sessionId })).task, null);
});

test("preview identifies incompatible conversations and confirmation unlinks them atomically without deleting them", async () => {
  const native = await session(projectA), sessionId = native.getSessionId();
  const task = (await ok({ ...createRequest(), action: "createFromSession", cwd: undefined, sourceSessionId: sessionId })).task;
  const original = await board();
  const snapshot = await preview(task, projectB);
  assert.deepEqual(snapshot.detachSessionIds, [sessionId]);
  assert.deepEqual(await board(), original);
  const changed = (await ok(change(task, projectB, snapshot))).task;
  assert.equal(changed.project.cwd, projectB);
  assert.deepEqual(changed.sessionIds, []);
  const relation = await ok({ action: "task-picker", sessionId });
  assert.deepEqual(relation.relation, { sessionId, sourceTaskId: null, generation: 1, updateRevision: 0 });
  const sameProjectTask = (await ok(createRequest(projectA))).task;
  const available = await ok({ action: "sessions", id: sameProjectTask.id });
  assert.ok(available.candidates.some(s => s.id === sessionId), "conversation still exists in its original project");
});
