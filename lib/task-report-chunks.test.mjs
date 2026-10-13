import assert from "node:assert/strict";
import test, { after } from "node:test";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createTaskTestJiti } from "./__fixtures__/task-jiti.mjs";
import { installTaskTemporaryWriteFault } from "./task-fs-write-fault.fixture.mjs";
const writeFault = installTaskTemporaryWriteFault();
after(() => writeFault.restore());
const { reportGenerationFixture, REPORT_TEXT } = await import("./task-report-generation.fixture.mjs");
const jiti = createTaskTestJiti(import.meta.url);
const { getTaskReport, listTaskReports, readTaskReportText } = await jiti.import("./task-reports.ts");
const { saveTaskReportSettings } = await jiti.import("./task-report-settings.ts");
const { taskReportFits, wakeTaskReportExecutor, waitForTaskReportExecutor } = await jiti.import("./task-report-executor.ts");
const { GET } = await jiti.import("../app/api/task-reports/route.ts");
const evidenceText = "Decision: use local files because single-user; rejected database. Failed attempt: command verify exited 1, fixed path; artifact.ts. Observed verify passed; completion claim not verified. Follow-up open.";
const input = call => JSON.parse(call.payload.messages.find(message => message.role === "user").content);
async function setup(t, contextWindow = 10000) {
  const f = await reportGenerationFixture({ contextWindow }); t.after(() => f.close());
  await saveTaskReportSettings(f.selection, f.agentDir);
  const task = await f.create("Long detailed archive");
  const older = await f.archive(task.id), olderId = older.result.task.reportIds[0], olderBytes = await f.reportBytes(olderId);
  await f.op({ action: "set-archive", id: task.id, archived: false, expectedArchiveRevision: 1, operationId: randomUUID() });
  const source = f.session("UNIQUE_EARLY goal/constraints; abandoned option because dependency failed.");
  source.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "long", name: "bash", arguments: { command: "verify artifact.ts" } }], timestamp: 2, stopReason: "toolUse" });
  source.appendMessage({ role: "toolResult", toolCallId: "long", toolName: "bash", content: [{ type: "text", text: `UNIQUE_TOOL_START ${'行😀\\"\n'.repeat(2000)} UNIQUE_MIDDLE ${'z'.repeat(12000)} UNIQUE_TOOL_END` }], isError: false, timestamp: 3 });
  source.appendMessage({ role: "user", content: "UNIQUE_TAIL verify passed; still unfinished.", timestamp: 4 });
  const second = f.session("SECOND_SOURCE_EARLY independent requirement");
  second.appendMessage({ role: "user", content: "SECOND_SOURCE_MIDDLE rejected path and actual verification", timestamp: 2 });
  second.appendMessage({ role: "user", content: "SECOND_SOURCE_TAIL still open", timestamp: 3 });
  await f.link(task.id, [source.getSessionId(), second.getSessionId()]);
  const bytes = await readFile(source.getSessionFile());
  const archive = await f.archive(task.id), id = archive.result.task.reportIds.at(-1);
  await f.wait(() => f.calls.length === 1, "first material");
  assert.deepEqual(await readFile(source.getSessionFile()), bytes, "archive/executor leave source history unchanged");
  const read = () => getTaskReport(id, f.agentDir);
  return { f, task, source, bytes, archive, id, read, contextWindow, olderId, olderBytes };
}
async function finishMaterials(state, text = evidenceText) {
  const { f, read } = state;
  const count = (await read()).materials.length;
  for (let index = 0; index < count; index++) {
    await f.wait(() => f.calls.length === index + 1, `material ${index + 1}`);
    assert.equal(input(f.calls[index]).operation, "detailed-material");
    const report = await read(); assert.equal(report.status, "generating"); assert.equal(report.stage.materialId, `material-${index + 1}`);
    assert.equal(report.materials.filter(material => material.body !== null).length, index);
    f.respond(index, "success", text);
  }
  return count;
}
function verifyCalls(state) {
  for (const call of state.f.calls) {
    const user = call.payload.messages.find(message => message.role === "user").content;
    assert.equal(taskReportFits(user, state.contextWindow, 1000), true, "every actual request fits the byte bound");
    assert.equal(call.payload.max_completion_tokens, 1000); assert.equal(call.payload.reasoning_effort, "high"); assert.equal(call.payload.model, "same-id");
    assert.ok(!call.payload.tools?.length); assert.equal(call.payload.tool_choice, "none");
  }
}

