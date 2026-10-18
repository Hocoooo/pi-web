// Source dev only, all API requests intercepted; real temporary SDK managers/store, no model/runtime starts.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
const base = process.env.E2E_BASE_URL || "http://127.0.0.1:30143";
const evidence = process.env.E2E_ARTIFACT_DIR || await mkdtemp(join(tmpdir(), "pi-web-task-links-browser-")); await mkdir(evidence, { recursive: true });
const agentDir = await mkdtemp(join(tmpdir(), "pi-web-task-links-browser-data-"));
const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
const options = { agentDir }, chatCwd = join(agentDir, "chat-workspace"), projectCwd = join(agentDir, "project"); await mkdir(chatCwd); await mkdir(projectCwd);
async function fixture(cwd, name) {
  const dir = join(agentDir, "sessions", cwd === chatCwd ? "chat" : "project"); await mkdir(dir, { recursive: true });
  const manager = SessionManager.create(cwd, dir); manager.appendMessage({ role: "user", content: "fixture history", timestamp: Date.now() }); manager.appendSessionInfo(name);
  const date = new Date().toISOString();
  return { manager, info: { id: manager.getSessionId(), name, cwd, path: manager.getSessionFile(), projectRoot: cwd, projectKey: cwd === chatCwd ? "pi-web:chat" : cwd,
    sessionKind: cwd === chatCwd ? "chat" : "project", created: date, modified: date, messageCount: 1, firstMessage: name } };
}
const sources = await Promise.all([fixture(chatCwd, "Source chat"), fixture(chatCwd, "Old chat A"), fixture(chatCwd, "Old chat B"), fixture(projectCwd, "Foreign project chat")]);
const sessions = sources.map((s) => s.info), source = sessions[0];
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { taskOperation } = await jiti.import("../lib/task-operations.ts");
const { listSessionsIncremental } = await jiti.import("../lib/session-list-scanner.ts"); await listSessionsIncremental();
const file = join(agentDir, "tasks", "board.json"), sourceBytes = await readFile(source.path);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, hasTouch: true });
await context.addInitScript(() => { if (location.protocol.startsWith("http")) localStorage.setItem("pi-locale", "en"); });
const calls = [], errors = [], cases = [];
let failLink = false, failActivity = false, sessionActivity = {}, runningSessionIds = [];
await context.route("**/api/**", async (route) => {
  const request = route.request(), url = new URL(request.url()); calls.push({ method: request.method(), path: url.pathname, body: request.postDataJSON() });
  if (url.pathname === "/api/tasks") {
    const input = request.method() === "GET" ? { action: "list" } : request.postDataJSON();
    if (failLink && input.action === "link") { failLink = false; return route.fulfill({ status: 503, json: { error: "Fixture link unavailable", code: "storage-unavailable" } }); }
    try { return route.fulfill({ json: await taskOperation(input, options) }); }
    catch (error) { return route.fulfill({ status: error.code === "conflict" ? 409 : error.code === "not-found" ? 404 : error.code === "invalid-input" ? 400 : 503, json: { error: error.message, code: error.code } }); }
  }
  let data = {};
  if (url.pathname === "/api/sessions") data = { sessions, sessionListVersion: 1, runningSessionIds };
  else if (url.pathname === "/api/agent/running") {
    if (failActivity) return route.fulfill({ status: 503, json: { error: "Fixture activity unavailable" } });
    data = { runningSessionIds, sessionActivity, sessionListVersion: 1 };
  }
  else if (url.pathname === "/api/default-cwd") data = { cwd: chatCwd, projectRoot: chatCwd, projectKey: "pi-web:chat", sessionKind: "chat" };
  else if (url.pathname === "/api/cwd/validate") { const { cwd } = request.postDataJSON(); data = { cwd, projectRoot: cwd, projectKey: cwd === chatCwd ? "pi-web:chat" : cwd }; }
  else if (url.pathname === "/api/models") data = { models: {}, modelList: [] };
  else if (url.pathname === "/api/worktrees") data = { isGit: false, worktrees: [] };
  else if (url.pathname.startsWith("/api/sessions/")) { const info = sessions.find((s) => url.pathname.includes(s.id)); data = { sessionId: info?.id, info, context: { messages: [], entryIds: [], hasMore: false }, tree: [], toolNames: ["read"] }; }
  else if (url.pathname.startsWith("/api/agent/")) data = { running: false, success: true, data: [] };
  else if (url.pathname.startsWith("/api/files")) data = { entries: [] };
  return route.fulfill({ json: data });
});
const page = await context.newPage(); page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(`${base}/?session=${source.id}`, { waitUntil: "networkidle" }); await page.locator("textarea").first().waitFor();
  const sourceDraft = "Unsent source chat draft — must remain unchanged";
  await page.locator("textarea").first().fill(sourceDraft);
  await page.getByRole("link", { name: "Create task from this chat", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Chat-created task");
  assert.equal(await page.getByLabel("Project directory (optional)", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Task saved." }).waitFor();
  const task = (await taskOperation({ action: "list" }, options)).tasks[0];
  const card = page.locator(`[data-task-card="${task.id}"]`); await card.waitFor();
  assert.deepEqual(task.sessionIds, [source.id]); assert.equal(task.project, null); assert.deepEqual(await readFile(source.path), sourceBytes);
  await card.locator("summary").focus(); await page.keyboard.press("Enter");
  await card.getByRole("button", { name: "Chats (1)", exact: true }).click();
  await card.getByRole("list", { name: "Linked chats", exact: true }).getByRole("link", { name: "Source chat", exact: true }).waitFor();
  assert.equal(await card.getByRole("checkbox").count(), 2, "only same-project unassigned chats");
  assert.equal((await card.innerText()).includes("Foreign project chat"), false);
  cases.push("source navigation / same identity / atomic source binding / unchanged source history");
  await card.getByRole("list", { name: "Linked chats", exact: true }).getByRole("link", { name: "Source chat", exact: true }).click();
  await page.waitForURL(new RegExp(`session=${source.id}`)); await page.locator("textarea").first().waitFor();
  assert.equal(await page.locator("textarea").first().inputValue(), sourceDraft, "source task creation preserves the existing-session unsent draft");
  assert.deepEqual(await readFile(source.path), sourceBytes);
  assert.equal((await taskOperation({ action: "list" }, options)).tasks[0].project, null);
  await page.getByRole("link", { name: "Task dashboard", exact: true }).click(); await card.waitFor();
  await card.locator("summary").focus(); await page.keyboard.press("Enter");
  await card.getByRole("button", { name: "Chats (1)", exact: true }).click();
  await card.getByRole("checkbox").first().waitFor();
  cases.push("source chat return preserves exact unsent draft / original session identity and file bytes / no ensure, model or tool commands");

  const checkboxes = card.getByRole("checkbox"); await checkboxes.nth(0).focus(); await page.keyboard.press("Space"); await checkboxes.nth(1).focus(); await page.keyboard.press("Space");
  failLink = true; await card.getByRole("button", { name: "Link selected chats (2)", exact: true }).click();
  await card.getByRole("alert").filter({ hasText: "Fixture link unavailable" }).waitFor();
  assert.equal(await checkboxes.nth(0).isChecked(), true); assert.equal((await taskOperation({ action: "list" }, options)).tasks[0].sessionIds.length, 1);
  await card.getByRole("button", { name: "Link selected chats (2)", exact: true }).click();
  await card.getByRole("button", { name: "Chats (3)", exact: true }).waitFor();
  await card.getByRole("list", { name: "Linked chats", exact: true }).getByRole("link", { name: "Old chat A", exact: true }).waitFor();
  assert.equal((await taskOperation({ action: "list" }, options)).tasks[0].sessionIds.length, 3);
  cases.push("keyboard multi-select / failed atomic save preserves choice / retry saves real count");

  runningSessionIds = [source.id]; sessionActivity = { [source.id]: { running: true, waitingForInput: true } };
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await card.locator("[data-task-activity]").filter({ hasText: "AI working" }).waitFor();
  await card.getByRole("list", { name: "Linked chats", exact: true }).getByText(/Waiting for input/).waitFor();
  const saved = await readFile(file, "utf8");
  sessionActivity = { [source.id]: { running: true, queued: true } }; await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await card.getByRole("list", { name: "Linked chats", exact: true }).getByText(/Messages queued/).waitFor();
  assert.equal(await readFile(file, "utf8"), saved, "runtime hints never move a task");
  failActivity = true; await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.getByRole("status").filter({ hasText: "AI activity unavailable; the last snapshot may be stale." }).waitFor();
  assert.ok((await card.locator("[data-task-activity]").innerText()).includes("AI activity unknown"), "failed poll must explicitly report unknown, not fabricate idle");
  assert.ok((await card.getByRole("list", { name: "Linked chats", exact: true }).innerText()).includes("Messages queued"), "retain the last known activity hint");
  failActivity = false;
  await page.reload(); await card.waitFor();
  await card.locator("[data-task-activity]").filter({ hasText: "AI working" }).waitFor();
  assert.equal(await page.locator("main form").count(), 0, "successful source-create query cannot reopen a creation attempt on reload");
  await card.locator("summary").focus(); await page.keyboard.press("Enter");
  await card.getByRole("button", { name: "Chats (3)", exact: true }).click();
  await card.getByRole("list", { name: "Linked chats", exact: true }).getByText(/Messages queued/).waitFor();
  assert.equal(await readFile(file, "utf8"), saved, "failure and page reopening only recalibrate, never change task status/revision/time");
  cases.push("failed polling keeps stale activity with warning / page reopening recalibrates active queue / source query cleared");
  runningSessionIds = []; sessionActivity = {}; await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await card.locator("[data-task-activity]").filter({ hasText: "AI idle" }).waitFor();
  cases.push("poll/reconnect hints for pending input and queue / idle recalibration / no task mutation");

  await card.getByRole("list", { name: "Linked chats", exact: true }).getByRole("link", { name: "Old chat A", exact: true }).click();
  await page.waitForURL(new RegExp(`session=${sessions[1].id}`)); await page.locator("textarea").first().waitFor();
  await page.getByRole("link", { name: "Task dashboard", exact: true }).click(); await card.waitFor();
  await page.reload(); await card.waitFor(); assert.ok((await card.locator("[data-task-activity]").innerText()).includes("Chats: 3"));
  cases.push("open original chat via native session URL / return and refresh preserve relations");
  await page.setViewportSize({ width: 390, height: 844 }); await card.locator("summary").tap();
  await card.getByRole("button", { name: "Chats (3)", exact: true }).tap();
  await card.getByRole("list", { name: "Linked chats", exact: true }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(evidence, "links-mobile.png"), fullPage: true }); cases.push("390px touch detail / original chat links accessible / no horizontal overflow");
  assert.deepEqual(errors, []);
  assert.deepEqual(calls.filter((call) => call.path.startsWith("/api/agent/") && call.method === "POST"), [], "no Agent starts, MCP or prompts");
  await writeFile(join(evidence, "results.json"), JSON.stringify({ cases, calls, errors }, null, 2));
  console.log(`PASS ${cases.length} scenarios; evidence=${evidence}`);
} catch (error) { await page.screenshot({ path: join(evidence, "links-failure.png"), fullPage: true }); await writeFile(join(evidence, "failure.json"), JSON.stringify({ error: String(error), cases, errors, calls }, null, 2)); throw error; }
finally { await browser.close(); await rm(agentDir, { recursive: true, force: true }); if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; }
