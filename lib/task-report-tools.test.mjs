import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createJiti } from "jiti";
import { reportGenerationFixture, REPORT_TEXT } from "./task-report-generation.fixture.mjs";
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { startRpcSession, getRpcSession } = await jiti.import("./rpc-manager.ts");
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { PRESET_DEFAULT, PRESET_READ_ONLY, TASK_REPORT_TOOL_NAMES } = await jiti.import("./tool-presets.ts");
const { getTaskReport, readTaskReportText, regenerateTaskReport, searchTaskReports } = await jiti.import("./task-reports.ts");
const { saveTaskReportSettings } = await jiti.import("./task-report-settings.ts");
const { waitForTaskReportExecutor } = await jiti.import("./task-report-executor.ts");
const { GET } = await jiti.import("../app/api/task-reports/route.ts");

async function bytes(dir, prefix = "") {
  const result = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name), key = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(result, await bytes(path, key + "/"));
    else result[key] = createHash("sha256").update(await readFile(path)).digest("hex");
  }
  return result;
}
async function agent(t, f, toolNames) {
  const { session } = await startRpcSession(randomUUID(), "", f.cwd, { ...(toolNames === undefined ? {} : { toolNames }), headless: true });
  t.after(() => session.destroy());
  await session.waitUntilReady();
  return session;
}
async function call(wrapper, name, args) {
  const tool = wrapper.inner.agent.state.tools.find(tool => tool.name === name);
  assert.ok(tool, `registered active ${name}`);
  const result = await tool.execute(randomUUID(), args);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  return result.structuredContent;
}
async function full(wrapper, reportId, materialId, expected) {
  let offset = 0, text = "", pages = 0;
  while (true) {
    const page = await call(wrapper, "read_task_report", { reportId, ...(materialId ? { materialId } : {}), offset, limit: 79 });
    assert.equal(page.offset, offset); assert.equal(page.totalLength, expected.length);
    text += page.text; pages++;
    if (page.end) { assert.equal(page.next, null); break; }
    assert.ok(page.next > offset); offset = page.next;
  }
  assert.ok(pages > 1); assert.equal(text, expected);
  assert.equal((await call(wrapper, "read_task_report", { reportId, ...(materialId ? { materialId } : {}), offset: expected.length })).text, "");
}
async function finish(f, cursor, text = REPORT_TEXT) {
  await f.wait(() => f.calls.length === cursor + 1); f.respond(cursor, "success", text); await waitForTaskReportExecutor();
}

