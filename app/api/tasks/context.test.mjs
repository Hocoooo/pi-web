import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createJiti } from "jiti";
const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-web-context-api-"));
const original = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
const { GET, POST } = await createJiti(import.meta.url, { alias: { "@": process.cwd() } }).import("./route.ts");
test.after(async () => {
  if (original === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = original;
  await rm(agentDir, { recursive: true, force: true });
});
const post = (body) => POST(new Request("http://localhost/api/tasks", { method: "POST", body: JSON.stringify(body) }));
test("API confirmation/restore use the same locked store, scope guards, exact receipts and no-store authority", async () => {
  const create = { action: "create", id: randomUUID(), title: "API knowledge", description: "Original", completionCriteria: "Checked", cwd: null };
  const initial = await (await post(create)).json();
  const request = { action: "publish-context", id: create.id, expectedCurrentVersionId: null, operationId: randomUUID(), content: { goal: "**Goal**", decisions: "No tools", progress: "", nextSteps: "User decides" } };
  const response = await post(request); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  const one = await response.json(); assert.equal(one.task.revision, initial.task.revision); assert.equal(one.task.columnId, "todo");
  assert.equal(one.task.sharedContext.versions.length, 1); assert.equal("receipt" in one.task.sharedContext.versions[0], false);
  assert.equal("creationFingerprint" in one.task, false); assert.equal("moveReceipt" in one.task, false);
  assert.deepEqual(await (await post(request)).json(), one);
  assert.equal((await post({ ...request, operationId: randomUUID() })).status, 409);
  assert.equal((await post({ ...request, id: randomUUID() })).status, 404);
  assert.equal((await post({ ...request, source: { kind: "ai" } })).status, 400);
  assert.equal((await post({ ...request, id: "../../files" })).status, 400);
  const restore = { action: "restore-context", id: create.id, expectedCurrentVersionId: one.task.sharedContext.currentVersionId, operationId: randomUUID(), versionId: one.task.sharedContext.currentVersionId };
  const restoredResponse = await post(restore); assert.equal(restoredResponse.status, 200);
  const restored = await restoredResponse.json(); assert.equal(restored.task.sharedContext.versions.length, 2);
  assert.deepEqual(restored.task.sharedContext.versions[1].source, { kind: "restore", versionId: restore.versionId });
  assert.deepEqual(await (await post(restore)).json(), restored);
  assert.deepEqual(await (await GET()).json(), restored.board);
  assert.equal((await post({ ...restore, expectedCurrentVersionId: restored.task.sharedContext.currentVersionId, operationId: randomUUID(), versionId: randomUUID() })).status, 404);
});
test("HTTP real storage failure is 503 with unchanged published versions", { skip: process.platform === "win32" ? "POSIX permissions only" : false }, async () => {
  const board = await (await GET()).json(), task = board.tasks[0], directory = path.join(agentDir, "tasks"), file = path.join(directory, "board.json");
  const bytes = await readFile(file, "utf8"); await chmod(directory, 0o500);
  try {
    const failed = await post({ action: "publish-context", id: task.id, expectedCurrentVersionId: task.sharedContext.currentVersionId, operationId: randomUUID(), content: { goal: "failed", decisions: "", progress: "", nextSteps: "" } });
    assert.equal(failed.status, 503); assert.equal((await failed.json()).code, "storage-unavailable"); assert.equal(await readFile(file, "utf8"), bytes);
  } finally { await chmod(directory, 0o700); }
  assert.deepEqual(await (await GET()).json(), board);
});
