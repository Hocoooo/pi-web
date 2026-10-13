import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createJiti } from "jiti";
import { reportGenerationFixture, REPORT_TEXT } from "./task-report-generation.fixture.mjs";
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { getTaskReport, getTaskReportHistory, regenerateTaskReport, writeTaskReport, readTaskReportText } = await jiti.import("./task-reports.ts");
const { saveTaskReportSettings } = await jiti.import("./task-report-settings.ts");
const { waitForTaskReportExecutor, retryTaskReport } = await jiti.import("./task-report-executor.ts");
const { GET, POST } = await jiti.import("../app/api/task-reports/route.ts");
const post = input => POST(new Request("http://localhost/api/task-reports", { method: "POST", body: JSON.stringify(input) }));
const input = call => JSON.parse(call.payload.messages.find(message => message.role === "user").content);
const plain = { provider: "report-plain", modelId: "same-id", thinkingLevel: "off" };

test("real short archive → selected-snapshot regeneration → restored rearchive; exact operations, current settings, creation-order latest and source deletion", async t => {
  const f = await reportGenerationFixture(); t.after(() => f.close());
  await saveTaskReportSettings(f.selection, f.agentDir);
  const task = await f.create("Report history"), source = f.session("ORIGINAL_ONLY");
  await f.link(task.id, [source.getSessionId()]);
  const { result } = await f.archive(task.id), id1 = result.task.reportIds[0];
  await f.wait(() => f.calls.length === 1); f.respond(0); await waitForTaskReportExecutor();
  const first = await getTaskReport(id1, f.agentDir), bytes1 = await f.reportBytes(id1);
  source.appendMessage({ role: "user", content: "TODAY_NEW_SNAPSHOT", timestamp: 2 });
  await saveTaskReportSettings(plain, f.agentDir);
  const operationId = randomUUID(), request = { action: "regenerate", id: id1, operationId };
  const [a, b] = await Promise.all([post(request), post(request)]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  const id2 = (await a.json()).id; assert.equal((await b.json()).id, id2); assert.notEqual(id2, id1);
  await f.wait(() => f.calls.length === 2);
  const second = await getTaskReport(id2, f.agentDir);
  assert.deepEqual(second.snapshot, first.snapshot); assert.deepEqual(second.selection, plain);
  assert.equal(second.materials, undefined); assert.equal(second.body, null); assert.equal(second.regeneratedFromId, id1);
  assert.deepEqual(input(f.calls[1]).snapshot, first.snapshot); assert.equal(f.calls[1].payload.reasoning_effort, undefined);
  let history = await getTaskReportHistory(task.id, f.agentDir);
  assert.equal(history.latestSuccessfulReportId, id1); assert.equal(history.currentReportId, id2);
  assert.equal((await (await post(request)).json()).id, id2, "lost response confirms one version");
  f.respond(1); await waitForTaskReportExecutor();
  assert.equal((await (await post(request)).json()).id, id2, "completed operation still confirms");
  assert.deepEqual(await f.reportBytes(id1), bytes1); assert.equal(f.calls.length, 2);
  const bytes2 = await f.reportBytes(id2);
  await f.op({ action: "set-archive", id: task.id, archived: false, expectedArchiveRevision: 1, operationId: randomUUID() });
  assert.deepEqual((await f.current(task.id)).reportIds, [id1, id2]);
  const thirdArchive = await f.archive(task.id), id3 = thirdArchive.result.task.reportIds[2];
  await f.wait(() => f.calls.length === 3); assert.ok(JSON.stringify(input(f.calls[2]).snapshot).includes("TODAY_NEW_SNAPSHOT"));
  assert.equal((await getTaskReportHistory(task.id, f.agentDir)).latestSuccessfulReportId, id2);
  f.respond(2); await waitForTaskReportExecutor();
  assert.deepEqual(await f.reportBytes(id1), bytes1); assert.deepEqual(await f.reportBytes(id2), bytes2);
  await rm(source.getSessionFile());
  for (const id of [id1, id2, id3]) {
    assert.ok((await readTaskReportText(id, undefined, f.agentDir)).includes(REPORT_TEXT));
    assert.equal((await getTaskReport(id, f.agentDir)).snapshot.sources[0].sessionId, source.getSessionId());
  }
  // Persist completion timestamps out of creation order; do not add a parallel executor.
  await writeTaskReport({ ...await getTaskReport(id1, f.agentDir), completedAt: "2099-01-01T00:00:00.000Z" }, f.agentDir);
  await writeTaskReport({ ...await getTaskReport(id3, f.agentDir), completedAt: "2000-01-01T00:00:00.000Z" }, f.agentDir);
  const httpHistory = await GET(new Request(`http://localhost/api/task-reports?taskId=${task.id}`));
  history = await httpHistory.json(); assert.equal(history.latestSuccessfulReportId, id3);
  assert.deepEqual(history.reports.map(report => report.id), [id1, id2, id3]);
  // Regenerate a selected old version after deletion; failed new version uses ticket06 retry.
  const failed = await regenerateTaskReport(id1, randomUUID(), f.agentDir);
  await f.wait(() => f.calls.length === 4); assert.deepEqual(input(f.calls[3]).snapshot, first.snapshot);
  f.respond(3, "error"); await waitForTaskReportExecutor();
  assert.equal((await getTaskReportHistory(task.id, f.agentDir)).latestSuccessfulReportId, id3);
  await retryTaskReport(failed.id, randomUUID(), f.agentDir);
  await f.wait(() => f.calls.length === 5); f.respond(4); await waitForTaskReportExecutor();
  assert.equal((await getTaskReport(failed.id, f.agentDir)).attempt, 2);
  assert.equal((await regenerateTaskReport(id1, failed.regenerationOperationId, f.agentDir)).id, failed.id);
  await assert.rejects(regenerateTaskReport(id2, operationId, f.agentDir), { code: "conflict" });
  assert.equal(f.calls.length, 5);
});

test("regeneration never overwrites any successful bottom/intermediate material, and deleted sources remain fully readable", async t => {
  const f = await reportGenerationFixture(); t.after(() => f.close());
  await saveTaskReportSettings(f.selection, f.agentDir);
  const task = await f.create("Layered history"), source = f.session("EARLY " + "evidence ".repeat(7000) + " TAIL");
  await f.link(task.id, [source.getSessionId()]); const { result } = await f.archive(task.id), id = result.task.reportIds[0];
  let i = 0;
  while (true) {
    await f.wait(() => f.calls.length === i + 1);
    const request = input(f.calls[i]);
    f.respond(i++, "success", request.operation === "synthesis" ? REPORT_TEXT : "Detailed decisions, failed verify, observed pass; unknown quality. " + "d".repeat(1500));
    if (request.operation === "synthesis") break;
  }
  await waitForTaskReportExecutor();
  const report = await getTaskReport(id, f.agentDir), bytes = await f.reportBytes(id);
  assert.ok(report.materials.some(material => material.level > 0));
  await rm(source.getSessionFile()); await saveTaskReportSettings(plain, f.agentDir);
  const regenerated = await regenerateTaskReport(id, randomUUID(), f.agentDir);
  assert.equal(regenerated.body, null); assert.equal(regenerated.materials, undefined);
  assert.deepEqual(regenerated.snapshot, report.snapshot);
  while (true) {
    await f.wait(() => f.calls.length === i + 1);
    const request = input(f.calls[i]);
    assert.equal(f.calls[i].payload.reasoning_effort, undefined);
    f.respond(i++, "success", request.operation === "synthesis" ? REPORT_TEXT : "New model material. " + "n".repeat(1500));
    if (request.operation === "synthesis") break;
  }
  await waitForTaskReportExecutor();
  assert.equal((await getTaskReport(regenerated.id, f.agentDir)).status, "generated");
  assert.deepEqual(await f.reportBytes(id), bytes);
  for (const material of report.materials) {
    const response = await GET(new Request(`http://localhost/api/task-reports?id=${id}&material=${material.id}`));
    assert.equal(response.status, 200); assert.equal(await response.text(), material.body);
  }
});

test("invalid or unreadable regeneration rejects normally; no new references or source fallback; empty regeneration stays zero-cost", async t => {
  const f = await reportGenerationFixture(); t.after(() => f.close());
  const task = await f.create("Metadata"), { result } = await f.archive(task.id), id = result.task.reportIds[0];
  const request = { action: "regenerate", id, operationId: randomUUID() };
  const response = await post(request); assert.equal(response.status, 200);
  const id2 = (await response.json()).id; assert.equal((await getTaskReport(id2, f.agentDir)).status, "generated");
  assert.equal((await post({ ...request, snapshot: {} })).status, 400);
  assert.equal((await post({ ...request, operationId: "bad" })).status, 400);
  assert.equal((await post({ ...request, id: randomUUID() })).status, 404);
  await waitForTaskReportExecutor();
  await writeFile(join(f.agentDir, "task-reports", `${id}.json`), "broken");
  assert.equal((await post({ ...request, operationId: randomUUID() })).status, 500);
  assert.deepEqual((await f.current(task.id)).reportIds, [id, id2]); assert.equal(f.calls.length, 0);
});
