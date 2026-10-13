import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { createJiti } from "jiti";
import { taskReportsFixture } from "./task-reports.fixture.mjs";
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { getTaskReport, listTaskReports, listQueuedTaskReports } = await jiti.import("./task-reports.ts");
const { saveTaskReportSettings } = await jiti.import("./task-report-settings.ts");
const { waitForTaskReportExecutor } = await jiti.import("./task-report-executor.ts");
const { setSessionArchived } = await jiti.import("./session-archive.ts");
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
async function fixture(t, options) { const f = await taskReportsFixture(options); t.after(() => f.close()); return f; }
const text = report => report.snapshot.sources.flatMap(s => s.items.map(i => i.text)).join("\n");

test("real commit freezes full active branches, edits, tools, compaction and running state; family scope never expands input", async t => {
  const f = await fixture(t, { contextWindow: 1500 }); await saveTaskReportSettings(f.selection, f.agentDir);
  const task = await f.create("Detailed archive"), other = await f.create("Other owner");
  const a = f.session("EARLY surviving history"), early = a.getLeafId();
  a.appendMessage({ role: "user", content: "ABANDONED unrelated branch", timestamp: 2 });
  a.branch(early);
  const removed = a.appendMessage({ role: "user", content: "REMOVED original", timestamp: 3 });
  const replaced = a.appendMessage({ role: "user", content: "REPLACED original", timestamp: 4 });
  a.appendMessage({ role: "assistant", content: [{ type: "thinking", thinking: "SECRET hidden thinking", thinkingSignature: "SECRET signature" }, { type: "text", text: "Observed claim" }, { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "test command" } }], stopReason: "toolUse", timestamp: 5 });
  a.appendMessage({ role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "TOOL observed result" }, { type: "image", data: "SECRET binary", mimeType: "image/png" }], isError: false, timestamp: 6 });
  a.appendMessage({ role: "bashExecution", command: "verify", output: "BASH evidence", exitCode: 0, cancelled: false, truncated: false, timestamp: 7 });
  a.appendCompaction("COMPACT summary", null, 5000);
  a.appendContextEdit(removed, null);
  a.appendContextEdit(replaced, { content: "EDITED replacement" });
  a.appendCustomMessageEntry("context-note", "CUSTOM text", false);
  const cutoff = a.getLeafId();
  const b = f.session("SECOND linked source");
  const child = f.session("FAMILY member must not enter report");
  child.appendCustomEntry("pi-web:subagent", { version: 1, parentSessionId: a.getSessionId(), parentSessionPath: a.getSessionFile(), profile: "worker", description: "fixture" });
  const lines = (await readFile(child.getSessionFile(), "utf8")).split("\n");
  lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), parentSession: a.getSessionFile() }); await writeFile(child.getSessionFile(), lines.join("\n"));
  await f.link(task.id, [a.getSessionId(), b.getSessionId()]); await f.link(other.id, [child.getSessionId()]);
  (globalThis.__piSessions ??= new Map()).set(a.getSessionId(), { sessionId: a.getSessionId(), inner: { sessionManager: a }, isAlive: () => true, hasDeletedSessionFile: () => false, isRunning: () => true });
  t.after(() => globalThis.__piSessions.delete(a.getSessionId()));
  const originalBytes = await readFile(a.getSessionFile()), originalTask = await f.current(task.id);
  const { request, result } = await f.archive(task.id, true), id = result.task.reportIds[0];
  await waitForTaskReportExecutor();
  const report = await getTaskReport(id, f.agentDir);
  assert.equal(report.status, "failed"); assert.match(report.error, /capacity/); assert.equal(report.body, null); assert.deepEqual(report.selection, f.selection);
  assert.equal(report.snapshot.sources.length, 2); assert.equal(report.snapshot.sources[0].leafId, cutoff); assert.equal(report.sources[0].activity.running, true);
  for (const present of ["EARLY", "SECOND", "EDITED", "TOOL observed", "test command", "COMPACT", "BASH evidence", "CUSTOM text", "Image attachment present"]) assert.ok(text(report).includes(present), present);
  for (const absent of ["ABANDONED", "REMOVED", "REPLACED original", "SECRET", "FAMILY member"]) assert.ok(!text(report).includes(absent), absent);
  assert.deepEqual(await readFile(a.getSessionFile()), originalBytes);
  assert.equal(result.task.revision, originalTask.revision); assert.equal(result.task.updatedAt, originalTask.updatedAt);
  assert.deepEqual((await f.op(request)).task.reportIds, [id]);
  const frozen = await f.reportBytes(id);
  a.appendMessage({ role: "user", content: "LATER excluded", timestamp: 8 }); a.branch(early);
  await saveTaskReportSettings({ provider: "report-plain", modelId: "same-id", thinkingLevel: "off" }, f.agentDir);
  await f.op({ action: "edit", id: task.id, expectedRevision: result.task.revision, title: "Later title", description: "Later goal", completionCriteria: "Later requirements", priority: 2, labels: ["later"] });
  const relation = (await f.op({ action: "sessions", id: task.id })).linked.find(s => s.id === b.getSessionId());
  await f.op({ action: "change-session-relation", sessionId: b.getSessionId(), sourceTaskId: task.id, targetTaskId: other.id, expectedGeneration: relation.relationGeneration, expectedUpdateRevision: relation.updateRevision, operationId: randomUUID() });
  await f.op({ action: "set-archive", id: task.id, archived: false, expectedArchiveRevision: 1, operationId: randomUUID() });
  assert.deepEqual(await f.reportBytes(id), frozen); assert.deepEqual(await listQueuedTaskReports(f.agentDir), []);
  const second = await f.archive(task.id); await waitForTaskReportExecutor(); assert.notEqual(second.result.task.reportIds[1], id);
  assert.deepEqual(await f.reportBytes(id), frozen); assert.equal((await listTaskReports(task.id, f.agentDir)).length, 2);
  await rm(a.getSessionFile()); assert.deepEqual(await f.reportBytes(id), frozen);
  const board = JSON.parse(await readFile(f.boardFile));
  assert.deepEqual(board.tasks[0].reportIds, second.result.task.reportIds); assert.equal(board.tasks[0].snapshot, undefined); assert.equal(board.tasks[0].body, undefined);
  assert.deepEqual(await readdir(f.cwd), []); assert.equal(f.requests(), 0);
});

