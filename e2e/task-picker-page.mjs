// Whole-page wiring on an existing dev server; every API intercepted, no user data writes.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
const artifacts = process.env.TASK_UI_ARTIFACT_DIR;
if (artifacts) mkdirSync(artifacts, { recursive: true });
const base = process.env.E2E_BASE_URL || "http://127.0.0.1:30142";
const session = {id: "22222222-2222-4222-8222-222222222222", cwd: "/fixture/project", projectKey: "/fixture/project", projectRoot: "/fixture/project", name: "Existing chat", created: "2026-10-10T00:00:00Z", modified: "2026-10-10T00:00:00Z", path: "/fixture/session.jsonl", firstMessage: "", messageCount: 0};
const tasks = [
  {id: "11111111-1111-4111-8111-111111111111", title: "Login API", status: "Todo", revision: 1, archived: false},
  {id: "33333333-3333-4333-8333-333333333333", title: "Billing UI", status: "Review", revision: 1, archived: false},
  {id: "44444444-4444-4444-8444-444444444444", title: "Long task name without truncating important information ".repeat(5), status: "A custom status label", revision: 1, archived: false},
];
const browser = await chromium.launch({headless: true});
try {
  for (const width of [1200, 390]) for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({viewport: {width, height: 850}, isMobile: width < 600, hasTouch: width < 600});
    await context.addInitScript(theme => {localStorage.setItem("pi-locale", "en"); localStorage.setItem("pi-theme", theme);}, theme);
    let owner = tasks[0].id;
    const agentWrites = [], shared = [];
    await context.route("**/api/**", async route => {
      const req = route.request(), path = new URL(req.url()).pathname, body = req.postDataJSON();
      if (path.startsWith("/api/agent/") && req.method() === "POST") agentWrites.push(body);
      if (path === "/api/tasks") {
        if (body?.action === "task-picker") return route.fulfill({json: {tasks, relation: body.sessionId ? {sessionId: session.id, sourceTaskId: owner, generation: 0, updateRevision: 0} : null}});
        if (body?.action === "session-task") return route.fulfill({json: {task: tasks.find(task => task.id === owner) ?? null}});
        if (body?.action === "change-session-relation") {owner = body.targetTaskId; return route.fulfill({json: {}});}
        shared.push(body?.action ?? "list");
        return route.fulfill({status: 500, json: {error: "Dashboard must not be needed"}});
      }
      const fixtures = {
        "/api/sessions": {sessions: [session], runningSessionIds: []},
        [`/api/sessions/${session.id}`]: {info: session, tree: [], activeLeafId: null, context: {messages: [], entryIds: [], model: null, thinkingLevel: "off"}},
        [`/api/sessions/${session.id}/state`]: {running: false},
        "/api/cwd/validate": {cwd: body?.cwd ?? session.cwd, projectRoot: body?.cwd ?? session.cwd, projectKey: body?.cwd ?? session.cwd},
        "/api/home": {home: "/fixture"}, "/api/models": {models: {}, modelList: [], defaultModel: null},
        "/api/web-auth": {enabled: false}, "/api/agent/running": {runningSessionIds: []},
        "/api/subagents/settings": {enabled: false}, "/api/worktrees": {worktrees: []},
      };
      return route.fulfill({json: fixtures[path] ?? {}});
    });
    const page = await context.newPage();
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${base}/?cwd=${encodeURIComponent(session.cwd)}`);
    const input = page.locator("textarea").first();
    await input.waitFor();
    await input.pressSequentially("/task", {delay: 70});
    if (width < 600) await page.getByRole("button", {name: "Send", exact: true}).click(); else await input.press("Enter");
    const search = page.getByRole("combobox", {name: "Search tasks"});
    await search.fill("Login"); await page.getByRole("option", {name: /Login API/}).waitFor();
    assert.equal(await page.getByRole("dialog").getByRole("button", {name: "Reload tasks", exact: true}).count(), 0, "normal picker should not present a recovery action");
    if (artifacts) await page.screenshot({path: join(artifacts, `picker-${width}-${theme}.png`)});
    await search.press("Enter");
    await page.getByRole("button", {name: "Preselected task: Login API", exact: true}).waitFor();
    assert.equal(agentWrites.length, 0);
    assert.equal(await page.getByText("/new keeps this task. Changing project or opening another new chat clears it.", {exact: true}).count(), 0, "draft guidance belongs in the picker, not a persistent chat row");
    if (artifacts) await page.screenshot({path: join(artifacts, `membership-${width}-${theme}.png`)});
    const sourceInput = await input.elementHandle();
    await input.fill("/new");
    if (width < 600) await page.getByRole("button", {name: "Send", exact: true}).click(); else await input.press("Enter");
    await page.waitForFunction(element => !element.isConnected, sourceInput);
    await page.getByRole("button", {name: "Preselected task: Login API", exact: true}).waitFor({timeout: 5000});
    assert.equal(await input.inputValue(), "", "/new carries the task, never the source draft");
    assert.equal(agentWrites.length, 0, "/new does not initialize an Agent");
    await page.goto(`${base}/?session=${session.id}`);
    const membership = page.locator("[data-session-task]");
    await membership.getByRole("button", {name: /Login API/}).waitFor();
    await input.fill("Keep draft");
    await membership.getByRole("button", {name: /Login API/}).click();
    await search.fill("Billing"); await page.getByRole("option", {name: /Billing UI/}).waitFor(); await search.press("Enter");
    await membership.getByRole("button", {name: /Billing UI/}).waitFor({timeout: 5000}).catch(async error => { console.error({owner, errors, dialogs: await page.getByRole("dialog").allTextContents(), membership: await membership.allTextContents()}); throw error; });
    assert.equal(await input.inputValue(), "Keep draft");
    await membership.getByRole("button", {name: /Billing UI/}).click();
    await page.getByRole("option", {name: /Long task name/}).waitFor();
    await page.setViewportSize({width, height: 420});
    await search.press("ArrowDown");
    assert.equal(await page.getByRole("dialog").evaluate(element => element.scrollWidth <= element.clientWidth), true, "long task names must not overflow the picker");
    assert.equal(await page.getByRole("dialog").evaluate(element => element.getBoundingClientRect().bottom <= innerHeight), true, "picker remains inside a reduced viewport");
    await search.press("Escape");
    await page.waitForFunction(() => document.activeElement === document.querySelector("textarea"));
    assert.equal(owner, tasks[1].id);
    assert.equal(agentWrites.length, 0);
    assert.deepEqual(shared, []);
    assert.deepEqual(errors, []);
    console.log("PASS full-page /task, existing-session reassign, draft/focus and no dashboard/Agent", width, theme);
    await context.close();
  }
} finally {await browser.close();}