test("real archive covers all early/middle/tail and every Unicode character of one long tool result, saves detailed materials and synthesizes all once; unified reads survive source deletion", async t => {
  const s = await setup(t), { f, read, id, source } = s;
  const initial = await read(); assert.ok(initial.materials.length > 5, "finite source, no cumulative request cap");
  // Changes while material 1 is in flight never affect subsequent stages.
  source.appendMessage({ role: "user", content: "LATER_NOT_IN_SNAPSHOT", timestamp: 5 });
  const changedSourceBytes = await readFile(source.getSessionFile());
  await saveTaskReportSettings(null, f.agentDir);
  const count = await finishMaterials(s);
  await f.wait(() => f.calls.length === count + 1, "single synthesis");
  const synthesis = input(f.calls[count]); assert.equal(synthesis.operation, "synthesis");
  assert.equal(synthesis.materials.length, count);
  const parts = f.calls.slice(0, count).flatMap(call => input(call).parts);
  for (const captured of initial.snapshot.sources) for (const item of captured.items) {
    const slices = parts.filter(part => part.source.sessionId === captured.sessionId && part.entryId === item.entryId);
    assert.equal(slices.map(part => part.text).join(""), item.text, `exact complete coverage ${item.entryId}`);
    let end = 0;
    for (const part of slices) { assert.equal(part.start, end); end = part.end; assert.equal(part.totalLength, item.text.length); }
    assert.equal(end, item.text.length);
  }
  assert.ok(parts.some(part => part.previousEntryId && part.nextEntryId));
  const tool = initial.snapshot.sources[0].items.find(item => item.kind.includes("tool"));
  assert.ok(parts.filter(part => part.entryId === tool.entryId).length > 1);
  for (const marker of ["UNIQUE_EARLY", "UNIQUE_MIDDLE", "UNIQUE_TOOL_END", "UNIQUE_TAIL", "SECOND_SOURCE_EARLY", "SECOND_SOURCE_MIDDLE", "SECOND_SOURCE_TAIL"]) assert.ok(parts.some(part => part.text.includes(marker)), marker);
  assert.ok(!JSON.stringify(f.calls.map(call => call.payload)).includes("LATER_NOT_IN_SNAPSHOT"));
  for (const call of f.calls.slice(0, count)) assert.equal(input(call).task.description, "Original goal");
  const durable = await read(); assert.equal(durable.materials.filter(material => material.body).length, count);
  const summaries = await listTaskReports(s.task.id, f.agentDir);
  assert.ok(summaries.find(value => value.id === id).materials.every(material => material.hasBody && !('body' in material)));
  await assert.rejects(readTaskReportText(id, "not-real", f.agentDir), { code: "not-found" });
  const missing = await GET(new Request(`http://localhost/api/task-reports?id=${id}&material=not-real`)); assert.equal(missing.status, 404);
  f.respond(count); await waitForTaskReportExecutor();
  const report = await read(); assert.equal(report.status, "generated"); assert.equal(report.stage.kind, "synthesis"); assert.equal(report.phase, "completed");
  assert.ok(report.body.startsWith(REPORT_TEXT));
  assert.deepEqual(await readFile(source.getSessionFile()), changedSourceBytes, "all later stages leave source history unchanged");
  await rm(source.getSessionFile());
  for (const material of report.materials) {
    assert.ok(report.body.includes(`&material=${material.id}`)); assert.ok(material.completedAt);
    const response = await GET(new Request(`http://localhost/api/task-reports?id=${id}&material=${material.id}`));
    assert.equal(response.status, 200); assert.match(response.headers.get("content-type"), /text\/plain/);
    assert.equal(await response.text(), material.body); assert.equal(await readTaskReportText(id, material.id, f.agentDir), material.body);
    assert.match(material.body, /Failed attempt/); assert.match(material.body, /Fixed material source directory/);
    assert.ok(synthesis.materials.find(value => value.id === material.id).body === material.body);
  }
  assert.equal(await readTaskReportText(id, undefined, f.agentDir), report.body);
  verifyCalls(s); wakeTaskReportExecutor(f.agentDir); await f.op(s.archive.request); await waitForTaskReportExecutor(); assert.equal(f.calls.length, count + 1);
});

for (const mode of ["error", "length", "empty"]) test(`middle material ${mode} preserves completed progress/readable material and stops without resend`, async t => {
  const s = await setup(t); s.f.respond(0, "success", evidenceText);
  await s.f.wait(() => s.f.calls.length === 2); s.f.respond(1, mode); await waitForTaskReportExecutor();
  const report = await s.read(); assert.equal(report.status, "failed"); assert.equal(report.hasBody, false); assert.equal(report.stage.materialId, "material-2");
  assert.ok(report.materials[0].completedAt); assert.ok(report.materials[0].body); assert.equal(report.materials[1].body, null);
  assert.equal(await readTaskReportText(s.id, "material-1", s.f.agentDir), report.materials[0].body);
  await assert.rejects(readTaskReportText(s.id, "material-2", s.f.agentDir), { code: "not-found" });
  wakeTaskReportExecutor(s.f.agentDir); await waitForTaskReportExecutor(); assert.equal(s.f.calls.length, 2); verifyCalls(s);
});

