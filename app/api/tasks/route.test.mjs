import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createTaskTestJiti } from "../../../lib/__fixtures__/task-jiti.mjs";
const directory = await mkdtemp(path.join(os.tmpdir(), "pi-web-tasks-api-"));
const original = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = directory;
const jiti = createTaskTestJiti(import.meta.url);
const { GET, POST } = await jiti.import("./route.ts");
test.after(async () => {
  if (original === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = original;
  await rm(directory, { recursive: true, force: true });
});
const post = (body) => POST(new Request("http://localhost/api/tasks", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));
test("HTTP uses the same persistent operations and exposes failures, not success", async () => {
  const input = { action: "create", id: randomUUID(), title: "API task", description: "<img src=x onerror=alert(1)>", completionCriteria: "Confirm", cwd: null };
  const created = await post(input);
  assert.equal(created.status, 200);
  const { task } = await created.json();
  assert.equal((await (await post(input)).json()).task.id, task.id);
  const board = await GET();
  assert.equal(board.headers.get("cache-control"), "no-store");
  assert.equal((await board.json()).tasks[0].description, input.description);
  const move = { action: "move", id: task.id, columnId: "done", expectedRevision: 1, expectedOrderRevision: (await (await GET()).json()).orderRevision, operationId: randomUUID(), position: { edge: "end" } };
  const moved = await post(move); assert.equal(moved.status, 200);
  const snapshot = await moved.json(); assert.equal(snapshot.board.tasks[0].columnId, "done");
  assert.equal("moveReceipt" in snapshot.task, false); assert.equal("moveReceipt" in snapshot.board.tasks[0], false);
  assert.equal((await post(move)).status, 200);
  assert.equal((await post({ ...move, operationId: randomUUID(), columnId: "blocked" })).status, 409);
  assert.equal((await post({ ...move, id: randomUUID() })).status, 404);
  assert.equal((await post("{" )).status, 400);
  assert.equal((await post({ ...input, id: "../../sessions" })).status, 400);
  assert.equal((await post("x".repeat(300_000))).status, 413);
  const details = { action: "edit", id: task.id, expectedRevision: 2, title: "Edited API task", description: "<script>plain text</script>", completionCriteria: "User checks", priority: 3, labels: [" api ", "api"] };
  const edited = await post(details);
  assert.equal(edited.status, 200);
  const saved = (await edited.json()).task;
  assert.equal(saved.columnId, "done"); assert.equal(saved.project, null);
  assert.deepEqual(saved.labels, ["api"]); assert.equal(saved.priority, 3);
  assert.ok(Date.parse(saved.updatedAt) > Date.parse(task.updatedAt));
  assert.equal("creationFingerprint" in saved, false);
  assert.equal((await post(details)).status, 409);
  assert.equal((await post({ ...details, expectedRevision: saved.revision, columnId: "todo" })).status, 400);
  assert.equal((await post({ ...details, expectedRevision: saved.revision, priority: "urgent" })).status, 400);
  assert.equal((await post({ ...details, id: randomUUID() })).status, 404);
  assert.deepEqual((await (await GET()).json()).tasks, [saved]);
  // Original create retry returns the current edited record, not an extra task.
  assert.deepEqual((await (await post(input)).json()).task, saved);
  const beforeColumns = await (await GET()).json();
  const columnsRequest = { action: "set-columns", expectedColumnsRevision: beforeColumns.columnsRevision,
    columns: [...beforeColumns.columns].reverse().map(({ id, label }) => ({ id, label: id === "done" ? "Still completion" : label })) };
  const configured = await post(columnsRequest); assert.equal(configured.status, 200);
  const configuredBoard = await configured.json(); assert.equal(configuredBoard.columnsRevision, beforeColumns.columnsRevision + 1);
  assert.equal(configuredBoard.columns[0].isCompletion, true); assert.deepEqual(configuredBoard.tasks, beforeColumns.tasks);
  assert.equal(configuredBoard.orderRevision, beforeColumns.orderRevision);
  assert.equal((await post(columnsRequest)).status, 409);
  assert.equal((await post({ ...columnsRequest, expectedColumnsRevision: configuredBoard.columnsRevision,
    columns: configuredBoard.columns })).status, 400); // derived completion flags cannot be submitted
  assert.equal((await post({ ...move, operationId: randomUUID(), columnId: randomUUID() })).status, 400);
  assert.equal((await (await GET()).json()).columns[0].id, "done");
  const beforeViews = await (await GET()).json();
  const viewRequest = { action: "save-view", id: randomUUID(), operationId: randomUUID(), expectedViewsRevision: beforeViews.viewsRevision,
    name: "API focus", sort: "updated", filter: { text: "Edited", project: { key: null }, columnIds: ["done"], priorities: [3], labels: ["api"], activity: "idle" } };
  const viewReply = await post(viewRequest); assert.equal(viewReply.status, 200);
  assert.equal(viewReply.headers.get("cache-control"), "no-store");
  const viewsBoard = await viewReply.json(); assert.equal(viewsBoard.savedViews.length, 1); assert.equal("receipt" in viewsBoard.savedViews[0], false);
  assert.deepEqual(viewsBoard.tasks, beforeViews.tasks); assert.equal(viewsBoard.orderRevision, beforeViews.orderRevision);
  assert.deepEqual(await (await post(viewRequest)).json(), viewsBoard);
  assert.equal((await post({ ...viewRequest, operationId: randomUUID(), id: randomUUID(), name: "Stale" })).status, 409);
  assert.equal((await post({ ...viewRequest, expectedViewsRevision: viewsBoard.viewsRevision, filter: { ...viewRequest.filter, columnIds: [randomUUID()] } })).status, 409); // same operation ID, different request
  assert.equal((await post({ ...viewRequest, operationId: randomUUID(), expectedViewsRevision: viewsBoard.viewsRevision, filter: { ...viewRequest.filter, columnIds: [randomUUID()] } })).status, 400);
  assert.deepEqual(await (await GET()).json(), viewsBoard);
  await writeFile(path.join(directory, "tasks", "board.json"), "broken");
  const failed = await GET();
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).code, "storage-unavailable");
});
