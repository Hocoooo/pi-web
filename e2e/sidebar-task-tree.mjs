// Real application UI with isolated API fixtures. Reuses the checkout's dev server;
// no user data, Agent commands, or model calls can escape the browser routes.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);

const base = process.env.E2E_BASE_URL || "http://127.0.0.1:30141";
const en = Object.values(await jiti.import("../lib/i18n/messages/en.ts"))[0].messages;
const filters = (p, messages = en) => {
  const label = key => messages[`sidebar.${key}`];
  const dialog = p.getByRole("dialog", {name:label("searchFilters"), exact:true});
  const open = async () => {
    if (p.viewportSize().width <= 640) {
      await p.waitForFunction(() => !document.getElementById("session-sidebar")?.classList.contains("sidebar-mobile-pending"));
      if (await p.locator('#session-sidebar').evaluate(element => element.classList.contains("sidebar-closed"))) await p.getByRole("button",{name:label("show"),exact:true}).click();
      await p.waitForFunction(() => Math.abs(document.getElementById("session-sidebar").getBoundingClientRect().left) < 1);
    }
    if (!await dialog.isVisible()) await p.getByRole("button", {name:label("searchFilters"), exact:true}).click();
    const back = dialog.getByRole("button", {name:label("filtersBack"), exact:true});
    if (await back.isVisible()) await back.click();
    await dialog.getByRole("searchbox", {name:label("contentSearch"), exact:true}).waitFor();
  };
  const taskOptions = async (query = "") => {
    await open();
    await dialog.getByRole("button", {name:label("conditionTask"), exact:true}).click();
    await dialog.getByRole("searchbox", {name:label("taskSearch"), exact:true}).fill(query);
    return dialog.getByRole("listbox", {name:label("taskFilter"), exact:true});
  };
  return {
    open, taskOptions,
    close: async () => { if (await dialog.isVisible()) await dialog.getByRole("button", {name:label("closeFilters"), exact:true}).click(); },
    chooseTask: async (id, query = "") => {
      const options = await taskOptions(query);
      const option = id === "unlinked"
        ? options.getByRole("option", {name:label("unlinkedTask"), exact:true})
        : options.locator(`[data-task-option="${id}"]`);
      await option.click();
      await dialog.getByRole("searchbox", {name:label("contentSearch"), exact:true}).waitFor();
    },
    clearTask: async () => { await open(); await dialog.getByRole("button", {name:label("clearTaskFilter"), exact:true}).click(); },
    scope: async value => {
      await open();
      await dialog.getByRole("button", {name:label("conditionArchive"), exact:true}).click();
      await dialog.locator(`[data-archive-option="${value}"]`).click();
      await dialog.getByRole("searchbox", {name:label("contentSearch"), exact:true}).waitFor();
    },
    body: async query => { await open(); await dialog.getByRole("searchbox", {name:label("contentSearch"), exact:true}).fill(query); },
  };
};
const evidence = await mkdtemp(join(tmpdir(), "pi-web-sidebar-task-tree-"));
const ids = { a: "11111111-1111-4111-8111-111111111111", b: "22222222-2222-4222-8222-222222222222", empty: "33333333-3333-4333-8333-333333333333" };
const project = { cwd: "/fixtures/alpha", projectRoot: "/fixtures/alpha", projectKey: "alpha" };
const sessions = Array.from({ length: 8 }, (_, i) => ({ ...project, id: `task-chat-${i + 1}`, name: `Conversation ${i + 1}`,
  firstMessage: `Conversation ${i + 1}`, messageCount: 1, created: "2026-01-01T00:00:00Z", modified: `2026-01-${String(20 - i).padStart(2, "0")}T00:00:00Z`, path: `/fixtures/chat-${i + 1}.jsonl` }));
