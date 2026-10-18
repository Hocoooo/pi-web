import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const agentDir = await mkdtemp(join(tmpdir(), "task-summary-api-"));
const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
const { POST } = await createJiti(import.meta.url, { alias: { "@": process.cwd() } }).import("./route.ts");
test.after(async () => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
  await rm(agentDir, { recursive: true, force: true });
});
test("all summary requests are suspended before history, model or storage access", async () => {
  for (const action of ["summary-options", "summary-source", "summary-generate", "summary-cancel"]) {
    const response = await POST(new Request("http://localhost/api/tasks", { method: "POST", body: JSON.stringify({ action }) }));
    assert.equal(response.status, 400); assert.equal(response.headers.get("cache-control"), "no-store");
    const error = await response.json(); assert.equal(error.code, "invalid-input"); assert.match(error.error, /suspended/);
  }
  await assert.rejects(access(join(agentDir, "tasks")), { code: "ENOENT" });
});
