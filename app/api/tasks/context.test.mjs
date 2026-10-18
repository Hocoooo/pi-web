import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createJiti } from "jiti";
const agentDir = await mkdtemp(path.join(os.tmpdir(), "task-context-api-"));
const original = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
const { GET, POST } = await createJiti(import.meta.url, { alias: { "@": process.cwd() } }).import("./route.ts");
test.after(async () => {
  if (original === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = original;
  await rm(agentDir, { recursive: true, force: true });
});
const post = body => POST(new Request("http://localhost/api/tasks", { method: "POST", body: JSON.stringify(body) }));
const actions = ["publish-context", "restore-context", "prepare-start", "admit-start", "context-update-state", "accept-context-update", "clear-context-update", "pending-context-update", "complete-context-update"];
test("public and formerly internal shared-context requests fail clearly without creating storage", async () => {
  for (const action of actions) {
    const response = await post({ action, id: randomUUID(), operationId: randomUUID(), sessionId: randomUUID() });
    assert.equal(response.status, 400); assert.equal(response.headers.get("cache-control"), "no-store");
    const error = await response.json(); assert.equal(error.code, "invalid-input"); assert.match(error.error, /suspended/);
  }
  await assert.rejects(access(path.join(agentDir, "tasks")), { code: "ENOENT" });
});
test("suspension does not migrate legacy storage or depend on store availability; ordinary CRUD remains available", async () => {
  const response = await post({ action: "create", id: randomUUID(), title: "Managed task", description: "", completionCriteria: "", cwd: null });
  assert.equal(response.status, 200);
  const file = path.join(agentDir, "tasks/board.json"), document = JSON.parse(await readFile(file, "utf8"));
  document.version = 6; delete document.sessionRelations;
  const bytes = JSON.stringify(document); await writeFile(file, bytes);
  for (const action of actions) {
    assert.match((await (await post({ action })).json()).error, /suspended/);
    assert.equal(await readFile(file, "utf8"), bytes);
  }
  assert.equal((await GET()).status, 200, "legacy board reading still works");
  await writeFile(file, "unavailable task store");
  assert.equal((await post({ action: "publish-context" })).status, 400);
  assert.equal(await readFile(file, "utf8"), "unavailable task store");
  assert.equal((await GET()).status, 503, "storage errors remain explicit for management reads");
});
