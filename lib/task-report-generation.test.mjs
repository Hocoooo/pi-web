import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createJiti } from "jiti";
import { reportGenerationFixture, REPORT_TEXT } from "./task-report-generation.fixture.mjs";
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { getTaskReport, listTaskReports, prepareTaskReport } = await jiti.import("./task-reports.ts");
const { saveTaskReportSettings } = await jiti.import("./task-report-settings.ts");
const { wakeTaskReportExecutor, waitForTaskReportExecutor } = await jiti.import("./task-report-executor.ts");
const { withTaskStore } = await jiti.import("./task-store.ts");
const { GET } = await jiti.import("../app/api/task-reports/route.ts");
const { POST } = await jiti.import("../app/api/tasks/route.ts");
const { getRpcSession } = await jiti.import("./rpc-manager.ts");
async function fixture(t, options) { const f = await reportGenerationFixture(options); t.after(() => f.close()); return f; }
const read = (f, id) => getTaskReport(id, f.agentDir);

test("real HTTP archive sends independent SDK request once, outside lock, with fixed model/level/full snapshot; browser cancellation and restore do not cancel", async t => {
  const f = await fixture(t); await saveTaskReportSettings(f.selection, f.agentDir);
  const task = await f.create("Detailed agent archive"), source = f.session("EARLY goal and constraints");
  source.appendModelChange("source-chat-provider", "source-chat-model"); source.appendThinkingLevelChange("low");
  const early = source.getLeafId(); source.appendMessage({ role: "user", content: "OTHER BRANCH", timestamp: 2 }); source.branch(early);
  source.appendMessage({ role: "toolResult", toolCallId: "verify", toolName: "bash", content: [{ type: "text", text: "verify command passed; artifact.ts" }], isError: false, timestamp: 3 });
  source.appendCompaction("SUMMARY preserves earlier reasoning", null, 5000);
  source.appendMessage({ role: "assistant", content: [{ type: "thinking", thinking: "HIDDEN" }, { type: "text", text: "A conversational completion claim" }], timestamp: 4, stopReason: "stop" });
  const missing = f.session("DELETED"); await f.link(task.id, [source.getSessionId(), missing.getSessionId()]); await rm(missing.getSessionFile());
  const bytes = await readFile(source.getSessionFile());
  const request = { action: "set-archive", id: task.id, archived: true, expectedArchiveRevision: 0, operationId: randomUUID() };
  const controller = new AbortController();
  const response = await POST(new Request("http://localhost/api/tasks", { method: "POST", body: JSON.stringify(request), signal: controller.signal }));
  assert.equal(response.status, 200); controller.abort();
  const id = (await response.json()).task.reportIds[0];
  await f.wait(() => f.calls.length === 1, "first wire request");
  const sending = await read(f, id); assert.equal(sending.status, "generating"); assert.equal(sending.phase, "sending"); assert.ok(sending.sentAt);
  const payload = f.calls[0].payload;
  assert.equal(payload.model, "same-id"); assert.equal(payload.reasoning_effort, "high"); assert.ok(!payload.tools?.length);
  assert.equal(payload.tool_choice, "none", "no tools are allowed");
  const input = payload.messages.map(message => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
  for (const value of ["EARLY", "verify command passed", "SUMMARY", "A conversational", "missing", source.getLeafId(), "Original requirements", "failed attempts", "actual verification"]) assert.ok(input.toLowerCase().includes(value.toLowerCase()), value);
  for (const value of ["OTHER BRANCH", "HIDDEN", "DELETED"]) assert.ok(!input.includes(value), value);
  assert.equal(getRpcSession(source.getSessionId()), undefined, "sleeping source never started");
  assert.deepEqual(await readFile(source.getSessionFile()), bytes);
  assert.equal((await f.current(task.id)).archived, true, "board usable during delayed provider call");
  await f.op(request); await f.op({ ...request, operationId: randomUUID(), expectedArchiveRevision: 1 });
  await GET(new Request(`http://localhost/api/task-reports?taskId=${task.id}`));
  source.appendMessage({ role: "user", content: "LATER input", timestamp: 5 }); source.branch(early);
  await saveTaskReportSettings({ provider: "report-plain", modelId: "same-id", thinkingLevel: "off" }, f.agentDir);
  await f.op({ action: "edit", id: task.id, expectedRevision: (await f.current(task.id)).revision, title: "Changed", description: "New goal", completionCriteria: "New requirement", priority: 1, labels: [] });
  await f.op({ action: "set-archive", id: task.id, archived: false, expectedArchiveRevision: 1, operationId: randomUUID() });
  f.respond(0); await waitForTaskReportExecutor();
  const report = await read(f, id); assert.equal(report.status, "generated"); assert.equal(report.phase, "completed"); assert.ok(report.completedAt);
  assert.deepEqual(report.selection, f.selection); assert.equal(report.snapshot.task.title, task.title);
  assert.ok(report.body.startsWith(REPORT_TEXT)); assert.match(report.body, /Fixed archive coverage/); assert.match(report.body, /missing/); assert.ok(report.body.includes(sending.sources[0].cutoffEntryId));
  assert.ok(!report.body.includes("LATER input")); assert.equal(f.calls.length, 1);
  const saved = await f.reportBytes(id); await rm(source.getSessionFile());
  const body = await GET(new Request(`http://localhost/api/task-reports?id=${id}&body=1`)); assert.equal(body.status, 200); assert.equal(await body.text(), report.body);
  // New archive uses a new identity, old success is not touched. Missing sources now yield metadata, zero calls.
  const second = await f.archive(task.id); await waitForTaskReportExecutor();
  assert.notEqual(second.result.task.reportIds[1], id); assert.deepEqual(await f.reportBytes(id), saved);
  assert.deepEqual(await readdir(f.cwd), []); assert.equal(f.calls.length, 1);
  const settings = await f.read(); assert.equal(settings.defaultProvider, f.initial.defaultProvider); assert.deepEqual(settings.defaultTools, ["read"]);
});

test("one global hot-reload executor serializes two committed intents, each keeps its original selection; old success remains available during a new failure", async t => {
  const f = await fixture(t); await saveTaskReportSettings(f.selection, f.agentDir);
  const task = await f.create("Version one"); await f.link(task.id, [f.session().getSessionId()]);
  const first = await f.archive(task.id), id = first.result.task.reportIds[0]; await f.wait(() => f.calls.length === 1);
  await f.op({ action: "set-archive", id: task.id, archived: false, expectedArchiveRevision: 1, operationId: randomUUID() });
  const second = await f.archive(task.id), id2 = second.result.task.reportIds[1];
  await saveTaskReportSettings(null, f.agentDir);
  const reloaded = await createJiti(import.meta.url, { moduleCache: false }).import("./task-report-executor.ts");
  reloaded.wakeTaskReportExecutor(f.agentDir); wakeTaskReportExecutor(f.agentDir);
  await new Promise(resolve => setTimeout(resolve, 60)); assert.equal(f.calls.length, 1); assert.equal((await read(f, id2)).status, "queued");
  f.respond(0); await f.wait(() => f.calls.length === 2); assert.equal((await read(f, id)).status, "generated");
  assert.equal(f.calls[1].payload.reasoning_effort, "high", "clearing current setting does not change old intent");
  f.respond(1, "error"); await waitForTaskReportExecutor();
  const summaries = await listTaskReports(task.id, f.agentDir); assert.deepEqual(summaries.map(report => report.status), ["generated", "failed"]);
  assert.equal(summaries[0].hasBody, true); assert.equal(summaries[1].hasBody, false);
  await f.op(second.request); await waitForTaskReportExecutor(); assert.equal(f.calls.length, 2);
});

test("cascade pending runs report independently, session batch retry cannot regenerate", async t => {
  const f = await fixture(t); await saveTaskReportSettings(f.selection, f.agentDir);
  const task = await f.create("Independent batch"); await f.link(task.id, [f.session().getSessionId()]);
  await writeFile(join(f.agentDir, "session-archive.json"), "broken");
  const request = { action: "set-archive", id: task.id, archived: true, expectedArchiveRevision: 0, operationId: randomUUID(), cascade: { previewToken: (await f.op({ action: "preview-archive", id: task.id })).token, confirmCrossTask: false } };
  await assert.rejects(f.op(request), { code: "storage-unavailable" });
  await f.wait(() => f.calls.length === 1); f.respond(0); await waitForTaskReportExecutor();
  const current = await f.current(task.id); assert.ok(current.pendingSessionArchive); assert.equal((await read(f, current.reportIds[0])).status, "generated");
  await rm(join(f.agentDir, "session-archive.json")); await f.op(request); await waitForTaskReportExecutor(); assert.equal(f.calls.length, 1);
});

test("timeout becomes durable unconfirmed without automatic resend; incomplete and empty responses are failed", async t => {
  const f = await fixture(t); await saveTaskReportSettings(f.selection, f.agentDir);
  const task = await f.create("Timeout"); await f.link(task.id, [f.session().getSessionId()]);
  const { result, request } = await f.archive(task.id); wakeTaskReportExecutor(f.agentDir, { timeoutMs: 100 });
  await f.wait(() => f.calls.length === 1); await waitForTaskReportExecutor();
  const id = result.task.reportIds[0]; assert.equal((await read(f, id)).status, "unconfirmed"); assert.equal((await read(f, id)).phase, "sending");
  await f.op(request); wakeTaskReportExecutor(f.agentDir); await waitForTaskReportExecutor(); assert.equal(f.calls.length, 1);
  for (const mode of ["length", "empty"]) {
    const next = await f.create(mode); await f.link(next.id, [f.session().getSessionId()]); const archive = await f.archive(next.id);
    await f.wait(() => f.calls.length === (mode === "length" ? 2 : 3)); f.respond(f.calls.length - 1, mode); await waitForTaskReportExecutor();
    assert.equal((await read(f, archive.result.task.reportIds[0])).status, "failed");
  }
});

test("capacity unable to hold even task/source context fails without truncation or sends; unavailable/unconfigured and uncommitted intents stay stopped", async t => {
  const f = await fixture(t, { contextWindow: 2000 }); await saveTaskReportSettings(f.selection, f.agentDir);
  const task = await f.create("Capacity"), source = f.session(`START ${"x".repeat(10000)} END`); await f.link(task.id, [source.getSessionId()]);
  const { result } = await f.archive(task.id); await waitForTaskReportExecutor();
  const report = await read(f, result.task.reportIds[0]); assert.equal(report.status, "failed"); assert.match(report.error, /capacity/); assert.ok(report.snapshot.sources[0].items[0].text.endsWith("END"));
  const uncommittedTask = await f.create("Uncommitted preparation"); await f.link(uncommittedTask.id, [f.session("Short orphan evidence").getSessionId()]);
  const orphan = await withTaskStore(f.agentDir, async document => ({ value: await prepareTaskReport(document.tasks.find(task => task.id === uncommittedTask.id), f.agentDir), changed: false }));
  wakeTaskReportExecutor(f.agentDir); await waitForTaskReportExecutor(); await assert.rejects(read(f, orphan), { code: "not-found" });
  await saveTaskReportSettings(null, f.agentDir);
  const waiting = await f.create("Awaiting"); await f.link(waiting.id, [f.session().getSessionId()]); const waitingArchive = await f.archive(waiting.id);
  await saveTaskReportSettings(f.selection, f.agentDir); wakeTaskReportExecutor(f.agentDir); await waitForTaskReportExecutor();
  assert.equal((await read(f, waitingArchive.result.task.reportIds[0])).status, "awaiting-configuration"); assert.equal(f.calls.length, 0);
});

test("plain model request uses off semantics, and a queued model becoming unavailable stops without fallback or later automatic charges", async t => {
  const f = await fixture(t);
  await saveTaskReportSettings({ provider: "report-plain", modelId: "same-id", thinkingLevel: "off" }, f.agentDir);
  const plain = await f.create("Plain model"); await f.link(plain.id, [f.session().getSessionId()]); const first = await f.archive(plain.id);
  await f.wait(() => f.calls.length === 1); assert.equal(f.calls[0].payload.reasoning_effort, undefined);
  await saveTaskReportSettings(f.selection, f.agentDir);
  const queued = await f.create("Queued unavailable model"); await f.link(queued.id, [f.session().getSessionId()]); const second = await f.archive(queued.id);
  const providers = structuredClone(f.providers); delete providers["report-reasoning"];
  await writeFile(join(f.agentDir, "models.json"), JSON.stringify({ providers }));
  f.respond(0); await waitForTaskReportExecutor();
  assert.equal((await read(f, first.result.task.reportIds[0])).status, "generated");
  const unavailable = await read(f, second.result.task.reportIds[0]); assert.equal(unavailable.status, "awaiting-configuration"); assert.equal(unavailable.configurationIssue, "model-unavailable"); assert.deepEqual(unavailable.selection, f.selection);
  await writeFile(join(f.agentDir, "models.json"), JSON.stringify({ providers: f.providers })); await saveTaskReportSettings(f.selection, f.agentDir);
  await f.op(second.request); await listTaskReports(undefined, f.agentDir); wakeTaskReportExecutor(f.agentDir); await waitForTaskReportExecutor();
  assert.equal(f.calls.length, 1); assert.equal((await read(f, unavailable.id)).status, "awaiting-configuration");
});