const tasks = [
  { id: ids.a, title: "Task Alpha", description: "Database migration", completionCriteria: "Durable index", sessionIds: sessions.slice(0, 6).map(s => s.id) },
  { id: ids.b, title: "Task Beta", description: "Other work", completionCriteria: "", sessionIds: [sessions[6].id] },
  { id: ids.empty, title: "Empty task", description: "Needle in description", completionCriteria: "Acceptance phrase", sessionIds: [] },
].map(task => ({ ...task, project, archived: false, updatedAt: "2026-01-01T00:00:00Z" }));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 } });
const page = await context.newPage(), errors = [], unexpected = [], searches = [];
let catalogFails = false, runningIds = [], listVersion = 1;
page.on("pageerror", error => errors.push(error.message));
await context.addInitScript(() => { localStorage.setItem("pi-locale", "en"); });
await context.route("**/api/**", async route => {
  const request = route.request(), url = new URL(request.url());
  const json = (data, status = 200) => route.fulfill({ status, json: data });
  if (url.pathname === "/api/tasks/catalog") return catalogFails ? json({error: "Fixture unavailable"}, 503) : json({ tasks });
  if (url.pathname === "/api/sessions/search") { searches.push(Object.fromEntries(url.searchParams)); return json({ results: [], truncated: false }); }
  if (url.pathname === "/api/tasks" && request.method() === "POST" && request.postDataJSON().action === "session-task") {
    const task = tasks.find(task => task.sessionIds.includes(request.postDataJSON().sessionId));
    return json({task:task ? {id:task.id, title:task.title, archived:task.archived} : null});
  }
  if (url.pathname === "/api/agent/task-chat-6" && request.method() === "POST" && request.postDataJSON().type === "clone") {
    const child = {...sessions[5], id:"clone-chat", name:"Copied conversation", modified:"2026-04-01T00:00:00Z", relation:{kind:"fork", parentSessionId:"task-chat-6"}};
    sessions.push(child); tasks[0].sessionIds.push(child.id); listVersion++;
    return json({success:true, data:{cancelled:false, newSessionId:child.id}});
  }
  if (request.method() !== "GET" && url.pathname !== "/api/cwd/validate") { unexpected.push(`${request.method()} ${url.pathname}`); return route.abort(); }
  if (url.pathname === "/api/sessions") return json({ sessions, sessionListVersion: listVersion, runningSessionIds: runningIds, completionNotificationSuppressedSessionIds: [] });
  if (url.pathname === "/api/agent/running") return json({ runningSessionIds: runningIds, sessionListVersion: listVersion });
  if (url.pathname === "/api/models") return json({ models: [], modelList: [] });
  if (url.pathname === "/api/home") return json({home: "/home/test"});
  if (url.pathname === "/api/cwd/validate") return json(project);
  if (url.pathname === "/api/worktrees") return json({ ...project, isGit: false, isTopLevel: false, worktrees: [] });
  if (url.pathname.startsWith("/api/sessions/")) return json({info: sessions.find(s => url.pathname.includes(s.id)), context:{messages:[], entryIds:[], hasMore:false}, tree:[]});
  if (url.pathname.startsWith("/api/files")) return json({entries:[]});
  return json({});
});
try {
  await page.goto(`${base}/?cwd=${encodeURIComponent(project.cwd)}`, { waitUntil: "networkidle" });
  await page.getByText("Conversation 8", {exact:true}).waitFor();
  const panel = filters(page);
  await panel.open();
  await panel.close();
  await page.getByRole("button", {name:"Settings", exact:true}).click();
  const treeSwitch = page.getByRole("switch", {name:"Group conversations by task", exact:true});
  await treeSwitch.waitFor({timeout:5000});
  assert.equal(await treeSwitch.getAttribute("aria-checked"), "false", "task tree is opt-in");
  await treeSwitch.click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", {name:"Task Alpha", exact:true}).waitFor();
  assert.equal(await page.getByText("Conversation 1", {exact:true}).count(), 0, "tasks start collapsed");
  const group = title => page.getByRole("button", {name:title, exact:true});
  await group("Task Alpha").click();
  await page.getByText("Conversation 5", {exact:true}).waitFor();
  assert.equal(await page.getByText("Conversation 6", {exact:true}).count(), 0, "task preview is five families");
  await page.getByRole("button", {name:"Show more (1)", exact:true}).click();
  await page.getByText("Conversation 6", {exact:true}).waitFor();
  await page.getByRole("button", {name:"Show fewer", exact:true}).click();
  assert.equal(await page.getByText("Conversation 6", {exact:true}).count(), 0);
  await group("Task Alpha").focus();
  await page.keyboard.press("ArrowLeft");
  assert.equal(await group("Task Alpha").getAttribute("aria-expanded"), "false");
  await page.keyboard.press("ArrowRight");
  assert.equal(await group("Task Alpha").getAttribute("aria-expanded"), "true");
  await page.keyboard.press("ArrowRight");
  assert.match(await page.evaluate(() => document.activeElement.dataset.sidebarRow), /^session:task-chat-1/);
  await page.keyboard.press("ArrowLeft");
  assert.match(await page.evaluate(() => document.activeElement.dataset.sidebarRow), /^task:/);
  const before = page.url();
  await panel.chooseTask(ids.empty, "needle in description");
  await panel.close();
  assert.equal(page.url(), before, "task choice never navigates the current chat");
  await page.getByText("No conversations in this task and session scope.", {exact:true}).waitFor();
  await panel.clearTask();
  const options = await panel.taskOptions("Acceptance phrase");
  assert.equal(await options.locator(`[data-task-option="${ids.empty}"]`).count(), 1, "completion criteria are searchable");
  assert.equal(await options.locator(`[data-task-option="${ids.a}"]`).count(), 0, "nonmatching tasks leave search choices");
  await panel.chooseTask("unlinked");
  await panel.close();
  await page.getByText("Conversation 8", {exact:true}).waitFor();
  assert.equal(await page.getByText("Conversation 1", {exact:true}).count(), 0, "owned sessions are never unlinked");
  await panel.chooseTask(ids.a);
  await panel.close();
  catalogFails = true;
  await page.evaluate(() => window.dispatchEvent(new Event("pi-web:tasks-changed")));
  await page.getByText("Could not refresh tasks. Existing results may be out of date.", {exact:false}).waitFor();
  assert.match(await page.locator("[data-sidebar-filter-summary]").innerText(), /Task Alpha/, "failure preserves selection and ownership snapshot");
  await group("Task Alpha").waitFor();
  catalogFails = false;
  await page.getByRole("button", {name:"Reload tasks", exact:true}).click();
  await page.getByRole("button", {name:"Settings", exact:true}).click();
  await treeSwitch.click();
  await page.keyboard.press("Escape");
  await page.getByText("Conversation 6", {exact:true}).waitFor();
  assert.equal(await group("Task Alpha").count(), 0, "tree off restores original flat current-project list");
  assert.equal(await page.getByText("Conversation 7", {exact:true}).count(), 0, "task filter survives turning tree off");
  await panel.clearTask();
  await panel.close();
  await page.getByText("Conversation 8", {exact:true}).waitFor();
  await panel.chooseTask(ids.a);
  await panel.body("body needle");
  await page.waitForTimeout(500);
  assert.equal(searches.at(-1)?.taskId, ids.a, "body search sends task scope before backend caps");
  await panel.chooseTask(ids.b);
  await page.waitForTimeout(500);
  assert.equal(searches.at(-1)?.taskId, ids.b, "same text refetches when task changes");
  await panel.clearTask();
  await page.waitForTimeout(500);
  assert.equal(searches.at(-1)?.taskId, undefined, "clearing returns to global body search");
  await panel.body("");
  await panel.close();
  await page.getByRole("button", {name:"Settings", exact:true}).click();
  await page.getByRole("switch", {name:"Show all projects", exact:true}).click();
  await treeSwitch.click();
  await page.keyboard.press("Escape");
  const projectRow = page.locator('button[data-sidebar-row="project:alpha"]');
  await projectRow.waitFor();
  await projectRow.focus();
  await page.keyboard.press("ArrowRight");
  assert.match(await page.evaluate(() => document.activeElement.dataset.sidebarRow), /^task:/);
  await page.reload({waitUntil:"networkidle"});
  await group("Task Alpha").waitFor();
  assert.equal(await group("Task Alpha").getAttribute("aria-expanded"), "false", "unselected task expansion is in-memory only");
  await group("Task Alpha").click();
  await page.getByText("Conversation 1", {exact:true}).click();
  await page.waitForURL(/session=task-chat-1/);
  await page.reload({waitUntil:"networkidle"});
  await group("Task Alpha").waitFor();
  assert.equal(await group("Task Alpha").getAttribute("aria-expanded"), "true", "selected task is automatically revealed after refresh");
  await group("Task Alpha").click();
  await page.evaluate(() => window.dispatchEvent(new Event("pi-web:tasks-changed")));
  await page.waitForTimeout(500);
  assert.equal(await group("Task Alpha").getAttribute("aria-expanded"), "false", "ordinary refresh respects manual collapse");
  await page.keyboard.press("Alt+ArrowLeft");
  await page.waitForFunction(() => document.activeElement?.dataset.sidebarRow?.startsWith("session:task-chat-1:task:"));
  await page.keyboard.press("ArrowLeft");
  assert.match(await page.evaluate(() => document.activeElement.dataset.sidebarRow), /^task:/);
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await page.evaluate(() => document.activeElement.dataset.sidebarRow), "project:alpha", "left navigation climbs task then project");
  await page.getByRole("button", {name:"Settings", exact:true}).click();
  await treeSwitch.click();
  await page.keyboard.press("Escape");
  await page.getByRole("button", {name:"Show more (3)", exact:true}).waitFor();
  assert.equal(await page.getByText("Conversation 6", {exact:true}).count(), 0, "tree off restores project-level five preview");
  await panel.chooseTask(ids.a);
  await panel.close();
  await projectRow.click();
  assert.equal(await page.getByText("No conversations in this task and session scope.", {exact:true}).count(), 0, "collapsing a project does not make the filtered task empty");
  await projectRow.click();
  await panel.clearTask();
  await panel.close();
  const peer = await context.newPage();
  peer.on("pageerror", error => errors.push(error.message));
  await peer.goto(`${base}/?cwd=${encodeURIComponent(project.cwd)}`, {waitUntil:"networkidle"});
  await page.getByRole("button", {name:"Settings", exact:true}).click();
  await treeSwitch.click();
  await page.keyboard.press("Escape");
  await peer.getByRole("button", {name:"Task Alpha", exact:true}).waitFor();
  await peer.close();
  await projectRow.click();
  await panel.chooseTask("unlinked");
  await panel.close();
  await page.getByText("Conversation 8", {exact:true}).waitFor({timeout:5000});
  assert.equal(await projectRow.getAttribute("aria-expanded"), "true", "unlinked choice reveals its containing project");
  await panel.clearTask();
  await panel.close();
  await page.reload({waitUntil:"networkidle"});
  await page.getByRole("button", {name:"Show more (1)", exact:true}).click();
  await page.getByText("Conversation 6", {exact:true}).click();
  await page.waitForURL(/session=task-chat-6/);
  await page.reload({waitUntil:"networkidle"});
  assert.equal(await page.getByText("Conversation 6", {exact:true}).count(), 0, "refresh resets task preview without changing selected chat");
  await page.keyboard.press("Alt+ArrowLeft");
  await page.waitForFunction(() => document.activeElement?.dataset.sidebarRow?.startsWith("session:task-chat-6:task:"));
  assert.match(page.url(), /session=task-chat-6/, "reveal does not navigate");
  await panel.chooseTask(ids.b);
  await panel.close();
  await page.getByRole("button", {name:"Settings", exact:true}).click();
  await treeSwitch.click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Alt+ArrowLeft");
  await page.waitForFunction(() => document.activeElement?.dataset.sidebarRow === "session:task-chat-6");
  assert.equal(await page.locator("[data-sidebar-filter-summary]").count(), 0, "flat-mode reveal clears incompatible task filter");
  await panel.chooseTask(ids.a);
  await panel.close();
  await page.locator("textarea.chat-input-textarea").fill("/clone");
  await page.locator("textarea.chat-input-textarea").press("Enter");
  await page.waitForURL(/session=clone-chat/);
  await page.locator('[data-sidebar-row="session:clone-chat"]').waitFor({timeout:5000});
  assert.match(await page.locator("[data-sidebar-filter-summary]").innerText(), /Task Alpha/, "inherited copy appears under its task without a wake event");
  assert.deepEqual(unexpected, []);
  assert.deepEqual(errors, []);
  console.log("PASS: task tree, five-family preview, keyboard/reveal, task search/filter, scoped body requests, failures, compatibility, persistence and cross-tab setting sync");

  // Archive scope is session state, not task state. An active family under an
  // archived task remains visible and must never be relabeled as unlinked.
  tasks[1].archived = true;
  sessions[6].archived = true;
  sessions.push({...sessions[0], id:"subagent-a", name:"Hidden subagent", relation:{kind:"subagent", parentSessionId:sessions[0].id}, modified:"2026-02-01T00:00:00Z"});
  const betaProject = {cwd:"/fixtures/beta", projectRoot:"/fixtures/beta", projectKey:"beta"};
  const betaId = "44444444-4444-4444-8444-444444444444";
  sessions.push({...sessions[0], ...betaProject, id:"beta-chat", name:"Beta project conversation"});
  tasks.push({...tasks[0], id:betaId, project:betaProject, title:"Task Alpha", sessionIds:["beta-chat"]});
  const legacyTaskId = "55555555-5555-4555-8555-555555555555";
  runningIds = ["subagent-a"];
  tasks.push({...tasks[0], id:legacyTaskId, title:"Legacy child task", sessionIds:["subagent-a"]});
  for (const localeId of ["en", "zh-CN", "zh-TW"]) {
    const locale = Object.values(await jiti.import(`../lib/i18n/messages/${localeId}.ts`))[0];
    const matrix = await context.newPage();
    matrix.on("pageerror", error => errors.push(error.message));
    await matrix.setViewportSize({width:390, height:844});
    await matrix.addInitScript(id => {
      localStorage.setItem("pi-locale", id);
      localStorage.setItem("pi-web:sidebar-view", JSON.stringify({mode:"all", collapsedProjects:[], taskTree:true}));
      localStorage.setItem("pi-web:file-explorer:open", "false");
    }, localeId);
    await matrix.goto(`${base}/?session=task-chat-1`, {waitUntil:"networkidle"});
    const sidebarToggle = matrix.getByRole("button", {name:locale.messages["sidebar.show"], exact:true});
    if (await sidebarToggle.isVisible()) await sidebarToggle.click();
    const panelM = filters(matrix, locale.messages);
    const optionsM = await panelM.taskOptions();
    assert.equal(await optionsM.locator(`[data-task-option="${ids.a}"]`).count(), 1);
    assert.equal(await optionsM.locator(`[data-task-option="${betaId}"]`).count(), 1, "same titles remain distinct by task ID and project path");
    await panelM.close();
    assert.equal(await matrix.getByText("Hidden subagent", {exact:true}).count(), 0, "subagent never becomes a standalone tree row");
    await panelM.chooseTask(ids.b);
    await panelM.scope("archived");
    await panelM.close();
    await matrix.getByText("Conversation 7", {exact:true}).waitFor();
    await panelM.scope("active");
    await panelM.close();
    await matrix.getByText(locale.messages["sidebar.emptyTask"], {exact:true}).waitFor();
    sessions[6].archived = false;
    await matrix.reload({waitUntil:"networkidle"});
    if (await sidebarToggle.isVisible()) await sidebarToggle.click();
    await panelM.chooseTask(ids.b);
    await panelM.close();
    await matrix.getByText("Conversation 7", {exact:true}).waitFor();
    await matrix.getByText(locale.messages["sidebar.taskArchived"], {exact:true}).waitFor();
    await panelM.chooseTask("unlinked");
    await panelM.close();
    await matrix.getByText("Conversation 8", {exact:true}).waitFor();
    assert.equal(await matrix.getByText("Conversation 7", {exact:true}).count(), 0, "archived task's active session is still owned");
    assert.equal(await matrix.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "390px has no horizontal overflow");
    await panelM.chooseTask(legacyTaskId);
    await panelM.close();
    await matrix.getByText(locale.messages["sidebar.contextualTaskRoot"], {exact:true}).waitFor();
    await matrix.getByText("Conversation 1", {exact:true}).waitFor();
    const legacyGroup = matrix.getByRole("button", {name:"Legacy child task", exact:true});
    await legacyGroup.locator(`[aria-label="${locale.messages["sidebar.agentRunning"]} (1)"]`).waitFor();
    await matrix.waitForFunction(() => Math.abs(document.getElementById("session-sidebar").getBoundingClientRect().left) < 1);
    await matrix.screenshot({path:join(evidence, `${localeId}-390-light.png`), fullPage:true});
    await matrix.evaluate(() => {document.documentElement.dataset.theme = "dark"; document.documentElement.classList.add("dark");});
    await matrix.screenshot({path:join(evidence, `${localeId}-390-dark.png`), fullPage:true});
    sessions[6].archived = true;
    await matrix.close();
  }
  sessions.push({...sessions[5], id:"intermediate-a", relation:{kind:"subagent", parentSessionId:"task-chat-6"}});
  sessions.push({...sessions[5], id:"grandchild-b", relation:{kind:"subagent", parentSessionId:"intermediate-a"}, modified:"2026-01-15T01:00:00Z"});
  tasks.find(task => task.id === legacyTaskId).sessionIds.push("grandchild-b");
  runningIds = ["grandchild-b"];
  const nested = await context.newPage();
  nested.on("pageerror", error => errors.push(error.message));
  await nested.addInitScript(() => {
    localStorage.setItem("pi-locale", "en");
    localStorage.setItem("pi-web:sidebar-view", JSON.stringify({mode:"all", collapsedProjects:[]}));
  });
  await nested.goto(`${base}/?cwd=${encodeURIComponent(project.cwd)}`, {waitUntil:"networkidle"});
  const nestedPanel = filters(nested);
  await nestedPanel.chooseTask(legacyTaskId);
  await nestedPanel.close();
  const contextRoot = nested.locator('[data-sidebar-row="session:task-chat-6"]');
  await contextRoot.waitFor();
  await contextRoot.locator('[aria-label="Agent running…"]').waitFor();
  await contextRoot.click();
  await nested.waitForURL(/session=task-chat-6/);
  await nested.keyboard.press("Alt+ArrowLeft");
  // The clicked row already owns focus before AppShell's requestAnimationFrame
  // reveal runs. Wait for its scope reset, not that pre-existing focus alone.
  await nested.locator("[data-sidebar-filter-summary]").waitFor({state:"detached"});
  await nested.waitForFunction(() => document.activeElement?.dataset.sidebarRow === "session:task-chat-6");
  assert.equal(await nested.locator("[data-sidebar-filter-summary]").count(), 0, "reveal uses resulting unfiltered projection, not the old filtered row");
  await nested.close();
  assert.deepEqual(unexpected, []);
  assert.deepEqual(errors, []);
  console.log("PASS: 390px en/zh-CN/zh-TW, duplicate titles, archive independence, nested cross-task family flags and filtered reveal");
  console.log(`Screenshots: ${evidence}`);
} finally { await browser.close(); }
