import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createJiti } from "jiti";
import { reportGenerationFixture } from "./task-report-generation.fixture.mjs";
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { getTaskReport, writeTaskReport, listTaskReports } = await jiti.import("./task-reports.ts");
const { saveTaskReportSettings } = await jiti.import("./task-report-settings.ts");
const { retryTaskReport, wakeTaskReportExecutor, waitForTaskReportExecutor } = await jiti.import("./task-report-executor.ts");
const { POST } = await jiti.import("../app/api/task-reports/route.ts");
const payload = call => JSON.parse(call.payload.messages.find(message => message.role === "user").content);
function service(f) {
  const child = spawn(process.execPath, ["--experimental-strip-types", "lib/task-report-recovery-process.fixture.mjs"], { env: { ...process.env, PI_CODING_AGENT_DIR: f.agentDir }, stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; child.stdout.on("data", data => output += data); child.stderr.on("data", data => output += data);
  return new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", code => code === 0 ? resolve() : reject(new Error(output))); });
}
async function pending(t, long = false) {
  const f = await reportGenerationFixture(); t.after(() => f.close());
  const task = await f.create("Frozen recovery task");
  const source = f.session(long ? "ORIGINAL " + "source evidence ".repeat(4000) : "ORIGINAL evidence");
  await f.link(task.id, [source.getSessionId()]);
  const archive = await f.archive(task.id), id = archive.result.task.reportIds[0];
  return { f, task, source, id, read: () => getTaskReport(id, f.agentDir) };
}
async function finish(f, id, start = f.calls.length) {
  let index = start;
  while (true) {
    await f.wait(async () => f.calls.length > index || !["queued", "generating"].includes((await getTaskReport(id, f.agentDir)).status));
    if (f.calls.length <= index) return;
    f.respond(index++, "success", "Durable detailed work evidence " + "d".repeat(1700));
  }
}

test("Node startup consumes queued original intent without pages, fixed model/level despite restore/settings/source changes; repeated starts/reads send zero", async t => {
  const s = await pending(t), { f } = s;
  const original = await s.read();
  await writeTaskReport({ ...original, selection: f.selection, configurationIssue: null, status: "queued" }, f.agentDir);
  await saveTaskReportSettings({ provider: "report-plain", modelId: "same-id", thinkingLevel: "off" }, f.agentDir);
  s.source.appendMessage({ role: "user", content: "TODAY_NOT_CAPTURED", timestamp: 5 });
  await f.op({ action: "set-archive", id: s.task.id, archived: false, expectedArchiveRevision: 1, operationId: randomUUID() });
  const started = service(f); await f.wait(() => f.calls.length === 1);
  assert.equal(f.calls[0].payload.reasoning_effort, "high"); assert.deepEqual(payload(f.calls[0]).snapshot, original.snapshot);
  f.respond(0); await started;
  assert.equal((await s.read()).status, "generated");
  await service(f); await service(f); await listTaskReports(s.task.id, f.agentDir); assert.equal(f.calls.length, 1);
});

test("real multi-layer durable plans resume bottom material, L1 completion->L2, and final unsent synthesis without redoing saved results", async t => {
  const s = await pending(t, true), { f, id } = s;
  await saveTaskReportSettings(f.selection, f.agentDir);
  await retryTaskReport(id, randomUUID(), f.agentDir);
  const checkpoints = []; let index = 0;
  while (true) {
    await f.wait(async () => f.calls.length > index || (await s.read()).status === "generated");
    if (f.calls.length <= index) break;
    const report = await s.read(), request = payload(f.calls[index]);
    if (index === 1 || request.operation === "synthesis-material" && request.level === 2 && !checkpoints.some(value => value.stage.level === 2) || request.operation === "synthesis") checkpoints.push(structuredClone(report));
    f.respond(index++, "success", "Detailed decisions, failures and actual verification " + "d".repeat(1500));
  }
  await waitForTaskReportExecutor(); assert.equal(checkpoints.length, 3);
  const layerBoundary = structuredClone(checkpoints[1]);
  layerBoundary.materials = layerBoundary.materials.filter(material => (material.level ?? 0) < 2);
  layerBoundary.stage = { kind: "synthesis", level: 1, materialId: layerBoundary.materials.at(-1).id };
  checkpoints.push(layerBoundary); // Result durably saved, stage not yet advanced and next-layer plan not yet written.
  await rm(s.source.getSessionFile());
  await saveTaskReportSettings(null, f.agentDir);
  for (const checkpoint of checkpoints) {
    // Simulate interruption immediately before this persisted send boundary, retaining the real preceding results and complete plan.
    checkpoint.phase = "preparing"; delete checkpoint.sentAt;
    const material = checkpoint.materials.find(value => value.id === checkpoint.stage.materialId); if (material) delete material.sentAt;
    await writeTaskReport(checkpoint, f.agentDir);
    const before = f.calls.length, saved = checkpoint.materials.filter(value => value.body !== null);
    const started = service(f); const finishing = finish(f, id, before); await Promise.all([started, finishing]);
    const report = await s.read(); assert.equal(report.status, "generated"); assert.deepEqual(report.snapshot, checkpoint.snapshot);
    for (const material of saved) assert.equal(report.materials.find(value => value.id === material.id).body, material.body);
    const calls = f.calls.slice(before);
    for (const call of calls) {
      const request = payload(call); assert.ok(!saved.some(material => material.id === request.materialId), "saved material never regenerated");
      assert.equal(call.payload.reasoning_effort, "high"); assert.equal(request.task.description, "Original goal");
      if (request.materials) for (const input of request.materials) assert.equal(input.body, report.materials.find(value => value.id === input.id).body);
    }
    assert.equal(calls.length, report.materials.length - saved.length + 1, "only unfinished materials plus final body");
    if (checkpoint.stage.kind === "synthesis" && !checkpoint.stage.materialId) assert.equal(calls.length, 1);
    await service(f); assert.equal(f.calls.length, before + calls.length);
  }
  for (const checkpoint of checkpoints.slice(0, 3)) {
    await writeTaskReport({ ...checkpoint, phase: "sending" }, f.agentDir);
    const count = f.calls.length; await service(f); await service(f);
    assert.equal((await s.read()).status, "unconfirmed"); assert.equal(f.calls.length, count);
  }
  // Retry an actual multi-layer unknown report: no old-model frontier reused, original source restarts with current selection.
  await saveTaskReportSettings({ provider: "report-plain", modelId: "same-id", thinkingLevel: "off" }, f.agentDir);
  const beforeRetry = f.calls.length, operationId = randomUUID();
  const attempt = await retryTaskReport(id, operationId, f.agentDir);
  assert.equal(attempt.materials, undefined); assert.deepEqual(attempt.snapshot, checkpoints[2].snapshot);
  const finishing = finish(f, id, beforeRetry); await finishing; await waitForTaskReportExecutor();
  const retried = await s.read(); assert.equal(retried.status, "generated");
  assert.equal(payload(f.calls[beforeRetry]).operation, "detailed-material");
  assert.equal(payload(f.calls[beforeRetry]).materialId, "material-1");
  for (const call of f.calls.slice(beforeRetry)) assert.equal(call.payload.reasoning_effort, undefined);
  assert.equal((await retryTaskReport(id, operationId, f.agentDir)).attempt, attempt.attempt);
});

for (const status of ["failed", "unconfirmed", "awaiting-configuration"]) test(`${status}: explicit current-config retry preserves snapshot, clears old materials, same ID concurrent/lost-response retry only one attempt; generating refuses`, async t => {
  const s = await pending(t), { f, id } = s, original = await s.read();
  await writeTaskReport({ ...original, status, materials: [{ id: "material-1", parts: [], body: "OLD_MODEL", completedAt: new Date().toISOString() }] }, f.agentDir);
  await saveTaskReportSettings({ provider: "report-plain", modelId: "same-id", thinkingLevel: "off" }, f.agentDir);
  await service(f); assert.equal(f.calls.length, 0, "settings/startup do not authorize failed work");
  s.source.appendMessage({ role: "user", content: "TODAY_NOT_CAPTURED", timestamp: 4 });
  const operationId = randomUUID(), attempts = await Promise.all([retryTaskReport(id, operationId, f.agentDir), retryTaskReport(id, operationId, f.agentDir)]);
  assert.ok(attempts.every(value => value.attempt === 2)); assert.equal(attempts[0].materials, undefined);
  await f.wait(() => f.calls.length === 1); assert.equal(f.calls[0].payload.reasoning_effort, undefined);
  assert.deepEqual(payload(f.calls[0]).snapshot, original.snapshot);
  const response = await POST(new Request("http://localhost/api/task-reports", { method: "POST", body: JSON.stringify({ action: "retry", id, operationId }) })); assert.equal(response.status, 200);
  await assert.rejects(retryTaskReport(id, randomUUID(), f.agentDir), { code: "conflict" });
  f.respond(0); await waitForTaskReportExecutor(); assert.equal((await retryTaskReport(id, operationId, f.agentDir)).attempt, 2);
  await service(f); wakeTaskReportExecutor(f.agentDir); await waitForTaskReportExecutor(); assert.equal(f.calls.length, 1);
});

test("short sending without result stays unknown; unreadable snapshot retry errors without collecting today's source; strict HTTP input", async t => {
  const s = await pending(t), { f, id } = s;
  await writeTaskReport({ ...await s.read(), status: "generating", phase: "sending", stage: { kind: "report" }, selection: f.selection }, f.agentDir);
  await service(f); await service(f); assert.equal((await s.read()).status, "unconfirmed"); assert.equal(f.calls.length, 0);
  await writeFile(join(f.agentDir, "task-reports", `${id}.json`), "broken snapshot");
  await assert.rejects(retryTaskReport(id, randomUUID(), f.agentDir), { code: "storage-unavailable" }); assert.equal(f.calls.length, 0);
  const response = await POST(new Request("http://localhost/api/task-reports", { method: "POST", body: JSON.stringify({ action: "unsupported", id, operationId: randomUUID() }) })); assert.equal(response.status, 400);
});