test("actual RPC registration/execution searches real global short, layered and regenerated archives; frozen filters, every material and full pagination; deleted sources, zero writes/requests", async t => {
  const f = await reportGenerationFixture(); t.after(() => f.close());
  await saveTaskReportSettings(f.selection, f.agentDir);
  const records = [], sources = [];
  for (const [name, project] of [["Project A", "a"], ["Project B", "b"], ["No project", null]]) {
    const cwd = project ? join(f.agentDir, project) : f.cwd; if (project) await mkdir(cwd);
    const task = (await f.op({ action: "create", id: randomUUID(), title: name, description: `GOAL_${name}`, completionCriteria: `CRITERIA_${name}`, cwd: project ? cwd : null })).task;
    const source = SessionManager.create(cwd); source.appendMessage({ role: "user", content: "source evidence", timestamp: 1 }); sources.push(source);
    await f.link(task.id, [source.getSessionId()]); const { result } = await f.archive(task.id), id = result.task.reportIds[0];
    await finish(f, records.length, REPORT_TEXT + `\nBODY_${name} 😀\nSHORT_TAIL`);
    records.push({ task, id });
  }
  const layeredTask = await f.create("Layered dossier"), source = f.session("EARLY " + "evidence ".repeat(7000) + " TAIL"); sources.push(source);
  await f.link(layeredTask.id, [source.getSessionId()]); const { result } = await f.archive(layeredTask.id), layeredId = result.task.reportIds[0];
  let cursor = 3;
  while (true) {
    await f.wait(() => f.calls.length === cursor + 1);
    const input = JSON.parse(f.calls[cursor].payload.messages.find(message => message.role === "user").content);
    f.respond(cursor++, "success", input.operation === "synthesis" ? REPORT_TEXT + " 😀 FINAL_TAIL" : (input.operation === "detailed-material" ? "BOTTOM_ONLY_KEYWORD " : "INTERMEDIATE_ONLY_KEYWORD ") + "😀 detail ".repeat(180) + " MATERIAL_TAIL");
    if (input.operation === "synthesis") break;
  }
  await waitForTaskReportExecutor();
  const layered = await getTaskReport(layeredId, f.agentDir); assert.ok(layered.materials.some(material => material.level > 0));
  const newer = await regenerateTaskReport(records[0].id, randomUUID(), f.agentDir); await finish(f, cursor++);
  await saveTaskReportSettings(null, f.agentDir);
  const waitingTask = await f.create("Waiting archive"), waitingSource = f.session(); sources.push(waitingSource);
  await f.link(waitingTask.id, [waitingSource.getSessionId()]); await f.archive(waitingTask.id); await waitForTaskReportExecutor();
  // Current task project changes do not rewrite frozen report project filters.
  const selected = records[0].task;
  const current = await f.current(selected.id);
  const preview = await f.op({ action: "preview-project", id: selected.id, cwd: null });
  await f.op({ action: "change-project", id: selected.id, cwd: null, expectedRevision: current.revision, previewToken: preview.token, operationId: randomUUID() });
  for (const source of sources) { assert.equal(getRpcSession(source.getSessionId()), undefined); await rm(source.getSessionFile()); }
  const wrapper = await agent(t, f, PRESET_DEFAULT);
  const before = await bytes(f.agentDir), requestCount = f.calls.length;
  assert.ok(!JSON.stringify(wrapper.inner.messages).includes("FINAL_TAIL"), "no automatic report injection");
  const all = await call(wrapper, "search_task_reports", {}); assert.equal(all.total, 5);
  assert.ok(all.reports.every(report => !('body' in report) && !('snapshot' in report) && report.overview.length <= 480));
  assert.ok(all.reports.every(report => report.sources.every(source => !('items' in source))));
  assert.deepEqual((await call(wrapper, "search_task_reports", { taskId: selected.id })).reports.map(report => report.id), [records[0].id, newer.id]);
  assert.equal((await call(wrapper, "search_task_reports", { project: selected.project.projectRoot })).total, 2);
  assert.equal((await call(wrapper, "search_task_reports", { project: records[1].task.project.projectRoot })).total, 1);
  assert.equal((await call(wrapper, "search_task_reports", { project: null })).total, 2);
  assert.equal((await call(wrapper, "search_task_reports", { project: "/not-a-project" })).total, 0);
  for (const keyword of ["goal_Project B", "criteria_Project B", "body_Project B"]) assert.equal((await call(wrapper, "search_task_reports", { keyword })).reports[0].id, records[1].id);
  for (const keyword of ["bottom_only_keyword", "intermediate_only_keyword"]) {
    const hit = await call(wrapper, "search_task_reports", { keyword, project: null, taskId: layeredTask.id }); assert.equal(hit.total, 1); assert.equal(hit.reports[0].id, layeredId);
  }
  assert.equal((await call(wrapper, "search_task_reports", { keyword: "INTERMEDIATE_ONLY_KEYWORD", project: selected.project.projectRoot })).total, 0);
  let offset = 0, ids = [];
  while (true) { const page = await call(wrapper, "search_task_reports", { offset, limit: 2 }); ids.push(...page.reports.map(report => report.id)); if (page.end) { assert.equal(page.next, null); break; } offset = page.next; }
  assert.deepEqual(ids, all.reports.map(report => report.id));
  for (const record of [...records, { id: newer.id }, { id: layeredId }]) await full(wrapper, record.id, undefined, await readTaskReportText(record.id, undefined, f.agentDir));
  for (const material of layered.materials) {
    await full(wrapper, layeredId, material.id, material.body);
    const response = await GET(new Request(`http://localhost/api/task-reports?id=${layeredId}&material=${material.id}`)); assert.equal(await response.text(), material.body);
  }
  const shortBody = await readTaskReportText(records[0].id, undefined, f.agentDir), emoji = shortBody.indexOf("😀");
  const unicodePage = await call(wrapper, "read_task_report", { reportId: records[0].id, offset: emoji, limit: 1 });
  assert.equal(unicodePage.text, "😀"); assert.equal(unicodePage.next, emoji + 2);
  await assert.rejects(call(wrapper, "read_task_report", { reportId: records[0].id, offset: emoji + 1, limit: 1 }));
  for (const params of [{ reportId: randomUUID() }, { reportId: layeredId, materialId: "synthesis-99-99" }, { reportId: "../../settings.json" }, { reportId: layeredId, offset: 9999999 }, { reportId: layeredId, limit: 0 }]) await assert.rejects(call(wrapper, "read_task_report", params));
  await assert.rejects(call(wrapper, "search_task_reports", { taskId: "bad" }));
  await assert.rejects(call(wrapper, "search_task_reports", { limit: 0 }));
  assert.equal(f.calls.length, requestCount); assert.deepEqual(await bytes(f.agentDir), before);
  for (const source of sources) assert.equal(getRpcSession(source.getSessionId()), undefined);
});

