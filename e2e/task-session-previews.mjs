// Real TaskPanel/Dashboard/TaskSessions and CSS, isolated API fixtures only.
// No Next server, user data, SDK runtime, or model requests are used.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { build } from "esbuild";
import { chromium } from "playwright";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const jiti = createJiti(import.meta.url, { alias: { "@": root } });
const { TASK_COLUMNS } = await jiti.import("../lib/task-types.ts");
const locales = [];
for (const id of ["en", "zh-CN", "zh-TW"]) locales.push(Object.values(await jiti.import(`../lib/i18n/messages/${id}.ts`))[0]);
const { outputFiles } = await build({
  absWorkingDir: root, bundle: true, write: false, outfile: "task-session-previews.js", platform: "browser", format: "iife", jsx: "automatic",
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
      const [sessionId, setSessionId] = useState(window.currentSessionId);
      const [request, setRequest] = useState(0);
      window.openTask = id => {setRequest(value => value + 1); setRequestedTask({id, request: request + 1}); setOpen(true);};
      return <><button onClick={() => setOpen(true)}>Reopen panel</button>
        <TaskPanel open={open} onClose={() => setOpen(false)} sessionId={sessionId} requestedTask={requestedTask}
          onNavigate={async href => {window.navigations.push(href); setSessionId(new URL(href, location.href).searchParams.get("session"));}} /></>;
    }
    createRoot(document.getElementById("root")).render(<I18nProvider><App/></I18nProvider>);
  ` },
});

function fixture() {
  const sessions = new Map();
  const makeTask = (title, count) => {
    const sessionIds = Array.from({ length: count }, (_, index) => {
      const id = randomUUID();
      sessions.set(id, { id, name: `${title} chat ${index + 1}`, running: false, relationGeneration: 4, updateRevision: 9 });
      return id;
    });
    return { id: randomUUID(), title, description: "", completionCriteria: "", priority: 1, labels: [], project: null,
      columnId: "todo", revision: 1, archived: false, archiveRevision: 0, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      sessionIds, sessionContexts: [], sessionUpdates: [], sharedContext: { currentVersionId: null, versions: [] } };
  };
  const boundaries = [0, 1, 4, 5, 6, 20].map(count => makeTask(`Boundary ${count}`, count));
  const a = makeTask("Task A", 7), b = makeTask("Task B", 6);
  const missingId = a.sessionIds[6];
  sessions.set(missingId, { id: missingId, missing: true, running: false, relationGeneration: 7, updateRevision: 12 });
  const candidate = { id: randomUUID(), name: "New candidate", running: false };
  sessions.set(candidate.id, candidate);
  const board = { tasks: [...boundaries, a, b], columns: TASK_COLUMNS, columnsRevision: 0, orderRevision: 0,
    viewsRevision: 0, savedViews: [], columnRemovalDigests: {} };
  return { board, boundaries, a, b, missingId, candidate, sessions };
}

const browser = await chromium.launch({ headless: true });
try {
  for (const locale of locales) for (const width of [1100, 390]) {
    const f = fixture();
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    const page = await context.newPage(), errors = [], unexpected = [], taskRequests = [], removals = [];
    const m = (key, count) => locale.messages[key]?.replace("{count}", String(count));
    let failNextRemoval = false;
    page.on("pageerror", error => errors.push(error.message));
    await context.addInitScript(({ locale, sessionId }) => {
      localStorage.setItem("pi-locale", locale);
      window.currentSessionId = sessionId;
      window.navigations = [];
    }, { locale: locale.id, sessionId: f.a.sessionIds[5] });
    await page.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      const json = (body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
      if (url.origin === "http://task-session-previews.test" && url.pathname === "/") {
        return route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
      }
      if (url.pathname === "/api/agent/running" && request.method() === "GET") {
        return json({ runningSessionIds: [f.a.sessionIds[5]], sessionActivity: {} });
      }
      if (url.pathname === "/api/tasks") {
        if (request.method() === "GET") { taskRequests.push({ action: "list" }); return json(f.board); }
        const input = request.postDataJSON();
        taskRequests.push(input);
        const task = f.board.tasks.find(task => task.id === (input.id ?? input.sourceTaskId));
        if (input.action === "sessions" && task) return json({ linked: task.sessionIds.map(id => f.sessions.get(id)),
          candidates: f.board.tasks.some(task => task.sessionIds.includes(f.candidate.id)) ? [] : [f.candidate] });
        if (input.action === "link" && task) {
          task.sessionIds.push(...input.sessionIds); task.revision++;
          return json({ task, board: f.board });
        }
        if (input.action === "change-session-relation" && task) {
          removals.push(input);
          if (failNextRemoval) { failNextRemoval = false; return json({ error: "Fixture removal response lost" }, 503); }
          task.sessionIds = task.sessionIds.filter(id => id !== input.sessionId); task.revision++;
          return json(f.board);
        }
      }
      unexpected.push(`${request.method()} ${url.pathname}`);
      return route.abort();
    });
    const inspector = id => page.locator(`[data-task-inspector="${id}"]`);
    const list = id => inspector(id).getByRole("list", { name: m("tasks.linkedSessions"), exact: true });
    const more = (id, count) => inspector(id).getByRole("button", { name: m("tasks.showMoreSessions", count), exact: true });
    const fewer = id => inspector(id).getByRole("button", { name: m("tasks.showFewerSessions"), exact: true });
    const visibleCount = async (id, expected) => {
      await page.waitForFunction(({ id, expected }) => {
        const panel = document.querySelector(`[data-task-inspector="${id}"]`);
        const list = panel?.querySelector("ul[aria-label]");
        return list && [...list.children].filter(row => row.getClientRects().length > 0).length === expected;
      }, { id, expected });
      assert.equal(await list(id).getByRole("listitem").count(), expected, "hidden rows must leave the accessibility tree");
    };
    const open = async task => {
      await page.evaluate(id => window.openTask(id), task.id);
      await list(task.id).waitFor({ state: "attached" });
      await page.waitForFunction(id => {
        const panel = document.querySelector(`[data-task-inspector="${id}"]`);
        return panel && !panel.hidden && !panel.querySelector('button[title][disabled]');
      }, task.id);
    };
    const remove = async (taskId, sessionId) => {
      const row = list(taskId).locator("li").filter({ has: page.locator(`a[href="/?session=${sessionId}"]`) });
      await row.getByRole("button", { name: m("tasks.sessionActions"), exact: true }).click();
      await inspector(taskId).getByRole("menuitem", { name: m("tasks.removeSession"), exact: true }).click();
    };
    try {
      await page.goto("http://task-session-previews.test/");
      await page.addStyleTag({ content: `*{box-sizing:border-box}body{margin:0;font-family:Arial}:root{--bg:#fff;--bg-panel:#f5f5f5;--border:#ddd;--text:#222;--text-dim:#666;--text-muted:#555;--accent:#245bce}${outputFiles.find(file => file.path.endsWith(".css")).text}` });
      await page.addScriptTag({ content: outputFiles.find(file => file.path.endsWith(".js")).text });
      await page.waitForFunction(() => typeof window.openTask === "function");
      for (const task of f.boundaries) {
        const count = task.sessionIds.length;
        await open(task); await visibleCount(task.id, Math.min(5, count));
        await inspector(task.id).getByRole("heading", { name: `${m("tasks.sessions")} (${count})`, exact: true }).waitFor();
        assert.deepEqual(await list(task.id).getByRole("link").allTextContents(),
          task.sessionIds.slice(0, 5).map(id => f.sessions.get(id).name), "preview must preserve API order");
        if (count <= 5) {
          assert.equal(await more(task.id, count - 5).count(), 0);
          assert.equal(await fewer(task.id).count(), 0);
        } else {
          const before = taskRequests.length;
          assert.equal(await more(task.id, count - 5).getAttribute("aria-expanded"), "false");
          assert.equal(await more(task.id, count - 5).getAttribute("aria-controls"), await list(task.id).getAttribute("id"));
          await more(task.id, count - 5).focus(); await page.keyboard.press("Enter");
          await visibleCount(task.id, count);
          assert.equal(await fewer(task.id).getAttribute("aria-expanded"), "true");
          await fewer(task.id).press("Space"); await visibleCount(task.id, 5);
          assert.equal(await more(task.id, count - 5).evaluate(button => button === document.activeElement), true);
          assert.equal(taskRequests.length, before, "expand/collapse must not request or mutate task data");
        }
      }
      console.log(`PASS ${locale.id} ${width}px: 0/1/4/5/6/20 boundaries, total/order, keyboard/ARIA and zero toggle requests`);

      await open(f.a); await visibleCount(f.a.id, 5);
      assert.equal(await list(f.a.id).getByText(m("tasks.panel.currentChat"), { exact: true }).isVisible(), false,
        "current/running chat outside the first five must not automatically expand");
      await list(f.a.id).getByRole("listitem").last().getByRole("button", { name: m("tasks.sessionActions"), exact: true }).focus();
      await page.keyboard.press("Tab");
      assert.equal(await more(f.a.id, 2).evaluate(button => button === document.activeElement), true,
        "Tab must skip the hidden chats and reach the more button");
      const card = page.locator(`[data-task-card="${f.a.id}"]`);
      assert.match(await card.textContent(), /7/);
      assert.match(await card.textContent(), new RegExp(`${m("tasks.aiWorking")} 1`), "card running count includes hidden chats");
      await more(f.a.id, 2).click(); await visibleCount(f.a.id, 7);
      await list(f.a.id).getByText(m("tasks.panel.currentChat"), { exact: true }).waitFor();
      await list(f.a.id).getByText(m("tasks.sessionMissing"), { exact: true }).waitFor();
      await open(f.b); await visibleCount(f.b.id, 5); await more(f.b.id, 1).click();
      await open(f.a); await visibleCount(f.a.id, 7); await fewer(f.a.id).click();
      await open(f.b); await visibleCount(f.b.id, 6);
      await inspector(f.b.id).getByRole("button", { name: m("tasks.panel.closeDetails"), exact: true }).click();
      await open(f.b); await visibleCount(f.b.id, 6);
      await page.getByRole("button", { name: m("tasks.panel.close"), exact: true }).click({ force: true });
      await open(f.b); await visibleCount(f.b.id, 6);
      console.log(`PASS ${locale.id} ${width}px: independent task state survives switching, detail close and panel close`);

      await open(f.a); await more(f.a.id, 2).click();
      failNextRemoval = true;
      await remove(f.a.id, f.a.sessionIds[5]);
      await inspector(f.a.id).getByRole("alert").filter({ hasText: "Fixture removal response lost" }).first().waitFor();
      const originalRemoval = removals.at(-1);
      await fewer(f.a.id).click(); await more(f.a.id, 2).click();
      await open(f.b); await open(f.a);
      await remove(f.a.id, originalRemoval.sessionId); await visibleCount(f.a.id, 6);
      assert.deepEqual(removals.at(-1), originalRemoval, "collapse/switch/reopen must retain exact removal UUID and CAS");
      assert.equal(await fewer(f.a.id).count(), 1, "ordinary data refresh preserves expanded state");
      const missingRow = list(f.a.id).locator("li").filter({ hasText: f.missingId });
      await missingRow.getByRole("button", { name: m("tasks.sessionActions"), exact: true }).click();
      await inspector(f.a.id).getByRole("menuitem", { name: m("tasks.removeSession"), exact: true }).click();
      await visibleCount(f.a.id, 5);
      assert.equal(await fewer(f.a.id).count(), 0, "more control disappears when removals leave five chats");
      assert.equal(removals.at(-1).expectedGeneration, 7); assert.equal(removals.at(-1).expectedUpdateRevision, 12);
      await inspector(f.a.id).getByRole("button", { name: m("tasks.linkSessions"), exact: true }).click();
      await inspector(f.a.id).getByRole("checkbox").check();
      await inspector(f.a.id).getByRole("button", { name: `${m("tasks.linkSelected")} (1)`, exact: true }).click();
      await visibleCount(f.a.id, 6);
      await list(f.a.id).getByRole("link", { name: f.candidate.name, exact: true }).waitFor();
      await fewer(f.a.id).click(); await visibleCount(f.a.id, 5);
      await inspector(f.a.id).getByRole("button", { name: m("tasks.refreshSessions"), exact: true }).click();
      await open(f.a); await visibleCount(f.a.id, 5);
      await more(f.a.id, 1).click();
      await list(f.a.id).getByRole("link", { name: "Task A chat 1", exact: true }).click();
      await page.waitForFunction(() => window.navigations.length === 1);
      assert.equal(await fewer(f.a.id).count(), 1, "switching chats does not collapse the task list");
      assert.deepEqual(await page.evaluate(() => window.navigations), [`/?session=${f.a.sessionIds[0]}`]);
      await fewer(f.a.id).click(); await visibleCount(f.a.id, 5);
      assert.deepEqual(await page.evaluate(() => window.navigations), [`/?session=${f.a.sessionIds[0]}`], "collapse does not navigate away from the current chat");
      await more(f.a.id, 1).click();
      assert.deepEqual(unexpected, [], "no Agent writes, shared-context or other unexpected API requests");
      console.log(`PASS ${locale.id} ${width}px: removal retry/CAS survives collapse, missing removal, five-item shrink, link/refresh/navigation`);

      await page.reload();
      await page.addStyleTag({ content: outputFiles.find(file => file.path.endsWith(".css")).text });
      await page.addScriptTag({ content: outputFiles.find(file => file.path.endsWith(".js")).text });
      await page.waitForFunction(() => typeof window.openTask === "function");
      await open(f.a); await visibleCount(f.a.id, 5); await more(f.a.id, 1).waitFor();
      assert.deepEqual(errors, []);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      console.log(`PASS ${locale.id} ${width}px: full reload resets preview, no overflow or browser errors`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
