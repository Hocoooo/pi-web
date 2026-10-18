import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createTaskTestJiti } from "../../../lib/__fixtures__/task-jiti.mjs";

const agentDir = await mkdtemp(join(tmpdir(), "pi-web-task-picker-api-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const chatCwd = join(agentDir, "chat-workspace"), projectCwd = join(agentDir, "project");
await mkdir(chatCwd); await mkdir(projectCwd);
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
async function create(title, cwd = null) {
  return (await ok({ action: "create", id: randomUUID(), title, description: "Private task description", completionCriteria: "Private completion details", cwd })).task;
}

async function session(cwd) {
  const directory = join(agentDir, "sessions", randomUUID());
  await mkdir(directory, { recursive: true });
  const native = SessionManager.create(cwd, directory);
  native.appendMessage({ role: "user", content: "Private native conversation", timestamp: Date.now() });
  return native;
}

let chatTask, archivedTask, projectTask;
const picker = target => ok({ action: "task-picker", ...target });
async function rejected(input, status, code) {
  const response = await post(input);
  assert.equal(response.status, status, await response.clone().text());
  assert.equal((await response.json()).code, code);
}
test("cwd picker returns only same-project task metadata, including archived tasks and saved column names", async () => {
  chatTask = await create("Chat task");
  archivedTask = await create("Archived chat task");
  projectTask = await create("Project task", projectCwd);
  await ok({ action: "set-archive", id: archivedTask.id, archived: true, expectedArchiveRevision: 0, operationId: randomUUID() });
  const board = await (await GET()).json();
  await ok({ action: "set-columns", expectedColumnsRevision: board.columnsRevision,
    columns: board.columns.map(({ id, label }) => ({ id, label: id === "todo" ? "Ready for work" : label })) });
  const before = await (await GET()).json();
  const response = await post({ action: "task-picker", cwd: null });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { tasks: [
    { id: chatTask.id, title: "Chat task", archived: false, revision: 1, status: "Ready for work" },
    { id: archivedTask.id, title: "Archived chat task", archived: true, revision: 1, status: "Ready for work" },
  ], relation: null });
  assert.deepEqual(await (await GET()).json(), before);
});

test("session picker derives authoritative project scope and returns an unowned relation snapshot", async () => {
  const native = await session(projectCwd);
  const response = await post({ action: "task-picker", sessionId: native.getSessionId() });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    tasks: [{ id: projectTask.id, title: "Project task", archived: false, revision: 1, status: "Ready for work" }],
    relation: { sessionId: native.getSessionId(), sourceTaskId: null, generation: 0, updateRevision: 0 },
  });
});

test("picker rejects ambiguous or extra scope fields and missing native sessions instead of reporting no task", async () => {
  const native = await session(chatCwd), sessionId = native.getSessionId();
  for (const fields of [
    {}, { cwd: null, sessionId }, { cwd: null, includeContext: true }, { sessionId, projectKey: "spoof" },
    { cwd: "" }, { cwd: 7 }, { cwd: "x".repeat(4097) }, { cwd: join(agentDir, "missing-directory") },
    ...[null, "", "../escape", "/absolute", "a".repeat(201), 7].map(sessionId => ({ sessionId })),
  ]) {
    const response = await post({ action: "task-picker", ...fields });
    assert.equal(response.status, 400, JSON.stringify(fields));
    assert.equal((await response.json()).code, "invalid-input");
  }
  await ok({ action: "link", id: chatTask.id, expectedRevision: 1, sessionIds: [sessionId] });
  assert.equal((await picker({ sessionId })).relation.sourceTaskId, chatTask.id);
  await unlink(native.getSessionFile());
  for (const id of [sessionId, randomUUID()]) {
    const response = await post({ action: "task-picker", sessionId: id });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, "not-found");
  }
});