for (const mode of ["error", "length"]) test(`final synthesis ${mode} retains all materials without publishing a body`, async t => {
  const s = await setup(t); const count = await finishMaterials(s); await s.f.wait(() => s.f.calls.length === count + 1);
  s.f.respond(count, mode); await waitForTaskReportExecutor(); const report = await s.read();
  assert.equal(report.status, "failed"); assert.equal(report.stage.kind, "synthesis"); assert.equal(report.body, null);
  assert.equal(report.materials.filter(material => material.body).length, count); verifyCalls(s);
});

const largeMaterial = `${evidenceText}\n${'d'.repeat(1500)}`;
async function advanceSynthesis(s, start, stop = () => false, text = largeMaterial) {
  let index = start;
  while (true) {
    await s.f.wait(async () => s.f.calls.length > index || (await s.read()).status !== "generating", "next synthesis stage");
    const report = await s.read();
    if (report.status !== "generating") return index;
    const request = input(s.f.calls[index]);
    if (stop(request, index)) return index;
    assert.ok(["synthesis-material", "synthesis"].includes(request.operation));
    if (request.operation === "synthesis-material") {
      assert.equal(report.stage.materialId, request.materialId); assert.equal(report.stage.level, request.level);
      const material = report.materials.find(value => value.id === request.materialId);
      assert.equal(material.body, null); assert.ok(material.sentAt); assert.equal(report.phase, "sending");
      assert.deepEqual(material.inputMaterialIds, request.materials.map(value => value.id));
    }
    for (const material of request.materials) assert.equal(material.body, report.materials.find(value => value.id === material.id).body, "whole durable input, no truncation");
    s.f.respond(index++, "success", request.operation === "synthesis-material" ? text : REPORT_TEXT);
  }
}

test("oversized detailed materials complete finite multi-level synthesis with complete directories, real stage records and unified API reads", async t => {
  const s = await setup(t), initial = await s.read();
  const count = await finishMaterials(s, largeMaterial);
  const requests = await advanceSynthesis(s, count); await waitForTaskReportExecutor();
  const report = await s.read(); assert.equal(report.status, "generated"); assert.ok(report.hasBody);
  assert.deepEqual(report.snapshot, initial.snapshot); assert.deepEqual(report.selection, initial.selection);
  const levels = [...new Set(report.materials.map(material => material.level ?? 0))];
  assert.ok(levels.includes(2), "actual intermediate layers, not just one group followed by final");
  let prior = report.materials.filter(material => !material.level);
  for (const level of levels.filter(level => level > 0)) {
    const layer = report.materials.filter(material => material.level === level);
    assert.ok(layer.length < prior.length, "strict finite contraction independent of cumulative budget");
    assert.deepEqual(layer.flatMap(material => material.inputMaterialIds), prior.map(material => material.id));
    prior = layer;
  }
  assert.ok(requests > 10 && requests < count * 2 + 1, "no small cumulative request cap; finite decreasing frontier");
  await rm(s.source.getSessionFile());
  for (const material of report.materials) {
    assert.ok(material.sentAt && material.completedAt); assert.ok(report.body.includes(`&material=${material.id}`));
    assert.match(material.body, material.level ? /Fixed synthesis input directory/ : /Fixed material source directory/);
    for (const id of material.inputMaterialIds ?? []) assert.ok(material.body.includes(`&material=${id}`));
    const response = await GET(new Request(`http://localhost/api/task-reports?id=${s.id}&material=${material.id}`));
    assert.equal(response.status, 200); assert.equal(await response.text(), material.body);
    assert.equal(await readTaskReportText(s.id, material.id, s.f.agentDir), material.body);
  }
  // Retain the original04 no-truncation assertion across every lower source slice.
  const parts = s.f.calls.slice(0, count).flatMap(call => input(call).parts);
  for (const source of initial.snapshot.sources) for (const item of source.items) assert.equal(parts.filter(part => part.source.sessionId === source.sessionId && part.entryId === item.entryId).map(part => part.text).join(""), item.text);
  const summary = (await listTaskReports(s.task.id, s.f.agentDir)).find(value => value.id === s.id);
  assert.ok(summary.materials.every(material => material.hasBody && !('body' in material)));
  verifyCalls(s); wakeTaskReportExecutor(s.f.agentDir); await waitForTaskReportExecutor(); assert.equal(s.f.calls.length, requests);
});

