// Main-only R1/R2 regressions: original POST + actual SDK runtime, no provider/network.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import net from "node:net";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { startRpcSession } = await jiti.import("./rpc-manager.ts");
const { taskOperation } = await jiti.import("./task-operations.ts");
const { POST } = await jiti.import("../app/api/agent/[id]/route.ts");
const { sendAgentCommand } = await jiti.import("./agent-client.ts");
const assistant = { role: "assistant", content: [{ type: "text", text: "completed fixture" }], api: "openai-completions", provider: "fixture", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "r11-"));
  assert.notEqual(spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root }).status, 0);
  const prior = process.env.PI_CODING_AGENT_DIR, fetch = globalThis.fetch, storage = globalThis.sessionStorage;
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function () { throw new Error("Review fixture forbids network sockets"); };
  process.env.PI_CODING_AGENT_DIR = root;
  const values = new Map();
  globalThis.sessionStorage = { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: (k) => values.delete(k) };
  t.after(async () => {
    for (const w of globalThis.__piSessions?.values() ?? []) await w.shutdown();
    globalThis.fetch = fetch; net.Socket.prototype.connect = connect;
    if (storage === undefined) delete globalThis.sessionStorage; else globalThis.sessionStorage = storage;
    if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior;
    await rm(root, { recursive: true, force: true });
  });
  const cwd = join(root, "chat-workspace"); await mkdir(cwd);
  const manager = SessionManager.create(cwd);
  manager.appendMessage({ role: "user", content: "first", timestamp: Date.now() }); manager.appendMessage(assistant);
  const entry = manager.appendMessage({ role: "user", content: "second", timestamp: Date.now() }); const leaf = manager.appendMessage(assistant);
  const id = manager.getSessionId();
  const task = (await taskOperation({ action: "createFromSession", id: randomUUID(), title: "Review copy", description: "", completionCriteria: "", sourceSessionId: id }, { agentDir: root })).task;
  await startRpcSession(id, manager.getSessionFile());
  const before = await readFile(manager.getSessionFile());
  const post = (command) => POST(new Request(`http://localhost/api/agent/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command) }), { params: Promise.resolve({ id }) });
  return { root, manager, id, entry, leaf, task, before, post, values };
}

for (const type of ["fork", "clone", "fork_branch"]) for (const [label, responseBody] of [
  ["200 empty", ""], ["200 invalid JSON", "{"], ["success missing data", '{"success":true}'],
  ["success invalid data", '{"success":true,"data":{"cancelled":false,"newSessionId":"../invalid"}}'],
  ["missing success envelope", '{"data":{"cancelled":false,"newSessionId":"child"}}'],
]) test(`R1 ${type} ${label}: committed SDK copy rejects, retains UUID through reload, retry confirms one child`, async (t) => {
  const f = await fixture(t), bodies = []; let first = true, committed;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body); bodies.push(body); const res = await f.post(body); assert.equal(res.status, 200);
    if (first) { first = false; committed = (await res.json()).data; return new Response(responseBody, { status: 200 }); }
    return res;
  };
  const command = { type, ...(type === "clone" ? { leafId: f.leaf } : { entryId: f.entry }) };
  await assert.rejects(sendAgentCommand(f.id, command), (e) => e.code === "session_copy_unconfirmed" && /not confirmed/i.test(e.message));
  assert.equal(f.values.size, 1);
  assert.equal((await SessionManager.listAll()).length, 2, "SDK already committed the first child");
  const reloaded = await createJiti(import.meta.url, { moduleCache: false }).import("./agent-client.ts");
  assert.deepEqual(await reloaded.sendAgentCommand(f.id, command), committed);
  assert.equal(bodies[0].operationId, bodies[1].operationId); assert.equal(f.values.size, 0);
  const board = await taskOperation({ action: "list" }, { agentDir: f.root });
  assert.deepEqual(board.tasks[0].sessionIds, [f.id, committed.newSessionId]); assert.equal(board.tasks[0].revision, f.task.revision + 1);
  assert.equal((await SessionManager.listAll()).length, 2);
  assert.deepEqual(await readFile(f.manager.getSessionFile()), f.before);
});

for (const type of ["fork", "clone", "fork_branch"]) test(`R2 ${type}: unknown intent stays refused; documented fresh empty tab permits an explicit separate attempt`, async (t) => {
  const f = await fixture(t), bodies = [], command = { type, ...(type === "clone" ? { leafId: f.leaf } : { entryId: f.entry }) };
  const original = SessionManager.prototype.createBranchedSession;
  SessionManager.prototype.createBranchedSession = function () { throw new Error("SDK outcome cannot be confirmed"); };
  globalThis.fetch = async (_url, init) => { const body = JSON.parse(init.body); bodies.push(body); return f.post(body); };
  try { await assert.rejects(sendAgentCommand(f.id, command), /not confirmed/); }
  finally { SessionManager.prototype.createBranchedSession = original; }
  await assert.rejects(sendAgentCommand(f.id, command), (e) => /outcome is unknown/.test(e.message) && /new empty tab/i.test(e.message) && /duplicate/i.test(e.message) && /reload/i.test(e.message));
  assert.equal((await SessionManager.listAll()).length, 1, "User inspection sees no child in this controlled fixture");
  // A tab opened with the browser + button has no opener and no inherited sessionStorage.
  // Separate module + empty storage models that documented manual action, NOT automatic recovery.
  const oldValues = f.values;
  const freshValues = new Map(); globalThis.sessionStorage = { getItem: (k) => freshValues.get(k) ?? null, setItem: (k, v) => freshValues.set(k, v), removeItem: (k) => freshValues.delete(k) };
  const freshTab = await createJiti(import.meta.url, { moduleCache: false }).import("./agent-client.ts");
  const child = await freshTab.sendAgentCommand(f.id, command);
  assert.notEqual(bodies[0].operationId, bodies.at(-1).operationId); assert.equal(oldValues.size, 1);
  const doc = JSON.parse(await readFile(join(f.root, "tasks", "board.json")));
  assert.equal(doc.sessionCopies.find((r) => r.operationId === bodies[0].operationId).status, "prepared");
  assert.equal(doc.sessionCopies.find((r) => r.operationId === bodies.at(-1).operationId).newSessionId, child.newSessionId);
  assert.deepEqual(doc.tasks[0].sessionIds, [f.id, child.newSessionId]); assert.equal((await SessionManager.listAll()).length, 2);
  assert.equal((await f.post(bodies[0])).status, 500, "Old intent is not deleted or repaired by guessing history");
});