test("preview, stale scope, same-state and sidebar archive create no extra reports", async t => {
  const f = await fixture(t), task = await f.create("Trigger"), s = f.session(); await f.link(task.id, [s.getSessionId()]);
  const preview = await f.op({ action: "preview-archive", id: task.id });
  assert.deepEqual(await listTaskReports(undefined, f.agentDir), []);
  await setSessionArchived(s.getSessionId(), true, f.agentDir); assert.deepEqual(await listTaskReports(undefined, f.agentDir), []);
  await f.link(task.id, [f.session("later").getSessionId()]);
  await assert.rejects(f.op({ action: "set-archive", id: task.id, archived: true, expectedArchiveRevision: 0, operationId: randomUUID(), cascade: { previewToken: preview.token, confirmCrossTask: true } }), { code: "conflict" });
  assert.deepEqual(await listTaskReports(undefined, f.agentDir), []);
  const { request, result } = await f.archive(task.id);
  assert.equal((await getTaskReport(result.task.reportIds[0], f.agentDir)).status, "awaiting-configuration");
  await f.op(request);
  await f.op({ ...request, operationId: randomUUID(), expectedArchiveRevision: 1 });
  assert.equal((await listTaskReports(task.id, f.agentDir)).length, 1); assert.equal(f.requests(), 0);
});

