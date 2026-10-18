// Real TaskInspector/TaskReports + task/report HTTP handlers and temporary native history.
// Browser transport is bridged; local controlled SDK provider only, no Next service or user data.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright";
import { createJiti } from "jiti";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { reportGenerationFixture, REPORT_TEXT } from "../lib/task-report-generation.fixture.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const { GET, POST: RETRY } = await jiti.import("../app/api/task-reports/route.ts");
const { GET: GET_TASKS, POST } = await jiti.import("../app/api/tasks/route.ts");
const { getTaskReport, getTaskReportHistory } = await jiti.import("../lib/task-reports.ts");
const { saveTaskReportSettings } = await jiti.import("../lib/task-report-settings.ts");
const { wakeTaskReportExecutor, waitForTaskReportExecutor } = await jiti.import("../lib/task-report-executor.ts");
const locales = [];
for (const id of ["en", "zh-CN", "zh-TW"]) locales.push(Object.values(await jiti.import(`../lib/i18n/messages/${id}.ts`))[0]);
const { outputFiles } = await build({
  absWorkingDir: root, bundle: true, write: false, outfile: "report-ui.js", platform: "browser", format: "iife", jsx: "automatic",
  loader: { ".css": "local-css" }, define: { "process.env.NODE_ENV": '"development"' },
  stdin: { resolveDir: root, loader: "tsx", contents: `
    import React, {useState} from "react";
    import {createRoot} from "react-dom/client";
    import {TaskInspector} from "./components/TaskInspector";
    import {I18nProvider} from "./hooks/useI18n";
    import styles from "./components/TaskDashboard.module.css";
    function App() {
      const [task, setTask] = useState(window.initialTask);
      window.showTask = setTask;
      return <div className={styles.dashboard}><TaskInspector task={task} visibleTasks={[task]} sort="manual" disabled={false}
        onClose={()=>{}} onMove={()=>{}} feedback={null} onArchive={async ()=> {
          const response = await fetch("/api/tasks", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"set-archive",id:task.id,archived:!task.archived,expectedArchiveRevision:task.archiveRevision,operationId:crypto.randomUUID()})});
          const result = await response.json(); if(response.ok) setTask(result.task);
        }}><h2>{task.title}</h2></TaskInspector></div>;
    }
    createRoot(document.getElementById("root")).render(<I18nProvider><App/></I18nProvider>);
  ` },
});
// Only the Next URL context is supplied by the harness; Panel/Dashboard/children are real.
const { outputFiles: dashboardFiles } = await build({
  absWorkingDir: root, bundle: true, write: false, outfile: "report-dashboard.js", platform: "browser", format: "iife", jsx: "automatic",
  loader: { ".css": "local-css" }, define: { "process.env.NODE_ENV": '"development"', "process.env": "{}" },
  plugins: [{ name: "url-context", setup(build) {
    build.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "navigation", namespace: "url-context" }));
    build.onLoad({ filter: /.*/, namespace: "url-context" }, () => ({ contents: "export const useSearchParams = () => new URLSearchParams(location.search);" }));
  } }],
  stdin: { resolveDir: root, loader: "tsx", contents: `
    import React, {useState} from "react";
    import {createRoot} from "react-dom/client";
    import {TaskPanel} from "./components/TaskPanel";
    import {I18nProvider} from "./hooks/useI18n";
    function App() {
      const [open, setOpen] = useState(true);
      const [requestedTask, setRequestedTask] = useState(null);
      window.openTask = id => {setRequestedTask({id, request: Date.now()}); setOpen(true);};
      return <><button onClick={()=>setOpen(true)}>Reopen panel</button>
        <TaskPanel open={open} onClose={()=>setOpen(false)} sessionId={null} requestedTask={requestedTask} onNavigate={async()=>{}} /></>;
    }
    createRoot(document.getElementById("root")).render(<I18nProvider><App/></I18nProvider>);
  ` },
});
const evidence = await mkdtemp(join(tmpdir(), "pi-web-task-reports-ui-"));
async function dashboardLifecycle(browser, locale) {
  const f = await reportGenerationFixture();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage(), errors = [], unexpected = [], operations = [];
  const m = key => locale.messages[key];
  let holdTask = null, releaseRead = null, dropOperation = false;
  page.on("pageerror", e => errors.push(e.message));
  await context.addInitScript(id => {
    localStorage.setItem("pi-locale", id);
    window.reportReads = [];
    const original = window.fetch;
    window.fetch = (...args) => {
      const url = new URL(args[0], location.href);
      if (url.pathname === "/api/task-reports" && url.searchParams.has("taskId")) {
        const entry = { taskId: url.searchParams.get("taskId"), aborted: false };
        window.reportReads.push(entry);
        args[1]?.signal?.addEventListener("abort", () => {entry.aborted = true;}, {once:true});
      }
      return original(...args);
    };
  }, locale.id);
  await context.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
    if (url.pathname === "/api/agent/running") return route.fulfill({ json: { runningSessionIds: [], sessionActivity: {} } });
    if (url.pathname === "/api/tasks" || url.pathname === "/api/task-reports") {
      const isPost = request.method() === "POST", report = url.pathname === "/api/task-reports";
      if (report && isPost) operations.push(JSON.parse(request.postData()));
      const response = report ? isPost ? await RETRY(new Request(request.url(), {method: "POST", body: request.postData()})) : await GET(new Request(request.url()))
        : isPost ? await POST(new Request(request.url(), {method: "POST", body: request.postData()})) : await GET_TASKS(new Request(request.url()));
      const body = await response.text();
      if (report && holdTask && url.searchParams.get("taskId") === holdTask) {
        holdTask = null;
        await new Promise(resolve => { releaseRead = resolve; });
      }
      if (report && isPost && dropOperation) { dropOperation = false; return route.abort(); }
      return route.fulfill({status: response.status, contentType: response.headers.get("content-type"), body}).catch(() => {});
    }
    unexpected.push(`${request.method()} ${url.pathname}`); return route.abort();
  });
  const inspector = id => page.locator(`[data-task-inspector="${id}"]`);
  const section = id => inspector(id).getByRole("region", {name: m("reports.archive.title")});
  const countReads = id => page.evaluate(id => window.reportReads.filter(read => !id || read.taskId === id).length, id);
  const stopped = async id => {
    const count = await countReads(id);
    await page.waitForTimeout(2200); // Two real 1-second polling intervals, no fake timers.
    assert.equal(await countReads(id), count, `${id ?? "all"} hidden report GETs must stop`);
  };
  const holdNext = async id => {
    holdTask = id;
    await f.wait(() => releaseRead !== null, "in-flight browser GET");
  };
  const cancelled = async id => {
    await page.waitForFunction(id => window.reportReads.filter(read => read.taskId === id).at(-1)?.aborted, id);
    releaseRead(); releaseRead = null;
  };
  try {
    await saveTaskReportSettings(f.selection, f.agentDir);
    const a = await f.create("Lifecycle A"), b = await f.create("Lifecycle B");
    for (const task of [a, b]) { await f.link(task.id, [f.session(task.title).getSessionId()]); await f.archive(task.id); }
    await f.wait(() => f.calls.length === 1);
    await page.goto("http://localhost/");
    await page.addStyleTag({content: `*{box-sizing:border-box}body{margin:0;font-family:Arial}:root{--bg:#fff;--bg-panel:#f5f5f5;--border:#ddd;--text:#222;--text-dim:#666;--text-muted:#555;--accent:#245bce}${dashboardFiles.find(file => file.path.endsWith(".css")).text}`});
    await page.addScriptTag({content: dashboardFiles.find(file => file.path.endsWith(".js")).text});
    await page.waitForFunction(() => typeof window.openTask === "function");
    await page.evaluate(id => window.openTask(id), a.id);
    await section(a.id).getByRole("status").filter({hasText: m("reports.archive.status.generating")}).waitFor();
    await holdNext(a.id);
    await page.evaluate(id => window.openTask(id), b.id);
    await section(b.id).getByRole("status").filter({hasText: m("reports.archive.status.queued")}).waitFor();
    await cancelled(a.id); await stopped(a.id);
    assert.equal(await page.locator("[data-task-inspector]").count(), 2, "viewed inspectors remain cached");
    await holdNext(b.id);
    await inspector(b.id).getByRole("button", {name: m("tasks.panel.closeDetails"), exact: true}).click();
    await cancelled(b.id); await stopped();
    const before = await countReads(a.id);
    await page.evaluate(id => window.openTask(id), a.id);
    await section(a.id).getByRole("status").filter({hasText: m("reports.archive.status.generating")}).waitFor();
    assert.ok(await countReads(a.id) > before, "reopening detail rereads");
    await holdNext(a.id);
    // Real panel Escape closes without unmounting the selected Inspector.
    await page.keyboard.press("Escape"); // First Escape closes detail.
    await cancelled(a.id);
    await page.evaluate(id => window.openTask(id), a.id);
    await section(a.id).getByRole("status").filter({hasText: m("reports.archive.status.generating")}).waitFor();
    await holdNext(a.id);
    await page.getByRole("button", {name: m("tasks.panel.close"), exact: true}).click({force: true});
    await cancelled(a.id); await stopped();
    assert.equal(f.calls.length, 1, "hiding does not send another model request");
    f.respond(0); await f.wait(() => f.calls.length === 2); f.respond(1, "error"); await waitForTaskReportExecutor();
    assert.equal((await getTaskReport((await f.current(a.id)).reportIds[0], f.agentDir)).status, "generated", "backend completes while panel hidden");
    await page.evaluate(id => window.openTask(id), b.id);
    await section(b.id).getByRole("status").filter({hasText: m("reports.archive.status.failed")}).waitFor();
    // Lost-response retry and regeneration retain exact IDs across A/B, detail and panel hiding.
    for (const action of ["retry", "regenerate"]) {
      const index = operations.length;
      dropOperation = true;
      await section(b.id).getByRole("button", {name: m(`reports.archive.${action}`), exact: true}).click();
      await section(b.id).getByRole("button", {name: m(`reports.archive.${action}Exact`), exact: true}).waitFor();
      await f.wait(() => f.calls.length === (action === "retry" ? 3 : 4));
      await page.evaluate(id => window.openTask(id), a.id);
      await section(a.id).getByRole("status").filter({hasText: m("reports.archive.status.generated")}).waitFor();
      await page.getByRole("button", {name: m("tasks.panel.close"), exact: true}).click({force: true});
      await stopped();
      await page.evaluate(id => window.openTask(id), b.id);
      await section(b.id).getByRole("status").filter({hasText: m("reports.archive.status.generating")}).waitFor();
      await inspector(b.id).getByRole("button", {name: m("tasks.panel.closeDetails"), exact: true}).click();
      await stopped();
      await page.evaluate(id => window.openTask(id), b.id);
      const exact = section(b.id).getByRole("button", {name: m(`reports.archive.${action}Exact`), exact: true});
      await exact.waitFor(); await exact.click();
      await exact.waitFor({state: "detached"});
      assert.equal(operations[index].operationId, operations[index + 1].operationId);
      assert.equal(f.calls.length, action === "retry" ? 3 : 4, "exact confirmation never sends another request");
      f.respond(action === "retry" ? 2 : 3); await waitForTaskReportExecutor();
      await section(b.id).getByRole("status").filter({hasText: m("reports.archive.status.generating")}).waitFor({state: "detached"});
    }
    await section(b.id).getByRole("link", {name: m("reports.archive.latestSuccessful"), exact: true}).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await inspector(b.id).screenshot({path: join(evidence, `${locale.id}-390-dashboard-lifecycle.png`)});
    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
    console.log(`PASS ${locale.id} 390 Dashboard: A/B GET cancellation/poll stop/reopen, cached inspectors, hidden backend completion, retry/regeneration exact IDs`);
  } catch (error) {
    console.error("Dashboard browser errors:", errors, "Unexpected requests:", unexpected);
    throw error;
  } finally { releaseRead?.(); await context.close(); await f.close(); }
}
const browser = await chromium.launch({ headless: true });
try {
  for (const locale of locales) await dashboardLifecycle(browser, locale);
  for (const locale of locales) for (const width of [1100, 390]) {
    const f = await reportGenerationFixture(), empty = await f.create("Empty archive via UI");
    await saveTaskReportSettings(f.selection, f.agentDir);
    const queued = await f.create("Queued source"), source = f.session("Synthetic work evidence"); await f.link(queued.id, [source.getSessionId()]);
    await f.archive(queued.id);
    await saveTaskReportSettings(null, f.agentDir);
    const pending = await f.create("Missing source coverage"), a = f.session(), b = f.session(); await f.link(pending.id, [a.getSessionId(), b.getSessionId()]); await rm(b.getSessionFile()); await f.archive(pending.id);
    const context = await browser.newContext({ viewport: { width, height: 844 } }); let page = await context.newPage();
    const errors = [], unexpected = []; page.on("pageerror", e => errors.push(e.message));
    let taskWrites = 0, dropRetry = false;
    const retryRequests = [];
    const m = key => locale.messages[key];
    await context.addInitScript(({ id, task }) => { localStorage.setItem("pi-locale", id); window.initialTask = task; }, { id: locale.id, task: empty });
    await context.route("**/*", async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path === "/") return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
      if (path === "/api/task-reports" || path === "/api/tasks") {
        if (path === "/api/tasks") taskWrites++;
        const isRetry = path === "/api/task-reports" && request.method() === "POST";
        if (isRetry) retryRequests.push(JSON.parse(request.postData()));
        const response = path === "/api/tasks" ? await POST(new Request(request.url(), { method: "POST", body: request.postData() }))
          : isRetry ? await RETRY(new Request(request.url(), { method: "POST", body: request.postData() })) : await GET(new Request(request.url()));
        if (isRetry && dropRetry) { dropRetry = false; return route.abort(); }
        return route.fulfill({ status: response.status, contentType: response.headers.get("content-type"), body: await response.text() });
      }
      unexpected.push(`${request.method()} ${path}`); return route.abort();
    });
    try {
      await page.goto("http://localhost/");
      await page.addStyleTag({ content: `*{box-sizing:border-box}body{margin:0;font-family:Arial}:root{--bg:#fff;--bg-panel:#f5f5f5;--border:#ddd;--text:#222;--text-dim:#666;--text-muted:#555;--accent:#245bce}${outputFiles.find(file => file.path.endsWith(".css")).text}` });
      await page.addScriptTag({ content: outputFiles.find(file => file.path.endsWith(".js")).text });
      await page.waitForFunction(() => document.documentElement.lang === localStorage.getItem("pi-locale"));
      assert.equal(await page.getByRole("region", { name: m("reports.archive.title") }).count(), 0);
      await page.getByRole("button", { name: `${m("tasks.archive.archive")}: ${empty.title}`, exact: true }).click();
      let section = page.getByRole("region", { name: m("reports.archive.title") });
      await section.getByRole("status").filter({ hasText: m("reports.archive.status.generated") }).waitFor();
      await section.getByText(m("reports.archive.noSources"), { exact: true }).waitFor();
      const open = section.getByRole("link", { name: m("reports.archive.open"), exact: true });
      assert.equal(await open.getAttribute("target"), "_blank");
      const popupPromise = context.waitForEvent("page"); await open.click(); const popup = await popupPromise;
      await popup.waitForLoadState(); assert.match(await popup.locator("body").innerText(), /Original goal/); assert.match(await popup.locator("body").innerText(), /no model was called/); await popup.close();
      await section.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(evidence, `${locale.id}-${width}-empty.png`) });
      await page.getByRole("button", { name: `${m("tasks.archive.restore")}: ${empty.title}`, exact: true }).click();
      await page.getByRole("button", { name: `${m("tasks.archive.archive")}: ${empty.title}`, exact: true }).waitFor();
      assert.equal(await section.getByRole("link").count(), 2, "restore keeps latest entry and history readable");
      await page.evaluate(task => window.showTask(task), await f.current(queued.id));
      await section.getByRole("status").filter({ hasText: m("reports.archive.status.generating") }).waitFor();
      assert.equal(await section.getByRole("link").count(), 0); assert.match(await section.innerText(), new RegExp(source.getLeafId()));
      await section.getByText(m("reports.archive.phase.sending"), { exact: true }).waitFor();
      await section.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(evidence, `${locale.id}-${width}-generating.png`) });
      // Close the actual tab while a request is in flight, then reopen from saved task state.
      const queuedTask = await f.current(queued.id);
      await page.close(); f.respond(0); await waitForTaskReportExecutor();
      const reopened = await context.newPage();
      reopened.on("pageerror", e => errors.push(e.message));
      await reopened.goto("http://localhost/");
      await reopened.addStyleTag({ content: `*{box-sizing:border-box}body{margin:0;font-family:Arial}:root{--bg:#fff;--bg-panel:#f5f5f5;--border:#ddd;--text:#222;--text-dim:#666;--text-muted:#555;--accent:#245bce}${outputFiles.find(file => file.path.endsWith(".css")).text}` });
      await reopened.addScriptTag({ content: outputFiles.find(file => file.path.endsWith(".js")).text });
      await reopened.evaluate(task => window.showTask(task), queuedTask);
      const live = reopened.getByRole("region", { name: m("reports.archive.title") });
      await live.getByRole("status").filter({ hasText: m("reports.archive.status.generated") }).waitFor();
      const reportPopupPromise = context.waitForEvent("page"); await live.getByRole("link", { name: m("reports.archive.open"), exact: true }).click(); const reportPopup = await reportPopupPromise;
      await reportPopup.waitForLoadState(); assert.ok((await reportPopup.locator("body").innerText()).includes(REPORT_TEXT)); await reportPopup.close();
      await live.scrollIntoViewIfNeeded(); await reopened.screenshot({ path: join(evidence, `${locale.id}-${width}-success.png`) });
      await saveTaskReportSettings(f.selection, f.agentDir);
      await f.op({ action: "set-archive", id: queued.id, archived: false, expectedArchiveRevision: 1, operationId: crypto.randomUUID() });
      const failed = await f.current(queued.id); await f.archive(failed.id);
      await reopened.evaluate(task => window.showTask(task), await f.current(failed.id));
      await live.getByRole("status").filter({ hasText: m("reports.archive.status.generating") }).waitFor();
      await f.wait(() => f.calls.length === 2); f.respond(1, "error");
      // Polling observes the server transition without a reload action.
      await live.getByRole("status").filter({ hasText: m("reports.archive.status.failed") }).waitFor();
      await live.getByText(m("reports.archive.failure"), { exact: true }).waitFor(); await live.getByRole("alert").waitFor();
      assert.equal(await live.getByRole("link", { name: m("reports.archive.open"), exact: true }).count(), 1, "new failure does not hide old success");
      await live.scrollIntoViewIfNeeded(); await reopened.screenshot({ path: join(evidence, `${locale.id}-${width}-failed.png`) });
      const unknown = await f.create("Controlled timeout"); await f.link(unknown.id, [f.session().getSessionId()]); await f.archive(unknown.id);
      wakeTaskReportExecutor(f.agentDir, { timeoutMs: 150 }); await waitForTaskReportExecutor();
      await reopened.evaluate(task => window.showTask(task), await f.current(unknown.id));
      await live.getByRole("status").filter({ hasText: m("reports.archive.status.unconfirmed") }).waitFor();
      await live.getByText(m("reports.archive.unknown"), { exact: true }).waitFor();
      await live.scrollIntoViewIfNeeded(); await reopened.screenshot({ path: join(evidence, `${locale.id}-${width}-unconfirmed.png`) });
      assert.equal(await reopened.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
      // Actual long archive -> complete detailed directory -> multiple synthesis levels, same UI/API.
      await saveTaskReportSettings(f.selection, f.agentDir);
      const long = await f.create("Detailed material directory"), longSource = f.session(`UI_EARLY ${"source evidence ".repeat(4000)} UI_MIDDLE failure reason; verify passed; UI_TAIL unfinished`);
      await f.link(long.id, [longSource.getSessionId()]); const longArchive = await f.archive(long.id), longId = longArchive.result.task.reportIds[0];
      const firstMaterialCall = 3;
      await f.wait(() => f.calls.length === firstMaterialCall + 1);
      const planned = (await getTaskReport(longId, f.agentDir)).materials.length;
      assert.ok(planned > 1);
      await reopened.evaluate(task => window.showTask(task), await f.current(long.id));
      await live.getByText(m("reports.archive.stage.material"), { exact: false }).waitFor();
      const materialText = "Detailed decisions: local file because single-user. Failed path: verify exited 1; fixed artifact.ts. Observed verify passed, conversational completion unverified. UI_EARLY/UI_MIDDLE/UI_TAIL source references retained." + "d".repeat(1500);
      for (let i = 0; i < planned; i++) {
        await f.wait(() => f.calls.length === firstMaterialCall + i + 1);
        if (i === 1) {
          await live.getByRole("link", { name: "material-1", exact: true }).waitFor();
          await live.scrollIntoViewIfNeeded(); await reopened.screenshot({ path: join(evidence, `${locale.id}-${width}-materials-partial.png`) });
          assert.equal(await live.getByRole("link").count(), 1, "only durable material is linked during generation");
        }
        f.respond(firstMaterialCall + i, "success", materialText);
      }
      let nextCall = firstMaterialCall + planned;
      while (true) {
        await f.wait(() => f.calls.length === nextCall + 1);
        const request = JSON.parse(f.calls[nextCall].payload.messages.find(message => message.role === "user").content);
        await live.locator("p").filter({ hasText: m("reports.archive.stage.synthesis") }).waitFor();
        if (request.level === 2) {
          await live.getByRole("link", { name: "synthesis-1-1", exact: true }).waitFor();
          await live.locator("p").filter({ hasText: `${m("reports.archive.stage.synthesis")} · ${m("reports.archive.level")} 2` }).waitFor();
          await live.scrollIntoViewIfNeeded(); await reopened.screenshot({ path: join(evidence, `${locale.id}-${width}-layers-partial.png`) });
        }
        f.respond(nextCall++, "success", request.operation === "synthesis-material" ? materialText : REPORT_TEXT);
        if (request.operation === "synthesis") break;
      }
      await waitForTaskReportExecutor();
      const layered = await getTaskReport(longId, f.agentDir);
      assert.ok(layered.materials.some(material => material.level === 2));
      await live.getByRole("status").filter({ hasText: m("reports.archive.status.generated") }).waitFor();
      assert.equal(await live.getByRole("link").count(), layered.materials.length + 2);
      await rm(longSource.getSessionFile());
      const materialPopupPromise = context.waitForEvent("page"); await live.getByRole("link", { name: `material-${planned}`, exact: true }).click(); const materialPopup = await materialPopupPromise;
      await materialPopup.waitForLoadState(); assert.ok((await materialPopup.locator("body").innerText()).includes(materialText)); await materialPopup.close();
      const longBody = await GET(new Request(`http://localhost/api/task-reports?id=${longId}&body=1`));
      const longText = await longBody.text(); for (const material of layered.materials) assert.ok(longText.includes(`&material=${material.id}`));
      const synthesisPopupPromise = context.waitForEvent("page"); await live.getByRole("link", { name: "synthesis-2-1", exact: true }).click(); const synthesisPopup = await synthesisPopupPromise;
      await synthesisPopup.waitForLoadState(); assert.ok((await synthesisPopup.locator("body").innerText()).includes("Fixed synthesis input directory")); await synthesisPopup.close();
      await live.scrollIntoViewIfNeeded(); await reopened.screenshot({ path: join(evidence, `${locale.id}-${width}-materials-success.png`) });
      assert.equal(await reopened.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
      // A middle failure retains a real partial directory, not a successful report link.
      const partial = await f.create("Partial detailed materials"); await f.link(partial.id, [f.session(`FAILURE_EARLY ${"evidence ".repeat(2000)} FAILURE_TAIL`).getSessionId()]); await f.archive(partial.id);
      const partialIndex = nextCall;
      await f.wait(() => f.calls.length === partialIndex + 1); f.respond(partialIndex, "success", materialText);
      await f.wait(() => f.calls.length === partialIndex + 2); f.respond(partialIndex + 1, "length"); await waitForTaskReportExecutor();
      await reopened.evaluate(task => window.showTask(task), await f.current(partial.id));
      await live.getByRole("status").filter({ hasText: m("reports.archive.status.failed") }).waitFor();
      assert.equal(await live.getByRole("link").count(), 1); assert.equal(await live.getByRole("link", { name: m("reports.archive.open"), exact: true }).count(), 0);
      await live.getByRole("link", { name: "material-1", exact: true }).waitFor();
      await live.scrollIntoViewIfNeeded(); await reopened.screenshot({ path: join(evidence, `${locale.id}-${width}-materials-failed.png`) });
      assert.equal(await reopened.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
      await reopened.evaluate(task => window.showTask(task), await f.current(pending.id));
      await live.getByRole("status").filter({ hasText: m("reports.archive.status.awaiting-configuration") }).waitFor();
      // Continue the frozen coverage/read-error checks on the reopened page.
      page = reopened; section = live;
      await page.evaluate(task => window.showTask(task), await f.current(pending.id));
      await section.getByRole("status").filter({ hasText: m("reports.archive.status.awaiting-configuration") }).waitFor();
      assert.match(await section.innerText(), new RegExp(m("reports.archive.source.missing")));
      assert.match(await section.innerText(), new RegExp(m("reports.archive.source.available")));
      await section.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(evidence, `${locale.id}-${width}-coverage.png`) });
      const id = (await f.current(pending.id)).reportIds[0], file = join(f.agentDir, "task-reports", `${id}.json`), bytes = await f.reportBytes(id);
      await writeFile(file, "broken"); await section.getByRole("button", { name: m("reports.archive.reload"), exact: true }).click();
      await section.getByRole("alert").waitFor(); await writeFile(file, bytes);
      await section.getByRole("button", { name: m("reports.archive.reload"), exact: true }).click(); await section.getByRole("alert").waitFor({ state: "detached" });
      await section.getByRole("status").waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
      // Real explicit retry with a dropped successful response: original ID survives error and read refresh.
      await section.getByText(m("reports.archive.retryCharge"), { exact: true }).waitFor();
      await saveTaskReportSettings({ provider: "report-plain", modelId: "same-id", thinkingLevel: "off" }, f.agentDir);
      assert.equal(f.requests(), nextCall + 2, "saving settings never starts old intent");
      dropRetry = true;
      await section.getByRole("button", { name: m("reports.archive.retry"), exact: true }).click();
      await section.getByRole("alert").waitFor();
      await section.getByRole("button", { name: m("reports.archive.retryExact"), exact: true }).waitFor();
      await f.wait(() => f.calls.length === nextCall + 3);
      await section.getByRole("button", { name: m("reports.archive.reload"), exact: true }).click();
      await section.getByRole("status").filter({ hasText: m("reports.archive.status.generating") }).waitFor();
      await section.getByRole("button", { name: m("reports.archive.retryExact"), exact: true }).click();
      await section.getByRole("alert").waitFor({ state: "detached" });
      assert.equal(retryRequests.length, 2); assert.equal(retryRequests[0].operationId, retryRequests[1].operationId);
      assert.equal(f.calls[nextCall + 2].payload.reasoning_effort, undefined);
      f.respond(nextCall + 2); await waitForTaskReportExecutor();
      await section.getByRole("status").filter({ hasText: m("reports.archive.status.generated") }).waitFor();
      assert.equal(await section.getByRole("button", { name: m("reports.archive.retry"), exact: true }).count(), 0);
      await section.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(evidence, `${locale.id}-${width}-retry-success.png`) });
      const bounds = await section.boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width);
      assert.equal(f.requests(), nextCall + 3);
      // Selected version → new version with old snapshot → restore/rearchive with a new snapshot.
      const original = await getTaskReport(id, f.agentDir), originalBytes = await f.reportBytes(id);
      a.appendMessage({ role: "user", content: "UI_TODAY_NEW_SNAPSHOT", timestamp: 5 });
      await section.getByText(m("reports.archive.regenerateCharge"), { exact: true }).waitFor();
      dropRetry = true;
      await section.getByRole("button", { name: m("reports.archive.regenerate"), exact: true }).click();
      await section.getByRole("alert").waitFor();
      const exactRegeneration = section.getByRole("button", { name: m("reports.archive.regenerateExact"), exact: true });
      await exactRegeneration.waitFor(); await exactRegeneration.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(evidence, `${locale.id}-${width}-regenerate-error.png`) });
      await f.wait(() => f.calls.length === nextCall + 4);
      await section.getByRole("button", { name: m("reports.archive.reload"), exact: true }).click();
      await section.getByRole("status").filter({ hasText: m("reports.archive.status.generating") }).waitFor();
      const history = await getTaskReportHistory(pending.id, f.agentDir), id2 = history.currentReportId;
      assert.equal(history.latestSuccessfulReportId, id);
      assert.deepEqual((await getTaskReport(id2, f.agentDir)).snapshot, original.snapshot);
      assert.equal(await section.getByRole("link", { name: m("reports.archive.latestSuccessful"), exact: true }).getAttribute("href"), `/api/task-reports?id=${id}&body=1`);
      await section.getByRole("button", { name: m("reports.archive.regenerateExact"), exact: true }).click();
      await section.getByRole("alert").waitFor({ state: "detached" });
      assert.equal(retryRequests[2].action, "regenerate"); assert.equal(retryRequests[2].operationId, retryRequests[3].operationId);
      assert.equal(f.calls.length, nextCall + 4, "same regeneration operation creates only one version");
      f.respond(nextCall + 3); await waitForTaskReportExecutor();
      await section.getByRole("status").filter({ hasText: m("reports.archive.status.generating") }).waitFor({ state: "detached" });
      assert.deepEqual(await f.reportBytes(id), originalBytes);
      const secondBytes = await f.reportBytes(id2);
      await page.getByRole("button", { name: `${m("tasks.archive.restore")}: ${pending.title}`, exact: true }).click();
      await page.getByRole("button", { name: `${m("tasks.archive.archive")}: ${pending.title}`, exact: true }).waitFor();
      assert.deepEqual((await f.current(pending.id)).reportIds, [id, id2]);
      await page.getByRole("button", { name: `${m("tasks.archive.archive")}: ${pending.title}`, exact: true }).click();
      await f.wait(() => f.calls.length === nextCall + 5);
      const id3 = (await f.current(pending.id)).reportIds[2];
      assert.ok(JSON.stringify((await getTaskReport(id3, f.agentDir)).snapshot).includes("UI_TODAY_NEW_SNAPSHOT"));
      f.respond(nextCall + 4); await waitForTaskReportExecutor();
      await section.getByRole("heading", { name: `${m("reports.archive.version")} 3 · ${m("reports.archive.current")}`, exact: true }).waitFor();
      const latest = section.getByRole("link", { name: m("reports.archive.latestSuccessful"), exact: true });
      await f.wait(async () => await latest.getAttribute("href") === `/api/task-reports?id=${id3}&body=1`);
      assert.equal(await section.getByRole("link", { name: m("reports.archive.open"), exact: true }).count(), 3);
      await rm(a.getSessionFile());
      await section.getByRole("button", { name: m("reports.archive.reload"), exact: true }).click();
      await latest.waitFor();
      const latestPopupPromise = context.waitForEvent("page"); await latest.click(); const latestPopup = await latestPopupPromise;
      await latestPopup.waitForLoadState(); assert.ok((await latestPopup.locator("body").innerText()).includes(REPORT_TEXT)); await latestPopup.close();
      assert.deepEqual(await f.reportBytes(id), originalBytes); assert.deepEqual(await f.reportBytes(id2), secondBytes);
      assert.equal(await section.locator('a[href*="session="]').count(), 0, "stored cutoff is not a fake history navigation link");
      await section.getByText(m("reports.archive.snapshotOnly"), { exact: true }).first().waitFor();
      await latest.scrollIntoViewIfNeeded(); await page.screenshot({ path: join(evidence, `${locale.id}-${width}-history.png`) });
      await section.getByRole("heading", { name: `${m("reports.archive.version")} 3 · ${m("reports.archive.current")}`, exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(evidence, `${locale.id}-${width}-current-version.png`) });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
      assert.deepEqual(errors, []); assert.deepEqual(unexpected, []); assert.equal(taskWrites, 4); assert.equal(f.requests(), nextCall + 5);
      console.log(`PASS ${locale.id} ${width}: task archive/restore, metadata open, real SDK generation after close/reopen, live success/failure/unknown, configuration/coverage, read error/reload, detailed material directories/source deletion, history/latest/selected-snapshot regeneration with lost-response dedup and restore/rearchive, ${f.requests()} controlled calls`);
    } finally { await context.close(); await f.close(); }
  }
} finally { await browser.close(); }
console.log(`Evidence: ${evidence}`);