test("picker snapshots drive link, reassignment, unlink and relink with conflicts and precise retries", async () => {
  const cwd = join(agentDir, "relation-project"); await mkdir(cwd);
  const first = await create("First owner", cwd), second = await create("Archived owner", cwd);
  await ok({ action: "set-archive", id: second.id, archived: true, expectedArchiveRevision: 0, operationId: randomUUID() });
  const blank = await picker({ cwd });
  assert.equal(blank.relation, null);
  assert.deepEqual(blank.tasks.map(task => task.id), [first.id, second.id]);
  const native = await session(cwd), sessionId = native.getSessionId();
  assert.deepEqual((await picker({ sessionId })).relation, { sessionId, sourceTaskId: null, generation: 0, updateRevision: 0 });
  const link = { action: "link", id: first.id, expectedRevision: blank.tasks[0].revision, sessionIds: [sessionId] };
  await ok({ action: "edit", id: first.id, expectedRevision: 1, title: "First owner edited", description: "", completionCriteria: "", priority: 1, labels: [] });
  await rejected(link, 409, "conflict");
  const refreshed = await picker({ sessionId });
  assert.equal(refreshed.relation.sourceTaskId, null);
  assert.equal(refreshed.tasks[0].revision, 2);
  const refreshedLink = { ...link, expectedRevision: refreshed.tasks[0].revision };
  await ok(refreshedLink);
  const linked = await picker({ sessionId });
  assert.deepEqual(linked.relation, { sessionId, sourceTaskId: first.id, generation: 0, updateRevision: 0 });
  assert.equal(linked.tasks[0].revision, 3);
  await ok(refreshedLink);
  assert.deepEqual(await picker({ sessionId }), linked);
  await rejected({ action: "link", id: second.id, expectedRevision: linked.tasks[1].revision, sessionIds: [sessionId] }, 409, "conflict");
  const change = { action: "change-session-relation", sessionId, sourceTaskId: linked.relation.sourceTaskId,
    targetTaskId: second.id, expectedGeneration: linked.relation.generation,
    expectedUpdateRevision: linked.relation.updateRevision, operationId: randomUUID() };
  await rejected({ ...change, expectedUpdateRevision: 1 }, 409, "conflict");
  await rejected({ ...change, targetTaskId: projectTask.id }, 400, "invalid-input");
  assert.deepEqual(await picker({ sessionId }), linked);
  await ok(change);
  const reassigned = await picker({ sessionId });
  assert.deepEqual(reassigned, { tasks: [
    { id: first.id, title: "First owner edited", archived: false, revision: 4, status: "Ready for work" },
    { id: second.id, title: "Archived owner", archived: true, revision: 2, status: "Ready for work" },
  ], relation: { sessionId, sourceTaskId: second.id, generation: 1, updateRevision: 0 } });
  await ok(change);
  assert.deepEqual(await picker({ sessionId }), reassigned);
  await rejected({ ...change, targetTaskId: null }, 409, "conflict");
  await rejected({ ...change, operationId: randomUUID() }, 409, "conflict");
  const unlink = { ...change, sourceTaskId: reassigned.relation.sourceTaskId, targetTaskId: null,
    expectedGeneration: reassigned.relation.generation, expectedUpdateRevision: reassigned.relation.updateRevision, operationId: randomUUID() };
  await ok(unlink);
  const unlinked = await picker({ sessionId });
  assert.deepEqual(unlinked.relation, { sessionId, sourceTaskId: null, generation: 2, updateRevision: 0 });
  await ok(unlink);
  assert.deepEqual(await picker({ sessionId }), unlinked);
  await ok({ ...link, expectedRevision: unlinked.tasks[0].revision });
  const relinked = await picker({ sessionId });
  assert.deepEqual(relinked.relation, { sessionId, sourceTaskId: first.id, generation: 2, updateRevision: 0 });
  assert.equal(relinked.tasks[0].revision, 5);
  await rejected(unlink, 409, "conflict");
  assert.deepEqual(await picker({ sessionId }), relinked);
});

test("cwd and native chat scopes agree, and status follows custom and unnamed built-in columns", async () => {
  const chat = await session(chatCwd);
  const noProject = await picker({ cwd: null });
  assert.deepEqual(await picker({ cwd: chatCwd }), noProject);
  const chatResult = await picker({ sessionId: chat.getSessionId() });
  assert.deepEqual(chatResult.tasks, noProject.tasks);
  assert.deepEqual(chatResult.relation, { sessionId: chat.getSessionId(), sourceTaskId: null, generation: 0, updateRevision: 0 });
  const board = await (await GET()).json(), customColumn = randomUUID();
  await ok({ action: "set-columns", expectedColumnsRevision: board.columnsRevision,
    columns: [...board.columns.map(({ id, label }) => ({ id, label })), { id: customColumn, label: "Waiting on review" }] });
  await ok({ action: "move", id: projectTask.id, columnId: customColumn, expectedRevision: 1,
    expectedOrderRevision: board.orderRevision, operationId: randomUUID(), position: { edge: "end" } });
  const custom = await picker({ cwd: projectCwd });
  assert.deepEqual(custom, { tasks: [
    { id: projectTask.id, title: "Project task", archived: false, revision: 2, status: "Waiting on review" },
  ], relation: null });
  const movedBoard = await (await GET()).json();
  await ok({ action: "move", id: projectTask.id, columnId: "review", expectedRevision: 2,
    expectedOrderRevision: movedBoard.orderRevision, operationId: randomUUID(), position: { edge: "end" } });
  assert.deepEqual(await picker({ cwd: projectCwd }), { tasks: [
    { id: projectTask.id, title: "Project task", archived: false, revision: 3, status: "review", statusKey: "review" },
  ], relation: null });
});