for (const mode of ["error", "length", "storage"]) test(`cross-layer ${mode} preserves actual completed layers and never resends or publishes partial body`, async t => {
  const s = await setup(t); const count = await finishMaterials(s, largeMaterial);
  const index = await advanceSynthesis(s, count, request => request.level === 2);
  assert.equal(input(s.f.calls[index]).level, 2);
  const before = await s.read(), beforeBytes = await s.f.reportBytes(s.id);
  const fault = mode === "storage" ? writeFault.deny(join(s.f.agentDir, "task-reports", `${s.id}.json`)) : undefined;
  try {
    s.f.respond(index, mode === "storage" ? "success" : mode); await waitForTaskReportExecutor();
    if (fault) {
      assert.ok(fault.calls.length > 0, "actual report temp creation was denied");
      assert.deepEqual(await s.f.reportBytes(s.id), beforeBytes, "failed output leaves report bytes unchanged");
    }
    const report = await s.read(); assert.equal(report.status, mode === "storage" ? "generating" : "failed");
    assert.equal(report.body, null); assert.equal(report.hasBody, false);
    assert.equal(report.stage.level, 2); assert.equal(report.phase, "sending");
    assert.deepEqual(await s.f.reportBytes(s.olderId), s.olderBytes, "older successful report is never overwritten");
    assert.deepEqual(report.materials, before.materials, "failed output does not replace durable progress");
    for (const material of report.materials.filter(material => material.body !== null)) assert.equal(await readTaskReportText(s.id, material.id, s.f.agentDir), material.body);
    await assert.rejects(readTaskReportText(s.id, report.stage.materialId, s.f.agentDir), { code: "not-found" });
    wakeTaskReportExecutor(s.f.agentDir); await waitForTaskReportExecutor(); assert.equal(s.f.calls.length, index + 1); verifyCalls(s);
  } finally { fault?.restore(); }
});

test("a later layer that cannot contract stops after real completed intermediates", async t => {
  const s = await setup(t), count = await finishMaterials(s, largeMaterial);
  const requests = await advanceSynthesis(s, count, () => false, 'd'.repeat(3500)); await waitForTaskReportExecutor();
  const report = await s.read(); assert.equal(report.status, "failed"); assert.match(report.error, /cannot reduce/);
  assert.ok(report.materials.some(material => material.level === 1 && material.completedAt));
  assert.equal(report.stage.level, 2); assert.equal(report.phase, "preparing"); assert.equal(report.body, null);
  assert.ok(requests > count); verifyCalls(s);
});

for (const size of [3500, 6500]) test(`capacity ${size} saved output cannot shrink or fit a basic synthesis input: explicit finite failure, no source truncation`, async t => {
  const s = await setup(t); const count = await finishMaterials(s, 'd'.repeat(size));
  await waitForTaskReportExecutor(); const report = await s.read();
  assert.equal(report.status, "failed"); assert.match(report.error, size === 3500 ? /cannot reduce/ : /one complete saved material/);
  assert.equal(report.materials.filter(material => material.body).length, count); assert.equal(s.f.calls.length, count);
  assert.equal(report.stage.kind, "synthesis"); assert.equal(report.phase, "preparing"); assert.equal(report.body, null); verifyCalls(s);
});

for (const stage of ["material", "synthesis"]) test(`${stage} output storage failure cannot publish success and leaves prior durable materials readable`, async t => {
  const s = await setup(t);
  let index;
  if (stage === "synthesis") { index = await finishMaterials(s); await s.f.wait(() => s.f.calls.length === index + 1); }
  else { s.f.respond(0, "success", evidenceText); await s.f.wait(() => s.f.calls.length === 2); index = 1; }
  const beforeBytes = await s.f.reportBytes(s.id);
  const fault = writeFault.deny(join(s.f.agentDir, "task-reports", `${s.id}.json`));
  try {
    s.f.respond(index); await waitForTaskReportExecutor();
    assert.ok(fault.calls.length > 0, "actual report temp creation was denied");
    assert.deepEqual(await s.f.reportBytes(s.id), beforeBytes, "failed output leaves report bytes unchanged");
    const report = await s.read(); assert.equal(report.status, "generating"); assert.equal(report.phase, "sending"); assert.equal(report.body, null);
    assert.equal(report.materials.filter(material => material.body).length, index);
    assert.ok(await readTaskReportText(s.id, "material-1", s.f.agentDir));
    wakeTaskReportExecutor(s.f.agentDir); await waitForTaskReportExecutor(); assert.equal(s.f.calls.length, index + 1);
  } finally { fault.restore(); }
});