test("missing and empty sources produce readable metadata without configuration; partial missing stays explicit", async t => {
  const f = await fixture(t), empty = await f.create("No linked chats");
  const first = await f.archive(empty.id), metadata = await getTaskReport(first.result.task.reportIds[0], f.agentDir);
  assert.equal(metadata.status, "generated"); assert.match(metadata.body, /Original goal/); assert.match(metadata.body, /No linked conversations/);
  const missing = await f.create("Deleted sources"), s = f.session(); await f.link(missing.id, [s.getSessionId()]); await rm(s.getSessionFile());
  const second = await f.archive(missing.id), report = await getTaskReport(second.result.task.reportIds[0], f.agentDir);
  assert.equal(report.status, "generated"); assert.equal(report.sources[0].status, "missing"); assert.match(report.body, /missing/);
  const partial = await f.create("Partial"); await f.link(partial.id, [f.session("Available partial").getSessionId()]);
  // Real historical missing link: append the deleted ID to the original task before deleting its file.
  const doomed = f.session(); await f.link(partial.id, [doomed.getSessionId()]); await rm(doomed.getSessionFile());
  const third = await f.archive(partial.id), partialReport = await getTaskReport(third.result.task.reportIds[0], f.agentDir);
  assert.equal(partialReport.status, "awaiting-configuration"); assert.deepEqual(partialReport.sources.map(s => s.status), ["available", "missing"]);
  assert.match(text(partialReport), /Available partial/);
  await saveTaskReportSettings(f.selection, f.agentDir);
  assert.equal((await getTaskReport(partialReport.id, f.agentDir)).status, "awaiting-configuration"); assert.deepEqual(await listQueuedTaskReports(f.agentDir), []);
  assert.equal(f.requests(), 0);
});

test("unavailable model and invalid level freeze reasons without fallback", async t => {
  const f = await fixture(t);
  for (const [selection, reason] of [[{ ...f.selection, provider: "missing" }, "model-unavailable"], [{ ...f.selection, thinkingLevel: "auto" }, "invalid-level"]]) {
    await writeFile(f.settingsPath, JSON.stringify({ ...f.initial, taskArchiveReport: selection }));
    const task = await f.create(reason); await f.link(task.id, [f.session().getSessionId()]);
    const { result } = await f.archive(task.id), report = await getTaskReport(result.task.reportIds[0], f.agentDir);
    assert.equal(report.status, "awaiting-configuration"); assert.equal(report.configurationIssue, reason); assert.deepEqual(report.selection, selection);
  }
  assert.equal(f.requests(), 0);
});

test("failed board commit leaves no executable intent; snapshot write failure does not archive", async t => {
  const f = await fixture(t), task = await f.create("Failed commit");
  await f.link(task.id, [f.session().getSessionId()]);
  const originalLock = lockfile.lock;
  let options, injected = false;
  lockfile.lock = async (file, opts) => {
    if (file.endsWith("board.json")) options = opts;
    const release = await originalLock(file, opts);
    if (file.endsWith("settings.json") && !injected) { injected = true; options.onCompromised(new Error("Synthetic board commit failure")); }
    return release;
  };
  try { await assert.rejects(f.archive(task.id), { code: "storage-unavailable" }); }
  finally { lockfile.lock = originalLock; }
  const [preparedFile] = await readdir(join(f.agentDir, "task-reports")), preparedId = preparedFile.replace(/\.json$/, "");
  assert.ok(injected && preparedId); assert.equal((await f.current(task.id)).archived, false);
  assert.deepEqual(await listTaskReports(undefined, f.agentDir), []); assert.deepEqual(await listQueuedTaskReports(f.agentDir), []);
  await assert.rejects(getTaskReport(preparedId, f.agentDir), { code: "not-found" });
  await rm(join(f.agentDir, "task-reports"), { recursive: true }); await writeFile(join(f.agentDir, "task-reports"), "not a directory");
  await assert.rejects(f.archive(task.id), { code: "storage-unavailable" }); assert.equal((await f.current(task.id)).archived, false);
});

test("session cascade pending retains exactly one independent report", async t => {
  const f = await fixture(t), task = await f.create("Pending sessions"), s = f.session(); await f.link(task.id, [s.getSessionId()]);
  await writeFile(join(f.agentDir, "session-archive.json"), "broken");
  const request = { action: "set-archive", id: task.id, archived: true, expectedArchiveRevision: 0, operationId: randomUUID(), cascade: { previewToken: (await f.op({ action: "preview-archive", id: task.id })).token, confirmCrossTask: false } };
  await assert.rejects(f.op(request), { code: "storage-unavailable" });
  const archived = await f.current(task.id); assert.equal(archived.archived, true); assert.ok(archived.pendingSessionArchive); assert.equal(archived.reportIds.length, 1);
  assert.equal((await listTaskReports(task.id, f.agentDir)).length, 1);
  await rm(join(f.agentDir, "session-archive.json")); await f.op(request);
  assert.deepEqual((await f.current(task.id)).reportIds, archived.reportIds); assert.equal(f.requests(), 0);
});

