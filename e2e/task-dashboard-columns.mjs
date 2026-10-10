import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createJiti } from "jiti";
import { moveRequest } from "../lib/task-test-helpers.mjs";

// Does not start dev. All APIs are fixtures over the public operation + a temporary store.
const base = process.env.E2E_BASE_URL || "http://127.0.0.1:30142";
const evidence = process.env.E2E_ARTIFACT_DIR || await mkdtemp(path.join(os.tmpdir(), "pi-web-columns-browser-"));
await mkdir(evidence, { recursive: true });
const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-web-columns-browser-data-"));
const options = { agentDir }, file = path.join(agentDir, "tasks", "board.json");
const { taskOperation } = await createJiti(import.meta.url, { alias: { "@": process.cwd() } }).import("../lib/task-operations.ts");
const project = path.join(agentDir, "project"); await mkdir(project);
const create = (title, cwd = null) => ({ action: "create", id: randomUUID(), title, cwd, description: "Fixture", completionCriteria: "User confirms" });
const completed = (await taskOperation(create("Completed fixture"), options)).task;
const projectTask = (await taskOperation(create("Project fixture", project), options)).task;
await taskOperation(create("No project fixture"), options);
await taskOperation(await moveRequest({ action: "move", id: completed.id, columnId: "done", expectedRevision: completed.revision }, options), options);
const list = () => taskOperation({ action: "list" }, options);
const initial = await list();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, hasTouch: true });
await context.addInitScript(() => { if (location.protocol.startsWith("http") && !localStorage.getItem("pi-locale")) localStorage.setItem("pi-locale", "en"); });
const errors = [], cases = [], posts = [];
let failNext = false, loseNext = false, unexpectedApis = 0;
context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
await context.route("**/api/**", async (route) => {
  const request = route.request(), url = new URL(request.url());
  if (url.pathname === "/api/tasks") {
    const input = request.method() === "GET" ? { action: "list" } : request.postDataJSON();
    if (request.method() === "POST") posts.push(input);
    if (input.action === "set-columns" && failNext) { failNext = false; return route.fulfill({ status: 503, json: { code: "storage-unavailable", error: "Fixture columns unavailable" } }); }
    try {
      const result = await taskOperation(input, options);
      if (input.action === "set-columns" && loseNext) { loseNext = false; return route.fulfill({ status: 503, json: { code: "storage-unavailable", error: "Fixture columns response lost after commit" } }); }
      return route.fulfill({ json: result });
    } catch (error) { return route.fulfill({ status: error.code === "conflict" ? 409 : error.code === "storage-unavailable" ? 503 : 400, json: { error: error.message, code: error.code } }); }
  }
  // Permit only the new read-only lifecycle snapshot, never an Agent command or state route.
  if (url.pathname === "/api/agent/running" && request.method() === "GET") return route.fulfill({ json: { runningSessionIds: [], sessionActivity: {} } });
  unexpectedApis++;
  return route.fulfill({ json: {} });
});
const page = await context.newPage();
const form = (p) => p.getByRole("form", { name: "Column settings", exact: true });
const row = (p, id) => form(p).locator(`[data-column-setting="${id}"]`);
const name = (p, id) => row(p, id).locator("input");
const headerRefresh = (p) => p.locator("header").getByRole("button", { name: "Refresh", exact: true });
async function open(p) { await p.locator("header").getByRole("button", { name: "Column settings", exact: true }).click(); await form(p).waitFor(); }
async function save(p) { await form(p).getByRole("button", { name: "Save columns", exact: true }).click(); }
async function cancel(p) { await form(p).getByRole("button", { name: "Cancel", exact: true }).click(); }
async function saved(p) { await form(p).waitFor({ state: "hidden" }); await p.getByRole("status").filter({ hasText: "Column settings saved." }).waitFor(); }
try {
  await page.goto(`${base}/tasks`); await page.locator('[data-task-column="done"]').waitFor();
  await open(page);
  const beforeCancel = await readFile(file, "utf8"), beforePosts = posts.length;
  assert.equal(await row(page, "done").getByRole("button", { name: "Remove column: Done", exact: true }).isDisabled(), true);
  await name(page, "todo").fill("Discard me"); await cancel(page);
  assert.equal(await readFile(file, "utf8"), beforeCancel); assert.equal(posts.length, beforePosts);
  cases.push("cancel discards settings without a POST or task mutation; done removal remains protected");

  // Only keyboard activates reorder and confirms, so drag is not required.
  await page.locator("header").getByRole("button", { name: "Column settings", exact: true }).focus(); await page.keyboard.press("Enter");
  await name(page, "done").focus(); await page.keyboard.press("Meta+A"); await page.keyboard.type("Needs checking");
  for (let i = 0; i < 4; i++) {
    await row(page, "done").getByRole("button", { name: "Move column up: Needs checking", exact: true }).focus(); await page.keyboard.press("Enter");
  }
  assert.equal(await form(page).locator("[data-column-setting]").first().getAttribute("data-column-setting"), "done");
  await form(page).getByRole("button", { name: "Add unfinished column", exact: true }).focus(); await page.keyboard.press("Enter");
  const added = form(page).locator("[data-column-setting]").last(); const addedId = await added.getAttribute("data-column-setting");
  await added.locator("input").focus(); await page.keyboard.type("Done");
  assert.ok((await added.innerText()).includes("Unfinished column"));
  await form(page).getByRole("button", { name: "Save columns", exact: true }).focus(); await page.keyboard.press("Enter"); await saved(page);
  let board = await list(); assert.equal(board.columns[0].id, "done"); assert.equal(board.columns[0].label, "Needs checking");
  assert.equal(board.columns.find((column) => column.id === addedId).isCompletion, false);
  assert.deepEqual(board.tasks, initial.tasks); assert.equal(board.orderRevision, initial.orderRevision);
  assert.deepEqual(board.columns.filter((column) => column.isCompletion).map((column) => column.id), ["done"]);
  assert.equal(await page.locator("[data-task-column]").first().getAttribute("data-task-column"), "done");
  await page.reload(); await page.locator('[data-task-column="done"]').getByRole("heading", { name: "Needs checking (1)", exact: true }).waitFor();
  await page.locator(`[data-task-card="${completed.id}"]`).waitFor();
  const projectCard = page.locator(`[data-task-card="${projectTask.id}"]`);
  const select = projectCard.getByRole("combobox"); assert.ok((await select.locator("option").allTextContents()).includes("Done"));
  await select.selectOption(addedId); await page.locator(`[data-task-column="${addedId}"]`).locator("[data-task-card]").filter({ hasText: "Project fixture" }).waitFor();
  board = await list(); assert.equal(board.tasks.find((task) => task.title === "Project fixture").columnId, addedId);
  assert.equal(board.tasks.find((task) => task.id === completed.id).columnId, "done");
  cases.push("keyboard rename/reorder/add/save/reload; original done stays complete; column named Done is unfinished and usable by project tasks");

  await open(page); const bytes = await readFile(file, "utf8");
  await name(page, addedId).fill(" "); await save(page);
  await form(page).getByRole("alert").filter({ hasText: "Column names must be non-empty" }).waitFor();
  assert.equal(await readFile(file, "utf8"), bytes);
  await name(page, addedId).fill("<img src=x onerror=alert(1)> /private/plain");
  failNext = true; await save(page);
  await form(page).getByRole("alert").filter({ hasText: "Fixture columns unavailable" }).waitFor();
  assert.equal(await name(page, addedId).inputValue(), "<img src=x onerror=alert(1)> /private/plain"); assert.equal(await readFile(file, "utf8"), bytes);
  await save(page); await saved(page);
  assert.equal(await page.locator(`[data-task-column="${addedId}"]`).locator("h2 img, h2 a, h2 script").count(), 0);
  cases.push("server invalid name and failed save retain draft, prior settings/tasks; retry succeeds; name rendered as pure text");

  const second = await context.newPage(); await second.goto(`${base}/tasks`); await second.locator('[data-task-column="done"]').waitFor();
  await open(page); await open(second);
  await name(second, "done").fill("Second page draft");
  await name(page, "done").fill("First page wins"); await save(page); await saved(page);
  const winner = await list();
  await second.evaluate(() => window.dispatchEvent(new Event("online")));
  await second.locator('[data-task-column="done"] h2').filter({ hasText: "First page wins" }).waitFor();
  assert.equal(await name(second, "done").inputValue(), "Second page draft");
  await headerRefresh(second).click(); await second.getByRole("status").filter({ hasText: "Loading" }).waitFor({ state: "hidden" });
  await save(second); await form(second).getByRole("alert").filter({ hasText: "Columns changed in another page" }).waitFor();
  assert.equal(await name(second, "done").inputValue(), "Second page draft"); assert.deepEqual(await list(), winner);
  await cancel(second); await open(second); assert.equal(await name(second, "done").inputValue(), "First page wins"); await cancel(second);
  cases.push("two-page conflict, online/manual refresh update saved board without rebasing draft; explicit cancel/reopen adopts configuration");

  await open(second); await name(second, "review").fill("Committed uncertain name"); loseNext = true; await save(second);
  await form(second).getByRole("alert").filter({ hasText: "response lost after commit" }).waitFor();
  const uncertain = await list(); assert.equal(uncertain.columns.find((column) => column.id === "review").label, "Committed uncertain name");
  await save(second); await form(second).getByRole("alert").filter({ hasText: "Columns changed in another page" }).waitFor();
  assert.deepEqual(await list(), uncertain);
  await headerRefresh(second).click(); await second.locator('[data-task-column="review"] h2').filter({ hasText: "Committed uncertain name" }).waitFor();
  await cancel(second); await second.close();
  cases.push("lost settings response retains draft and never falsely reports saved; strict retry conflicts; refresh confirms authority");

  await page.setViewportSize({ width: 390, height: 844 }); await page.reload(); await page.locator('[data-task-column="done"]').waitFor();
  await page.locator("header").getByRole("button", { name: "Column settings", exact: true }).tap();
  await name(page, "blocked").tap(); await name(page, "blocked").fill("Mobile blocked");
  assert.equal(await name(page, "blocked").evaluate((input) => getComputedStyle(input).fontSize), "16px");
  await row(page, "blocked").getByRole("button", { name: "Move column up: Mobile blocked", exact: true }).tap();
  failNext = true; await form(page).getByRole("button", { name: "Save columns", exact: true }).tap();
  await form(page).getByRole("alert").filter({ hasText: "Fixture columns unavailable" }).waitFor();
  assert.equal(await name(page, "blocked").inputValue(), "Mobile blocked");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(evidence, "columns-mobile-error.png"), fullPage: true });
  await form(page).getByRole("button", { name: "Cancel", exact: true }).tap();
  assert.notEqual((await list()).columns.find((column) => column.id === "blocked").label, "Mobile blocked");
  await page.locator("header").getByRole("button", { name: "Column settings", exact: true }).tap();
  await name(page, "blocked").fill("Mobile saved"); await form(page).getByRole("button", { name: "Save columns", exact: true }).tap(); await saved(page);
  await page.reload(); await page.locator('[data-task-column="blocked"] h2').filter({ hasText: "Mobile saved" }).waitFor();
  await page.screenshot({ path: path.join(evidence, "columns-mobile.png"), fullPage: true });
  cases.push("390px touch name/reorder/failure/cancel/save/reload; 16px inputs; no horizontal overflow");

  // Default labels remain localized while user names stay literal in all supported locales.
  for (const [locale, settings, todo] of [["en", "Column settings", "To do"], ["zh-CN", "列设置", "待办"], ["zh-TW", "欄設定", "待辦"]]) {
    await page.evaluate((locale) => localStorage.setItem("pi-locale", locale), locale); await page.reload();
    await page.locator("header").getByRole("button", { name: settings, exact: true }).waitFor();
    await page.locator('[data-task-column="todo"] h2').filter({ hasText: todo }).waitFor();
    await page.locator('[data-task-column="done"] h2').filter({ hasText: "First page wins" }).waitFor();
  }
  cases.push("three locales: localized untouched defaults, literal saved names and fixed done identity");
  assert.equal(unexpectedApis, 0); assert.deepEqual(errors, []);
  await writeFile(path.join(evidence, "results.json"), JSON.stringify({ cases, errors, unexpectedApis, posts, agentDir, board: await list() }, null, 2));
  console.log(`PASS ${cases.length} column scenarios; evidence=${evidence}; isolatedAgentDir=${agentDir}`);
} catch (error) {
  await page.screenshot({ path: path.join(evidence, "columns-failure.png"), fullPage: true }).catch(() => {});
  await writeFile(path.join(evidence, "failure.json"), JSON.stringify({ error: String(error), cases, errors, unexpectedApis, agentDir }, null, 2));
  throw error;
} finally { await browser.close(); }
