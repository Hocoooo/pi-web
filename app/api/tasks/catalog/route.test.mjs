import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createTaskTestJiti } from "../../../../lib/__fixtures__/task-jiti.mjs";

const jiti = createTaskTestJiti(import.meta.url);
const { GET } = await jiti.import("./route.ts");
const { POST } = await jiti.import("../route.ts");
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-task-catalog-http-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, agentDir: process.env.PI_CODING_AGENT_DIR, file: join(process.env.PI_CODING_AGENT_DIR, "tasks", "board.json") };
}
const catalog = () => GET(new Request("http://localhost/api/tasks/catalog"));
async function create(cwd = null) {
  const response = await POST(new Request("http://localhost/api/tasks", { method: "POST", body: JSON.stringify({
    action: "create", id: randomUUID(), title: "Catalog task", description: "Description", completionCriteria: "Criteria", cwd,
  }) }));
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()).task;
}

test("missing catalog is empty and never creates the agent directory, board, or lock", async t => {
  const f = await fixture(t);
  const response = await catalog();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { tasks: [] });
  assert.deepEqual(await readdir(f.dir), []);
});

test("catalog returns every task's allowlisted fields and explicit links, without legacy history or private metadata", async t => {
  const f = await fixture(t);
  const project = join(f.dir, "project"); await mkdir(project);
  const first = await create(project), second = await create();
  const document = JSON.parse(await readFile(f.file, "utf8"));
  document.tasks[0].sessionIds = [randomUUID(), randomUUID()];
  document.tasks[0].moveReceipt = { operationId: randomUUID(), fingerprint: "a".repeat(64) };
  document.tasks[0].project.privateMetadata = "must-not-leak";
  const versionId = randomUUID();
  document.tasks[0].sharedContext = { currentVersionId: versionId, versions: [{ id: versionId, confirmedAt: first.updatedAt,
    source: { kind: "manual" }, content: { goal: "private legacy history", decisions: "", progress: "", nextSteps: "" },
    receipt: { operationId: randomUUID(), fingerprint: "b".repeat(64) } }] };
  document.tasks[1].archived = true;
  await writeFile(f.file, JSON.stringify(document));
  const before = await readFile(f.file), entries = await readdir(join(f.agentDir, "tasks"));
  const response = await catalog();
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  const expected = (task, stored) => ({ id: task.id, title: task.title, description: task.description,
    completionCriteria: task.completionCriteria, project: task.project, archived: stored.archived,
    updatedAt: task.updatedAt, sessionIds: stored.sessionIds });
  assert.deepEqual(body, { tasks: [expected(first, document.tasks[0]), expected(second, document.tasks[1])] });
  assert.deepEqual(await readFile(f.file), before);
  assert.deepEqual(await readdir(join(f.agentDir, "tasks")), entries);
});

test("legal legacy catalog reads hydrate only in memory, even while a writer lock exists", async t => {
  const f = await fixture(t);
  await mkdir(join(f.agentDir, "tasks"), { recursive: true });
  await mkdir(`${f.file}.lock`);
  const task = { id: randomUUID(), title: "Legacy", description: "", completionCriteria: "", project: null,
    columnId: "todo", revision: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
  await writeFile(f.file, JSON.stringify({ version: 1, tasks: [task] }));
  const before = await readFile(f.file);
  const response = await catalog();
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), { tasks: [{ id: task.id, title: task.title, description: "", completionCriteria: "",
    project: null, archived: false, updatedAt: task.updatedAt, sessionIds: [] }] });
  assert.deepEqual(await readFile(f.file), before, "no migration write");
  assert.deepEqual((await readdir(join(f.agentDir, "tasks"))).sort(), ["board.json", "board.json.lock"]);
});

test("invalid, partial and unsupported catalogs return typed 503 errors without overwriting bytes or creating locks", async t => {
  const f = await fixture(t);
  await mkdir(join(f.agentDir, "tasks"), { recursive: true });
  for (const text of ["{private-invalid-json", JSON.stringify({ version: 7, tasks: [] }), JSON.stringify({ version: 999, tasks: [] })]) {
    await writeFile(f.file, text);
    const response = await catalog();
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.ok(["storage-unavailable", "unsupported-version"].includes(body.code));
    assert.equal(typeof body.error, "string");
    assert.ok(!JSON.stringify(body).includes("private-invalid-json"));
    assert.equal(await readFile(f.file, "utf8"), text);
    assert.deepEqual(await readdir(join(f.agentDir, "tasks")), ["board.json"]);
  }
});
