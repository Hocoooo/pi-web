import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";
const base = process.env.E2E_BASE_URL || "http://127.0.0.1:30142";
const evidence = process.env.E2E_ARTIFACT_DIR || await mkdtemp(path.join(os.tmpdir(), "ar12-browser-")); await mkdir(evidence, { recursive: true });
const agentDir = await mkdtemp(path.join(os.tmpdir(), "ar12-data-")), options = { agentDir }, file = path.join(agentDir, "tasks/board.json");
const { taskOperation } = await createJiti(import.meta.url).import("../lib/task-operations.ts");
const { AgentSessionWrapper } = await createJiti(import.meta.url).import("../lib/rpc-manager.ts");
const list = () => taskOperation({ action: "list" }, options);
const tasks = [];
for (const title of ["Archive unfinished", "Keep daily", "Busy associated"]) tasks.push((await taskOperation({ action: "create", id: randomUUID(), title, description: "Preserved details", completionCriteria: "User checks", cwd: null }, options)).task);
const manager = SessionManager.create(path.join(agentDir, "chat-workspace"), path.join(agentDir, "sessions", "--fixture--"));
manager.appendMessage({ role: "user", content: "Synthetic only", timestamp: Date.now() });
manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Synthetic reply" }], api: "fixture", provider: "fixture", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
const stored = JSON.parse(await readFile(file, "utf8")); stored.tasks[2].sessionIds = [manager.getSessionId()]; await writeFile(file, JSON.stringify(stored));
let aborts = 0, prompts = 0;
const inner = { sessionManager: manager, sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), isStreaming: true, isCompacting: false, isBashRunning: false, pendingMessageCount: 1,
  extensionRunner: { emit: async () => {} }, agent: { state: {} }, settingsManager: { getDefaultTools: () => [] }, dispose() {}, abort() { aborts++; }, prompt() { prompts++; } };
