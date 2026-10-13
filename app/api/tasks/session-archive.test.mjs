import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { POST } = await jiti.import("./route.ts");
const { GET: sessions } = await jiti.import("../sessions/route.ts");
const { readArchivedSessionIds } = await jiti.import("../../../lib/session-archive.ts");
const { invalidateSessionListCache } = await jiti.import("../../../lib/session-reader.ts");
const post = input => POST(new Request("http://localhost/api/tasks", { method: "POST", body: JSON.stringify(input) }));
test("public HTTP preview/consent/commit/restore use native history and complete session catalogue without exposing receipts", async t => {
  const agentDir = await mkdtemp(join(tmpdir(), "task-archive-api-")), cwd = join(agentDir, "chat-workspace"); await mkdir(cwd);
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir; invalidateSessionListCache();
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    invalidateSessionListCache(); await rm(agentDir, { recursive: true, force: true });
  });
  const manager = SessionManager.create(cwd); manager.appendMessage({ role: "user", content: "HTTP fixture", timestamp: 1 });
  const bytes = await readFile(manager.getSessionFile());
  const created = await post({ action: "createFromSession", id: randomUUID(), title: "HTTP archive", description: "", completionCriteria: "", sourceSessionId: manager.getSessionId() });
  assert.equal(created.status, 200); const { task } = await created.json();
  const previewResponse = await post({ action: "preview-archive", id: task.id });
  assert.equal(previewResponse.status, 200); assert.equal(previewResponse.headers.get("cache-control"), "no-store");
  const preview = await previewResponse.json(); assert.equal(preview.families[0].rootSessionId, manager.getSessionId());
  assert.equal((await readArchivedSessionIds(agentDir)).size, 0);
  const request = { action: "set-archive", id: task.id, archived: true, expectedArchiveRevision: preview.archiveRevision,
    operationId: randomUUID(), cascade: { previewToken: preview.token, confirmCrossTask: false } };
  for (const invalid of [
    { ...request, archived: false }, { ...request, cascade: {} }, { ...request, cascade: { ...request.cascade, sessionIds: [manager.getSessionId()] } },
    { ...request, cascade: { ...request.cascade, confirmCrossTask: "true" } }, { action: "preview-archive", id: task.id, sessionIds: [] },
  ]) assert.equal((await post(invalid)).status, 400);
  const response = await post(request); assert.equal(response.status, 200);
  const result = await response.json(); assert.deepEqual(result.sessionArchive.rootSessionIds, [manager.getSessionId()]);
  assert.equal("archiveReceipt" in result.task, false); assert.equal("archiveReceipt" in result.board.tasks[0], false);
  const catalogue = await sessions(new Request("http://localhost/api/sessions?summary=1"));
  assert.equal(catalogue.status, 200); const catalog = await catalogue.json();
  assert.equal(catalog.sessions.find(s => s.id === manager.getSessionId()).archived, true);
  assert.deepEqual(await readFile(manager.getSessionFile()), bytes);
  const restore = await post({ action: "set-archive", id: task.id, archived: false, expectedArchiveRevision: 1, operationId: randomUUID() });
  assert.equal(restore.status, 200); assert.equal((await restore.json()).task.archived, false);
  assert.equal((await readArchivedSessionIds(agentDir)).has(manager.getSessionId()), true);
  assert.equal((await post(request)).status, 409);
  assert.equal((await post({ action: "preview-archive", id: randomUUID() })).status, 404);
});
