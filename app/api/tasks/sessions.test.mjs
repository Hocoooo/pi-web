import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createTaskTestJiti } from "../../../lib/__fixtures__/task-jiti.mjs";
const agentDir = await mkdtemp(join(tmpdir(), "pi-web-task-links-api-"));
const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
const cwd = join(agentDir, "chat-workspace"), sessionDir = join(agentDir, "sessions", "chat"); await mkdir(cwd); await mkdir(sessionDir, { recursive: true });
const source = SessionManager.create(cwd, sessionDir);
source.appendMessage({ role: "user", content: "API fixture only", timestamp: Date.now() });
const extra = SessionManager.create(cwd, sessionDir); extra.appendMessage({ role: "user", content: "second API fixture", timestamp: Date.now() });
const jiti = createTaskTestJiti(import.meta.url);
const { GET, POST } = await jiti.import("./route.ts");
test.after(async () => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(agentDir, { recursive: true, force: true }); });
const post = (input) => POST(new Request("http://localhost/api/tasks", { method: "POST", body: JSON.stringify(input) }));
test("API source creates, metadata, atomic link/no-op/conflict/deletion and field guards share taskOperation/store", async () => {
  const create = { action: "createFromSession", id: randomUUID(), title: "API source", description: "", completionCriteria: "", sourceSessionId: source.getSessionId() };
  const response = await post(create); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  const result = await response.json(); assert.deepEqual(result.task.sessionIds, [source.getSessionId()]); assert.equal(result.task.project, null);
  assert.equal((await post({ ...create, cwd })).status, 400);
  assert.equal((await post({ ...create, id: randomUUID() })).status, 409);
  const info = await post({ action: "sessions", id: create.id }); assert.equal(info.status, 200);
  const data = await info.json(); assert.deepEqual(data.linked.map((s) => s.id), [source.getSessionId()]); assert.deepEqual(data.candidates.map((s) => s.id), [extra.getSessionId()]);
  assert.equal(JSON.stringify(data).includes("API fixture only"), false); assert.equal(JSON.stringify(data).includes("chat-workspace"), false);
  const link = { action: "link", id: create.id, expectedRevision: 1, sessionIds: [extra.getSessionId(), randomUUID()] };
  const file = join(agentDir, "tasks", "board.json"), before = await readFile(file, "utf8");
  assert.equal((await post(link)).status, 404); assert.equal(await readFile(file, "utf8"), before);
  assert.equal((await post({ ...link, sessionIds: ["../sessions"] })).status, 400);
  assert.equal((await post({ ...link, sessionIds: [extra.getSessionId()], expectedRevision: 2 })).status, 409);
  const legal = { ...link, sessionIds: [extra.getSessionId()] };
  assert.equal((await post(legal)).status, 200);
  const saved = await readFile(file, "utf8"); assert.equal((await post(legal)).status, 200); assert.equal(await readFile(file, "utf8"), saved);
  assert.deepEqual((await (await GET()).json()).tasks[0].sessionIds, [source.getSessionId(), extra.getSessionId()]);
  await unlink(extra.getSessionFile()); assert.equal((await post(legal)).status, 404); assert.equal(await readFile(file, "utf8"), saved);
  const missing = await (await post({ action: "sessions", id: create.id })).json(); assert.equal(missing.linked[1].missing, true);
  assert.equal((await post({ action: "sessions", id: randomUUID() })).status, 404);
});
test("HTTP unlink of a deleted conversation keeps relation CAS and exact retries without recreating native history", async () => {
  const native = SessionManager.create(cwd, sessionDir);
  native.appendMessage({ role: "user", content: "Deleted conversation fixture", timestamp: Date.now() });
  const sessionId = native.getSessionId();
  const create = { action: "createFromSession", id: randomUUID(), title: "Missing conversation owner", description: "", completionCriteria: "", sourceSessionId: sessionId };
  const task = await (await post(create)).json();
  const target = await (await post({ action: "create", id: randomUUID(), title: "Other owner", description: "", completionCriteria: "", cwd: null })).json();
  const relation = (sourceTaskId, targetTaskId, expectedGeneration) => ({ action: "change-session-relation", sessionId, sourceTaskId,
    targetTaskId, expectedGeneration, expectedUpdateRevision: 0, operationId: randomUUID() });
  assert.equal((await post(relation(task.task.id, target.task.id, 0))).status, 200);
  assert.equal((await post(relation(target.task.id, task.task.id, 1))).status, 200);
  const live = await (await post({ action: "sessions", id: task.task.id })).json();
  const request = relation(task.task.id, null, live.linked[0].relationGeneration);
  const before = await (await GET()).json();
  await unlink(native.getSessionFile());
  const missing = await (await post({ action: "sessions", id: task.task.id })).json();
  assert.deepEqual(missing.linked, [{ id: sessionId, missing: true, running: false, relationGeneration: 2, updateRevision: 0 }]);
  request.expectedGeneration = missing.linked[0].relationGeneration;
  request.expectedUpdateRevision = missing.linked[0].updateRevision;
  // Missing sessions may be detached, but cannot be linked/reassigned or bypass CAS.
  for (const [input, status] of [
    [{ ...request, targetTaskId: target.task.id }, 404],
    [{ ...request, expectedGeneration: 1 }, 409],
    [{ ...request, expectedUpdateRevision: 1 }, 409],
    [{ ...request, sourceTaskId: target.task.id }, 409],
  ]) {
    assert.equal((await post(input)).status, status);
    assert.deepEqual(await (await GET()).json(), before);
  }
  const response = await post(request);
  assert.equal(response.status, 200, await response.clone().text());
  const saved = await response.json();
  const owner = saved.tasks.find(item => item.id === task.task.id);
  assert.deepEqual(owner.sessionIds, []);
  assert.equal(owner.revision, before.tasks.find(item => item.id === task.task.id).revision + 1);
  const detail = await (await post({ action: "sessions", id: task.task.id })).json();
  assert.deepEqual(detail.linked, []);
  assert.deepEqual(await (await post({ action: "session-task", sessionId })).json(), { task: null });
  assert.deepEqual(await (await post(request)).json(), saved, "a lost response is confirmed without a second unlink");
  assert.equal((await post({ ...request, targetTaskId: target.task.id })).status, 409, "an operation ID cannot be repurposed");
  await assert.rejects(readFile(native.getSessionFile()), { code: "ENOENT" });
});
test("existing-conversation candidates include main/fork sessions but not subagent descendants", async () => {
  const { SUBAGENT_META_TYPE } = await jiti.import("../../../lib/subagents.ts");
  const { listSessionsIncremental } = await jiti.import("../../../lib/session-list-scanner.ts");
  const root = SessionManager.create(cwd, sessionDir);
  root.appendMessage({ role: "user", content: "Main conversation fixture", timestamp: Date.now() });
  const fork = SessionManager.create(cwd, sessionDir, { parentSession: root.getSessionFile() });
  fork.appendMessage({ role: "user", content: "Independent fork fixture", timestamp: Date.now() });
  const child = SessionManager.create(cwd, sessionDir, { parentSession: root.getSessionFile() });
  child.appendCustomEntry(SUBAGENT_META_TYPE, { version: 1, parentSessionId: root.getSessionId(), parentSessionPath: root.getSessionFile(), profile: "explore" });
  child.appendMessage({ role: "user", content: "Child fixture", timestamp: Date.now() });
  const nested = SessionManager.create(cwd, sessionDir, { parentSession: child.getSessionFile() });
  nested.appendCustomEntry(SUBAGENT_META_TYPE, { version: 1, parentSessionId: child.getSessionId(), parentSessionPath: child.getSessionFile(), profile: "explore" });
  nested.appendMessage({ role: "user", content: "Nested child fixture", timestamp: Date.now() });
  const task = (await (await post({ action: "create", id: randomUUID(), title: "Main sessions only", description: "", completionCriteria: "", cwd: null })).json()).task;
  const file = join(agentDir, "tasks", "board.json"), before = await readFile(file);
  const histories = await Promise.all([root, fork, child, nested].map(manager => readFile(manager.getSessionFile())));
  for (const cached of [false, true]) {
    if (cached) await listSessionsIncremental();
    const response = await post({ action: "sessions", id: task.id });
    assert.equal(response.status, 200);
    const data = await response.json(), ids = data.candidates.map(session => session.id);
    assert.ok(ids.includes(root.getSessionId()), "main conversations remain candidates");
    assert.ok(ids.includes(fork.getSessionId()), "a parentSession header alone must not hide an independent fork");
    assert.equal(ids.includes(child.getSessionId()), false, "subagent sessions must not be candidates");
    assert.equal(ids.includes(nested.getSessionId()), false, "nested subagent sessions must not be candidates");
    assert.equal(JSON.stringify(data).includes("Child fixture"), false);
    assert.deepEqual(await readFile(file), before, "listing is read-only");
  }
  for (const rejected of [child, nested]) {
    const response = await post({ action: "link", id: task.id, expectedRevision: task.revision, sessionIds: [root.getSessionId(), rejected.getSessionId()] });
    assert.equal(response.status, 400, "direct requests cannot bypass the main-session candidate policy");
    assert.deepEqual(await readFile(file), before, "a mixed batch must not partially link the main session");
  }
  const linked = await post({ action: "link", id: task.id, expectedRevision: task.revision, sessionIds: [root.getSessionId(), fork.getSessionId()] });
  assert.equal(linked.status, 200);
  assert.deepEqual((await linked.json()).task.sessionIds, [root.getSessionId(), fork.getSessionId()]);
  assert.deepEqual(await Promise.all([root, fork, child, nested].map(manager => readFile(manager.getSessionFile()))), histories);
});

test("session-task is minimal read-only ownership metadata, including archived/missing native sessions", async () => {
  const board = await (await GET()).json(), task = board.tasks[0];
  assert.equal((await post({ action: "set-archive", id: task.id, archived: true, expectedArchiveRevision: task.archiveRevision, operationId: randomUUID() })).status, 200);
  const file = join(agentDir, "tasks/board.json"), before = await readFile(file);
  // The extra session file was removed above. Lookup is deliberately board-only.
  for (const sessionId of [source.getSessionId(), extra.getSessionId()]) {
    const response = await post({ action: "session-task", sessionId });
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { task: { id: task.id, title: task.title, archived: true } });
  }
  assert.deepEqual(await (await post({ action: "session-task", sessionId: "unowned-native-id" })).json(), { task: null });
  for (const sessionId of [null, "", "../escape", "/absolute", "a".repeat(201)]) {
    assert.equal((await post({ action: "session-task", sessionId })).status, 400);
  }
  assert.equal((await post({ action: "session-task", sessionId: source.getSessionId(), includeContext: true })).status, 400);
  assert.deepEqual(await readFile(file), before);
});