test("large history and long tool result are fully captured, without old summary limits", async t => {
  const f = await fixture(t), task = await f.create("Long"), s = f.session("EARLY long history");
  const long = `START-${"x".repeat(17 * 1024 * 1024)}-END`;
  s.appendMessage({ role: "toolResult", toolName: "read", toolCallId: "long", content: [{ type: "text", text: long }], isError: false, timestamp: 2 });
  await f.link(task.id, [s.getSessionId()]);
  const { result } = await f.archive(task.id), report = await getTaskReport(result.task.reportIds[0], f.agentDir);
  assert.ok(text(report).includes(long)); assert.equal(report.sources[0].status, "available"); assert.equal(f.requests(), 0);
});

test("real warm wrapper preserves selected/null leaf, distinguishes unflushed from deleted source", async t => {
  const f = await fixture(t), task = await f.create("Warm leaf"), s = f.session("Selected earlier branch"), leaf = s.getLeafId();
  s.appendMessage({ role: "user", content: "Unselected disk tail", timestamp: 2 }); s.branch(leaf);
  const register = manager => {
    const inner = { sessionManager: manager, sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0 };
    const wrapper = new AgentSessionWrapper(inner);
    (globalThis.__piSessions ??= new Map()).set(wrapper.sessionId, wrapper);
    t.after(() => globalThis.__piSessions.delete(wrapper.sessionId));
    return wrapper;
  };
  const wrapper = register(s);
  assert.equal(wrapper.hasDeletedSessionFile(), false);
  await f.link(task.id, [s.getSessionId()]); const { result } = await f.archive(task.id);
  assert.equal(text(await getTaskReport(result.task.reportIds[0], f.agentDir)), "Selected earlier branch");
  await f.op({ action: "set-archive", id: task.id, archived: false, expectedArchiveRevision: 1, operationId: randomUUID() }); s.resetLeaf();
  const second = await f.archive(task.id), empty = await getTaskReport(second.result.task.reportIds[1], f.agentDir);
  assert.equal(empty.status, "generated"); assert.equal(empty.sources[0].leafId, null);
  assert.deepEqual(empty.snapshot.sources[0].items, []); assert.equal(s.getLeafId(), null, "capture does not change the warm leaf");
  await rm(s.getSessionFile()); assert.equal(wrapper.hasDeletedSessionFile(), true);
  await f.op({ action: "set-archive", id: task.id, archived: false, expectedArchiveRevision: 3, operationId: randomUUID() });
  const third = await f.archive(task.id), deleted = await getTaskReport(third.result.task.reportIds[2], f.agentDir);
  assert.equal(deleted.sources[0].status, "missing"); assert.deepEqual(deleted.snapshot.sources[0].items, [], "deleted disk source is not resurrected from warm history");
  const unflushed = SessionManager.create(f.cwd), unflushedWrapper = register(unflushed), freshTask = await f.create("Unflushed source");
  await assert.rejects(readFile(unflushed.getSessionFile()), { code: "ENOENT" });
  assert.equal(unflushedWrapper.hasDeletedSessionFile(), false);
  await f.link(freshTask.id, [unflushed.getSessionId()]);
  const fresh = await f.archive(freshTask.id), freshReport = await getTaskReport(fresh.result.task.reportIds[0], f.agentDir);
  assert.equal(freshReport.status, "generated"); assert.equal(freshReport.sources[0].status, "available"); assert.equal(freshReport.sources[0].leafId, null);
  await assert.rejects(readFile(unflushed.getSessionFile()), { code: "ENOENT" });
  assert.equal(f.requests(), 0);
});