const wrapper = new AgentSessionWrapper(inner), registry = globalThis.__piSessions ??= new Map(); registry.set(wrapper.sessionId, wrapper);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 2200 }, hasTouch: true });
await context.addInitScript(() => { if (location.protocol.startsWith("http")) localStorage.setItem("pi-locale", "en"); });
const cases = [], errors = [], posts = []; let unexpected = 0, failure = "";
context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
await context.route("**/api/**", async route => {
  const req = route.request(), url = new URL(req.url());
  if (url.pathname === "/api/tasks") {
    const input = req.method() === "GET" ? { action: "list" } : req.postDataJSON(); if (req.method() === "POST") posts.push(input);
    const mode = input.action === "set-archive" ? failure : ""; if (input.action === "set-archive") failure = "";
    if (mode === "before") return route.fulfill({ status: 503, json: { error: "Fixture archive write failed", code: "storage-unavailable" } });
    try { const result = await taskOperation(input, options); if (mode === "lost") return route.fulfill({ status: 503, json: { error: "Fixture archive response lost", code: "storage-unavailable" } }); return route.fulfill({ json: result }); }
    catch (error) { return route.fulfill({ status: error.code === "conflict" ? 409 : error.code === "not-found" ? 404 : 400, json: { error: error.message, code: error.code } }); }
  }
  if (url.pathname === "/api/agent/running" && req.method() === "GET") return route.fulfill({ json: { runningSessionIds: inner.isStreaming ? [manager.getSessionId()] : [], sessionActivity: { [manager.getSessionId()]: { running: inner.isStreaming, queued: inner.pendingMessageCount > 0 } } } });
  unexpected++; return route.fulfill({ json: {} });
});
const page = await context.newPage();
const card = (task, p = page) => p.locator(`[data-task-card="${task.id}"]`);
const scope = (p = page) => p.getByRole("combobox", { name: "Task list", exact: true });
const controls = (p = page) => p.getByRole("region", { name: "Filters and sorting", exact: true });
async function ready(p = page) { await p.locator('[data-task-column="todo"]').waitFor(); await p.waitForFunction(() => !document.querySelector('header button')?.disabled); }
async function archived(p = page) { await p.getByRole("status").filter({ hasText: "Archived; status and history are unchanged." }).waitFor(); }
async function restored(p = page) { await p.getByRole("status").filter({ hasText: "Restored; status and history are unchanged." }).waitFor(); }
const archiveButton = (task, p = page) => card(task, p).getByRole("button", { name: `Archive: ${task.title}`, exact: true });
const restoreButton = (task, p = page) => card(task, p).getByRole("button", { name: `Restore: ${task.title}`, exact: true });
try {
  await page.goto(`${base}/tasks`); await ready(); assert.equal(await scope().inputValue(), "active");
  const before = await list(); await archiveButton(tasks[0]).focus(); await page.keyboard.press("Enter"); await archived();
  assert.equal(await card(tasks[0]).count(), 0); assert.equal(await card(tasks[1]).count(), 1); assert.equal((await list()).tasks[0].columnId, "todo");
  await scope().selectOption("archived"); await card(tasks[0]).waitFor(); assert.equal(await page.locator("[data-task-card]").count(), 1);
  await controls().getByLabel("Search task text", { exact: true }).fill("unfinished"); await card(tasks[0]).waitFor();
  await card(tasks[0]).locator("summary").first().click();
  await card(tasks[0]).getByText("Restore this task from the Archived list before starting work. Archive is not Stop or completion.", { exact: true }).waitFor();
  assert.ok(await card(tasks[0]).getByRole("button", { name: "Start task", exact: true }).isDisabled());
  await restoreButton(tasks[0]).focus(); await page.keyboard.press("Enter"); await restored(); assert.equal(await card(tasks[0]).count(), 0);
  await scope().selectOption("active"); await card(tasks[0]).waitFor();
  const strip = task => { const { archived, archiveRevision, ...rest } = task; void archived; void archiveRevision; return rest; }; assert.deepEqual((await list()).tasks.map(strip), before.tasks.map(strip));
  cases.push("unfinished keyboard archive hides daily card; discoverable archived list/search/details; explicit restore preserves status/metadata/order/history and does not start AI");

  await controls().getByRole("button", { name: "Clear filters", exact: true }).click();
  failure = "lost"; await archiveButton(tasks[0]).click(); await page.getByRole("alert").filter({ hasText: "response lost" }).waitFor();
  const exact = posts.at(-1), committed = await list(); assert.equal(committed.tasks[0].archived, true);
  await page.evaluate(() => window.dispatchEvent(new Event("online"))); await ready(); await page.getByRole("alert").filter({ hasText: "response lost" }).waitFor();
  await page.getByRole("button", { name: "Retry exact archive request", exact: true }).click(); await archived(); assert.deepEqual(posts.at(-1), exact); assert.deepEqual(await list(), committed);
  await scope().selectOption("archived"); failure = "before"; await restoreButton(tasks[0]).click(); await page.getByRole("alert").filter({ hasText: "write failed" }).waitFor(); assert.deepEqual(await list(), committed);
  const restoreRequest = posts.at(-1); await page.getByRole("button", { name: "Retry exact archive request", exact: true }).click(); await restored(); assert.deepEqual(posts.at(-1), restoreRequest);
  cases.push("lost archive response remains visibly unconfirmed across online; original UUID/base exact retry confirms once; failed restore changes nothing and explicit retry succeeds");

  await scope().selectOption("active"); await archiveButton(tasks[2]).click(); await page.getByRole("alert").filter({ hasText: "busy" }).waitFor();
  assert.equal((await list()).tasks[2].archived, false); assert.equal(aborts, 0); assert.equal(prompts, 0); assert.equal(await card(tasks[2]).count(), 1);
  inner.isStreaming = false; // queue alone must still refuse, not first agent_end => idle
  await archiveButton(tasks[2]).click(); await page.getByRole("alert").filter({ hasText: "queued work" }).waitFor();
  inner.pendingMessageCount = 0; await archiveButton(tasks[2]).click(); await archived(); assert.equal((await list()).tasks[2].archived, true);
  cases.push("backend busy and queue-only rejection visible; no abort/prompt or hidden running task; explicit retry after actual idle archives");

  await archiveButton(tasks[0]).click(); await archived(); await scope().selectOption("archived");
  const second = await context.newPage(); await second.goto(`${base}/tasks`); await ready(second); await scope(second).selectOption("archived");
  await restoreButton(tasks[0]).click(); await restored(); await restoreButton(tasks[0], second).click();
  await second.getByRole("alert").filter({ hasText: "Archive state changed in another page" }).waitFor(); assert.equal((await list()).tasks[0].archived, false);
  await second.getByRole("button", { name: "Refresh", exact: true }).first().click(); await ready(second); assert.equal(await card(tasks[0], second).count(), 0); await second.close();
  await page.reload(); await ready(); assert.equal(await scope().inputValue(), "active"); assert.equal(await card(tasks[0]).count(), 1); assert.equal(await card(tasks[2]).count(), 0);
  cases.push("two-page restore CAS conflict is explicit and reconciles to winner; full reopen keeps durable archive state with default daily list");

  await scope().selectOption("all"); await controls().getByLabel("Search task text", { exact: true }).fill("Busy associated"); await card(tasks[2]).waitFor();
  await card(tasks[2]).getByRole("combobox", { name: "Move to: Busy associated", exact: true }).selectOption("review");
  await page.getByRole("status").filter({ hasText: "Task status and position saved" }).waitFor(); assert.equal((await list()).tasks[2].archived, true); assert.equal((await list()).tasks[2].columnId, "review");
  await controls().getByRole("button", { name: "Save view", exact: true }).click(); const save = page.getByRole("form", { name: "Save view", exact: true }); await save.getByLabel("View name", { exact: true }).fill("Stable existing filters"); await save.getByRole("button", { name: "Confirm save view", exact: true }).click(); await save.waitFor({ state: "hidden" });
  assert.deepEqual(Object.keys((await list()).savedViews[0].filter).sort(), ["activity", "columnIds", "labels", "priorities", "project", "text"]);
  cases.push("all/archived tasks remain explicitly movable for14; archive scope is a separate projection and saved05 six conditions remain unchanged");

  await page.setViewportSize({ width: 390, height: 844 }); await controls().getByRole("button", { name: "Clear filters", exact: true }).tap(); await scope().selectOption("archived"); await restoreButton(tasks[2]).tap(); await restored();
  await scope().selectOption("active"); await card(tasks[2]).waitFor(); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await page.screenshot({ path: path.join(evidence, "archive-mobile.png"), fullPage: true });
  cases.push("390px touch/native list selection and explicit restore, no horizontal overflow");
  assert.equal(unexpected, 0); assert.deepEqual(errors, []); assert.equal(aborts, 0); assert.equal(prompts, 0);
  await writeFile(path.join(evidence, "results.json"), JSON.stringify({ cases, errors, unexpected, posts, agentDir, board: await list() }, null, 2)); console.log(`PASS ${cases.length} archive scenarios; evidence=${evidence}`);
} catch (error) { await page.screenshot({ path: path.join(evidence, "failure.png"), fullPage: true }).catch(() => {}); await writeFile(path.join(evidence, "failure.json"), JSON.stringify({ error: String(error), cases, errors, unexpected, posts, agentDir }, null, 2)); throw error; }
finally { registry.delete(wrapper.sessionId); wrapper.destroy(); await browser.close(); }