test("actual default/read-only pins, configured defaultTools on/off, Chat-only, in-place switch and reload preserve tool policy", async t => {
  const f = await reportGenerationFixture(); t.after(() => f.close());
  const task = await f.create("Metadata"), { result } = await f.archive(task.id), id = result.task.reportIds[0];
  const readOnly = await agent(t, f, PRESET_READ_ONLY);
  assert.ok(!readOnly.inner.getActiveToolNames().some(name => ["bash", "write", "edit"].includes(name)));
  for (const name of TASK_REPORT_TOOL_NAMES) assert.ok((await readOnly.send({ type: "get_tools" })).find(tool => tool.name === name).active);
  assert.equal((await call(readOnly, "search_task_reports", {})).total, 1); await full(readOnly, id, undefined, await readTaskReportText(id, undefined, f.agentDir));
  await readOnly.send({ type: "set_tools", toolNames: ["read"] }); assert.ok(TASK_REPORT_TOOL_NAMES.every(name => !readOnly.inner.getActiveToolNames().includes(name)));
  await readOnly.send({ type: "set_tools", toolNames: PRESET_READ_ONLY });
  await readOnly.send({ type: "reload" }); assert.equal((await call(readOnly, "search_task_reports", {})).total, 1);
  const off = await agent(t, f); assert.ok(TASK_REPORT_TOOL_NAMES.every(name => !off.inner.getActiveToolNames().includes(name)));
  const settingsFile = join(f.agentDir, "settings.json"), settings = JSON.parse(await readFile(settingsFile, "utf8"));
  await writeFile(settingsFile, JSON.stringify({ ...settings, defaultTools: ["+search_task_reports", "+read_task_report"] }));
  const on = await agent(t, f); assert.equal((await call(on, "search_task_reports", {})).total, 1);
  await writeFile(settingsFile, JSON.stringify({ ...settings, defaultTools: ["+search_task_reports", "+read_task_report", "+codemode"], codemode: { mode: "only" } }));
  const scripted = await agent(t, f, PRESET_READ_ONLY);
  const declared = await scripted.send({ type: "get_tools" });
  assert.ok(TASK_REPORT_TOOL_NAMES.every(name => declared.find(tool => tool.name === name).declarationHidden));
  const codemode = scripted.inner.agent.state.tools.find(tool => tool.name === "codemode");
  const parentId = randomUUID();
  // Nested SDK calls require an assistant parent. Seed only this test agent's transient state;
  // no provider request, source session or persisted report/task is involved.
  scripted.inner.agent.state.messages.push({ role: "assistant", content: [{ type: "toolCall", id: parentId, name: "codemode", arguments: {} }], api: "openai-completions", provider: "controlled", model: "controlled", stopReason: "toolUse", timestamp: 1 });
  const beforeScript = await bytes(f.agentDir);
  const script = await codemode.execute(parentId, { code: `const hits = await tools.search_task_reports({}); const page = await tools.read_task_report({ reportId: hits.reports[0].id, limit: 10 }); text({ total: hits.total, text: page.text, next: page.next });` });
  const output = script.content.map(block => block.text).join("\n");
  assert.match(output, /Script completed/, JSON.stringify(script)); assert.match(output, /"total":\s*1/);
  assert.deepEqual(await bytes(f.agentDir), beforeScript);
  const invalid = await codemode.execute(randomUUID(), { code: `await tools.read_task_report({ reportId: ${JSON.stringify(id)}, limit: 0 });` }); assert.match(invalid.content.map(block => block.text).join("\n"), /Script failed/);
  await scripted.send({ type: "set_tools", toolNames: ["read"] });
  const blocked = await codemode.execute(randomUUID(), { code: `await tools.search_task_reports({});` }); assert.match(blocked.content.map(block => block.text).join("\n"), /Script failed/);
  await writeFile(settingsFile, JSON.stringify({ ...settings, defaultTools: ["+search_task_reports", "+read_task_report", "-search_task_reports", "-read_task_report"] }));
  const toggledOff = await agent(t, f); assert.ok(TASK_REPORT_TOOL_NAMES.every(name => !toggledOff.inner.getActiveToolNames().includes(name)));
  await writeFile(settingsFile, JSON.stringify({ ...settings, defaultTools: [] }));
  const none = await agent(t, f); assert.ok(TASK_REPORT_TOOL_NAMES.every(name => !none.inner.getActiveToolNames().includes(name)));
  const chatOnly = await agent(t, f, []); assert.deepEqual(chatOnly.inner.getActiveToolNames(), []);
  assert.ok(TASK_REPORT_TOOL_NAMES.every(name => !chatOnly.inner.getAllTools().some(tool => tool.name === name)));
  assert.equal(f.calls.length, 0);
});

test("searching an empty global space creates no board, index, lock or report", async t => {
  const f = await reportGenerationFixture(); t.after(() => f.close());
  const before = await bytes(f.agentDir);
  assert.deepEqual(await searchTaskReports({}, f.agentDir), { reports: [], total: 0, offset: 0, next: null, end: true });
  assert.deepEqual(await bytes(f.agentDir), before); assert.equal(f.calls.length, 0);
});
