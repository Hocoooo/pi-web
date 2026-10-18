import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createJiti } from "jiti";
import { moveRequest } from "../lib/task-test-helpers.mjs";

// Intentionally reuses an already running server; never starts Next or touches its agent directory.
const base = process.env.E2E_BASE_URL || "http://127.0.0.1:30141";
const evidence = process.env.E2E_ARTIFACT_DIR || await mkdtemp(path.join(os.tmpdir(), "pi-web-task-browser-"));
await mkdir(evidence, { recursive: true });
const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-web-task-browser-data-"));
const project = path.join(agentDir, "fixture-project");
await mkdir(project);
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { taskOperation } = await jiti.import("../lib/task-operations.ts");
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
await context.addInitScript(() => {
  localStorage.setItem("pi-locale", "en");
  // LAN HTTP does not expose randomUUID; creating tasks must not rely on it.
  Object.defineProperty(Crypto.prototype, "randomUUID", { value: undefined, configurable: true });
});
const errors = [];
let failNext = false;
let loseNextResponse = false;
let agentRequests = 0;
await context.route("**/api/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname === "/api/tasks") {
    if (failNext && request.method() === "POST") { failNext = false; return route.fulfill({ status: 503, json: { error: "Fixture storage unavailable", code: "storage-unavailable" } }); }
    try {
      const input = request.method() === "GET" ? { action: "list" } : request.postDataJSON();
      const result = await taskOperation(input, { agentDir });
      if (loseNextResponse && request.method() === "POST") {
        loseNextResponse = false;
        return route.fulfill({ status: 503, json: { error: "Fixture response lost after commit", code: "storage-unavailable" } });
      }
      return route.fulfill({ json: result });
    } catch (error) {
      return route.fulfill({ status: error.code === "conflict" ? 409 : 400, json: { error: error.message, code: error.code } });
    }
  }
  if (url.pathname.startsWith("/api/agent/") && request.method() === "POST") agentRequests++;
  const fixtures = { "/api/sessions": { sessions: [], runningSessionIds: [] }, "/api/agent/running": { runningSessionIds: [] }, "/api/default-cwd": { cwd: path.join(agentDir, "chat-workspace"), projectRoot: path.join(agentDir, "chat-workspace"), projectKey: "pi-web:chat", sessionKind: "chat" }, "/api/home": { home: agentDir }, "/api/models": { models: [], modelList: [], defaultModel: null }, "/api/web-auth": { enabled: false }, "/api/subagents/settings": { enabled: false }, "/api/cwd/browse": { path: agentDir, parentPath: null, directories: [{ name: "fixture-project", path: project }] } };
  return route.fulfill({ json: fixtures[url.pathname] ?? {} });
});
const page = await context.newPage();
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(`${base}/tasks`);
  await page.getByRole("heading", { name: "Task dashboard", exact: true }).waitFor();
  await page.locator('[data-task-column="done"] h2').waitFor();
  assert.deepEqual(await page.locator("[data-task-column] h2").allTextContents(), ["To do (0)", "In progress (0)", "To review (0)", "Blocked (0)", "Done (0)"]);
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Browser task");
  await page.getByLabel("Description", { exact: true }).fill("<img src=x onerror=alert(1)> /private/secret");
  await page.getByLabel("Completion requirements", { exact: true }).fill("Tests pass and I confirm");
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  const card = page.locator("[data-task-card]").filter({ hasText: "Browser task" });
  await card.waitFor();
  await card.locator("summary").click();
  assert.equal(await card.locator("img").count(), 0);
  await card.getByText("Tests pass and I confirm", { exact: true }).waitFor();
  const menu = card.getByRole("combobox");
  await menu.focus();
  await page.keyboard.press("d");
  await page.locator('[data-task-column="done"]').getByText("Browser task", { exact: true }).waitFor();
  await page.reload();
  await page.locator('[data-task-column="done"]').getByText("Browser task", { exact: true }).waitFor();
  const second = await context.newPage();
  await second.goto(`${base}/tasks`);
  await second.locator('[data-task-column="done"]').getByText("Browser task", { exact: true }).waitFor();
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Project task");
  await page.getByLabel("Project directory (optional)", { exact: true }).fill(project);
  failNext = true;
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "Fixture storage unavailable" }).waitFor();
  assert.equal((await taskOperation({ action: "list" }, { agentDir })).tasks.length, 1);
  assert.equal(await page.getByLabel("Title", { exact: true }).inputValue(), "Project task");
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await page.getByText("Project task", { exact: true }).waitFor();
  assert.equal((await taskOperation({ action: "list" }, { agentDir })).tasks.length, 2);
  await second.reload();
  await second.getByText("Project task", { exact: true }).waitFor();
  // A stale page cannot overwrite a move saved by another page.
  await page.locator('[data-task-column="done"]').getByRole("combobox").selectOption("review");
  await page.locator('[data-task-column="review"]').getByText("Browser task", { exact: true }).waitFor();
  await second.locator('[data-task-column="done"]').getByRole("combobox").selectOption("blocked");
  await second.getByRole("alert").filter({ hasText: "changed in another page" }).waitFor();
  await second.getByRole("alert").getByRole("button", { name: "Refresh", exact: true }).click();
  await second.locator('[data-task-column="review"]').getByText("Browser task", { exact: true }).waitFor();
  // Retry after a committed but lost response reuses the task ID, rather than duplicating it.
  await page.getByRole("button", { name: "New task", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Uncertain task");
  loseNextResponse = true;
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "response lost after commit" }).waitFor();
  assert.equal((await taskOperation({ action: "list" }, { agentDir })).tasks.length, 3);
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await page.getByText("Uncertain task", { exact: true }).waitFor();
  assert.equal((await taskOperation({ action: "list" }, { agentDir })).tasks.length, 3);
  // Reconnection rereads durable state, without waking an Agent.
  const persisted = await taskOperation({ action: "list" }, { agentDir });
  const projectTask = persisted.tasks.find((task) => task.title === "Project task");
  await taskOperation(await moveRequest({ action: "move", id: projectTask.id, columnId: "blocked", expectedRevision: projectTask.revision }, { agentDir }), { agentDir });
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.locator('[data-task-column="blocked"]').getByText("Project task", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(evidence, "dashboard-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.getByRole("link", { name: "Chat", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page.waitForURL(`${base}/`);
  await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
  await page.getByRole("link", { name: "Task dashboard", exact: true }).waitFor();
  await page.getByRole("link", { name: "Task dashboard", exact: true }).click();
  await page.getByText("Project task", { exact: true }).waitFor();
  await page.screenshot({ path: path.join(evidence, "dashboard-mobile.png"), fullPage: true });
  assert.equal(agentRequests, 0, "board never sends an Agent command");
  assert.deepEqual(errors, []);
  console.log(`PASS: create, keyboard menu, plain-text details, reload/second page/reconnect, project/no project, storage error+retry/lost response, stale revision conflict, chat navigation, mobile; artifacts=${evidence}; isolatedAgentDir=${agentDir}`);
} catch (error) {
  await page.screenshot({ path: path.join(evidence, "dashboard-failure.png"), fullPage: true });
  await writeFile(path.join(evidence, "dashboard-failure.json"), JSON.stringify({ error: String(error), pageErrors: errors, url: page.url(), agentDir }, null, 2));
  throw error;
} finally { await browser.close(); }
