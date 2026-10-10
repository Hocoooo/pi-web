import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createJiti } from "jiti";
const agentDir = await mkdtemp(join(tmpdir(), "remove-http-")), old = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { GET, POST } = await jiti.import("./route.ts");
const { taskColumnRemovalDigest } = await jiti.import("../../../lib/task-store.ts");
test.after(async () => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; await rm(agentDir, { recursive: true, force: true }); });
const post = body => POST(new Request("http://localhost/api/tasks", { method: "POST", body: JSON.stringify(body) }));
test("actual HTTP exposes removal protections/conflicts/unavailable and same-lock authority without internal receipt", async () => {
  const id = randomUUID(); assert.equal((await post({ action: "create", id, title: "HTTP source", description: "", completionCriteria: "", cwd: null })).status, 200);
  const board = await (await GET()).json();
  const r = { action: "remove-column", columnId: "todo", targetColumnId: "done", expectedColumnsRevision: board.columnsRevision, expectedOrderRevision: board.orderRevision, expectedSourceDigest: board.columnRemovalDigests.todo, confirmCompletion: false, operationId: randomUUID() };
  assert.equal((await post(r)).status, 400); assert.equal((await post({ ...r, columnId: "done", targetColumnId: "review" })).status, 400);
  assert.equal((await post({ ...r, expectedSourceDigest: taskColumnRemovalDigest([], "todo"), confirmCompletion: true })).status, 409);
  r.confirmCompletion = true; const response = await post(r); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  const saved = await response.json(); assert.equal(saved.tasks[0].columnId, "done"); assert.equal(saved.columns.some(c => c.id === "todo"), false); assert.equal("columnRemovalReceipt" in saved, false);
  assert.deepEqual(await (await post(r)).json(), saved); assert.equal((await post({ ...r, operationId: randomUUID() })).status, 409);
  const file = join(agentDir, "tasks/board.json"), bytes = await readFile(file);
  await writeFile(file, "invalid"); assert.equal((await post(r)).status, 503); assert.equal(await readFile(file, "utf8"), "invalid"); await writeFile(file, bytes);
  assert.deepEqual(await (await GET()).json(), saved);
});

test("real HTTP removes 3500 and 50000-task legal stores with a task-count-independent bounded digest request", async () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const measurements = [];
  try {
    for (const count of [3500, 50000]) {
      const directory = join(agentDir, `capacity-${count}`); process.env.PI_CODING_AGENT_DIR = directory;
      assert.equal((await post({ action: "create", id: randomUUID(), title: "Synthetic", description: "", completionCriteria: "", cwd: null })).status, 200);
      const file = join(directory, "tasks/board.json"), document = JSON.parse(await readFile(file));
      const template = document.tasks[0];
      document.tasks = Array.from({ length: count }, (_, i) => ({ ...structuredClone(template), id: randomUUID(), title: `Synthetic ${i}`, revision: i % 5 + 1, archived: i % 2 === 0, archiveRevision: i % 2 === 0 ? 1 : 0 }));
      const target = { ...structuredClone(template), id: randomUUID(), columnId: "review" };
      document.tasks.splice(Math.floor(count / 2), 0, target); document.orderRevision = count + 1;
      await writeFile(file, JSON.stringify(document));
      const before = await readFile(file); assert.ok(before.length < 32 * 1024 * 1024);
      const board = await (await GET()).json(); assert.equal(board.tasks.length, count + 1);
      const r = { action: "remove-column", columnId: "todo", targetColumnId: "review", expectedColumnsRevision: board.columnsRevision, expectedOrderRevision: board.orderRevision,
        expectedSourceDigest: board.columnRemovalDigests.todo, confirmCompletion: false, operationId: randomUUID() };
      const bytes = Buffer.byteLength(JSON.stringify(r)); assert.ok(bytes < 512);
      const maximal = { ...r, columnId: randomUUID(), targetColumnId: randomUUID(), expectedColumnsRevision: Number.MAX_SAFE_INTEGER, expectedOrderRevision: Number.MAX_SAFE_INTEGER };
      assert.ok(Buffer.byteLength(JSON.stringify(maximal)) < 512, "all validated scalar widths are bounded independently of task count");
      const legacy = { ...r }; delete legacy.expectedSourceDigest;
      legacy.expectedTasks = board.tasks.filter(t => t.columnId === "todo").map(({ id, revision, archiveRevision }) => ({ id, revision, archiveRevision }));
      const legacyBytes = Buffer.byteLength(JSON.stringify(legacy)); assert.ok(legacyBytes > 256 * 1024);
      assert.equal((await post(legacy)).status, 413); assert.deepEqual(await readFile(file), before);
      assert.equal((await post({ ...r, targetColumnId: "done" })).status, 400, "large sets still require separate completion confirmation");
      assert.equal((await post({ ...r, expectedSourceDigest: taskColumnRemovalDigest(board.tasks.slice(1), "todo") })).status, 409, "partial ordered set cannot bypass scope confirmation");
      assert.deepEqual(await readFile(file), before);
      const response = await post(r); assert.equal(response.status, 200);
      const saved = await response.json();
      const sourceIds = board.tasks.filter(t => t.columnId === "todo").map(t => t.id);
      assert.deepEqual(saved.tasks.map(t => t.id), [target.id, ...sourceIds]);
      assert.ok(saved.tasks.every(t => t.columnId === "review"));
      assert.equal(saved.tasks.filter(t => t.archived).length, Math.ceil(count / 2));
      assert.equal(saved.orderRevision, board.orderRevision + 1); assert.equal(saved.columnsRevision, board.columnsRevision + 1);
      const stable = await readFile(file); assert.equal((await post(r)).status, 200); assert.deepEqual(await readFile(file), stable);
      assert.deepEqual(await (await GET()).json(), saved, "fresh store read preserves every migrated task");
      const stored = JSON.parse(stable); assert.equal("columnRemovalDigests" in stored, false, "digest metadata is response-only, not a schema migration");
      measurements.push({ sourceTasks: count, storeBytes: before.length, legacyRequestBytes: legacyBytes, requestBytes: bytes, status: response.status });
    }
  } finally { process.env.PI_CODING_AGENT_DIR = previous; }
  console.log("COLUMN_REMOVAL_CAPACITY", JSON.stringify(measurements));
});
