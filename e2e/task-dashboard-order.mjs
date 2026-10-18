import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createJiti } from "jiti";

const base = process.env.E2E_BASE_URL || "http://127.0.0.1:30142";
const evidence = process.env.E2E_ARTIFACT_DIR || await mkdtemp(path.join(os.tmpdir(), "pi-web-order-browser-"));
await mkdir(evidence, { recursive: true });
const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-web-order-browser-data-"));
const options = { agentDir };
const { taskOperation } = await createJiti(import.meta.url).import("../lib/task-operations.ts");
const tasks = [];
for (const title of ["Alpha", "Hidden sibling", "Bravo", "Charlie", "Delta"]) tasks.push((await taskOperation({ action: "create", id: randomUUID(), title, description: "Description stays", completionCriteria: "User confirms", cwd: null }, options)).task);
const file = path.join(agentDir, "tasks", "board.json");
const saved = () => taskOperation({ action: "list" }, options);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 2400 }, hasTouch: true });
await context.addInitScript(() => { if (location.protocol.startsWith("http")) localStorage.setItem("pi-locale", "en"); });
let failure = null, agentRequests = 0;
const requests = [], errors = [], cases = [];
context.on("page", (p) => p.on("pageerror", (error) => errors.push(error.message)));
await context.route("**/api/**", async (route) => {
  const req = route.request(), url = new URL(req.url());
  if (url.pathname === "/api/tasks") {
    const input = req.method() === "GET" ? { action: "list" } : req.postDataJSON();
    if (req.method() === "POST") requests.push(input);
    if (failure === "before" && req.method() === "POST") { failure = null; return route.fulfill({ status: 503, json: { code: "storage-unavailable", error: "Fixture move rejected before commit" } }); }
    if (failure === "network" && req.method() === "POST") { failure = null; return route.abort("failed"); }
    try {
      const result = await taskOperation(input, options);
      if (failure === "lost" && req.method() === "POST") { failure = null; return route.fulfill({ status: 503, json: { code: "storage-unavailable", error: "Fixture lost response after commit" } }); }
      return route.fulfill({ json: result });
    } catch (error) { return route.fulfill({ status: error.code === "conflict" ? 409 : error.code === "not-found" ? 404 : 400, json: { code: error.code, error: error.message } }); }
  }
  if (url.pathname.startsWith("/api/agent/") && req.method() === "POST") agentRequests++;
  return route.fulfill({ json: {} });
});
const page = await context.newPage();
const card = (p, task) => p.locator(`[data-task-card="${task.id}"]`);
const column = (p, id) => p.locator(`[data-task-column="${id}"]`);
const handle = (p, task) => card(p, task).getByRole("button", { name: `Drag task: ${task.title}`, exact: true });
async function ready(p) { await p.getByRole("button", { name: "Refresh", exact: true }).waitFor(); await p.waitForFunction(() => ![...document.querySelectorAll('button')].find((n) => n.textContent === 'Refresh')?.disabled); await card(p, tasks[0]).waitFor(); }
async function done(p) { await p.getByRole("status").filter({ hasText: "Task status and position saved" }).waitFor(); }
async function order(p, id, expected) { await p.waitForFunction(({ id, expected }) => JSON.stringify([...document.querySelectorAll(`[data-task-column="${id}"] [data-task-card] summary`)].map((n) => n.textContent)) === JSON.stringify(expected), { id, expected }); }
async function drag(task, target, fraction = .25) {
  await handle(page, task).scrollIntoViewIfNeeded();
  const from = await handle(page, task).boundingBox();
  const to = await target.boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2, { steps: 3 });
  await page.locator("[data-task-overlay]").waitFor();
  assert.equal(await page.locator("[data-task-overlay] :is(button,input,select,form)").count(), 0);
  await page.mouse.move(to.x + to.width / 2, to.y + to.height * fraction, { steps: 12 });
  await page.mouse.up();
}
try {
  await page.goto(`${base}/tasks`); await ready(page);
  await order(page, "todo", tasks.map((task) => task.title));
  await drag(tasks[3], card(page, tasks[2])); await done(page);
  await order(page, "todo", ["Alpha", "Hidden sibling", "Charlie", "Bravo", "Delta"]);
  assert.deepEqual((await saved()).tasks.find((task) => task.id === tasks[1].id), tasks[1]);
  await page.reload(); await ready(page); await order(page, "todo", ["Alpha", "Hidden sibling", "Charlie", "Bravo", "Delta"]);
  cases.push("mouse same-column reorder persists after reload; other task record unchanged; overlay pure display");

  await drag(tasks[2], column(page, "review"), .65); await done(page);
  await order(page, "review", ["Bravo"]);
  await drag(tasks[0], card(page, tasks[2]), .75); await done(page);
  await order(page, "review", ["Bravo", "Alpha"]);
  await drag(tasks[4], column(page, "done"), .65); await done(page);
  assert.equal((await saved()).tasks.find((task) => task.id === tasks[4].id).columnId, "done");
  cases.push("mouse empty-column and populated cross-column anchor; only explicit move completes task");

  // Escape and release outside the board are both non-writing cancellation.
  for (const cancel of ["escape", "outside"]) {
    const before = await readFile(file, "utf8"), count = requests.length;
    const from = await handle(page, tasks[0]).boundingBox();
    await page.mouse.move(from.x + 10, from.y + 10); await page.mouse.down(); await page.mouse.move(from.x + 30, from.y + 20);
    await page.locator("[data-task-overlay]").waitFor();
    if (cancel === "escape") await page.keyboard.press("Escape"); else await page.mouse.move(5, 5);
    await page.mouse.up(); await page.locator('p[role="status"]').filter({ hasText: "Drag cancelled" }).waitFor();
    assert.equal(requests.length, count); assert.equal(await readFile(file, "utf8"), before);
  }
  cases.push("Escape and outside drop cancel without POST or persisted receipt");

  // Keyboard equivalence after the sensor's 50ms post-drag click-suppression cleanup.
  await page.waitForTimeout(100);
  await card(page, tasks[0]).getByRole("button", { name: "Move up: Alpha", exact: true }).focus(); await page.keyboard.press("Enter"); await done(page);
  await order(page, "review", ["Alpha", "Bravo"]);
  await card(page, tasks[0]).getByRole("button", { name: "Move down: Alpha", exact: true }).focus(); await page.keyboard.press("Enter"); await done(page);
  await order(page, "review", ["Bravo", "Alpha"]);
  const menu = card(page, tasks[0]).getByRole("combobox", { name: "Move to: Alpha", exact: true });
  await menu.focus(); await page.keyboard.press("b"); await page.keyboard.press("Enter"); await done(page);
  await order(page, "blocked", ["Alpha"]);
  cases.push("keyboard up/down and native move-to menu use equivalent persisted operation");

  for (const mode of ["before", "network", "lost"]) {
    const before = await saved(); failure = mode;
    const target = mode === "lost" ? "in-progress" : mode === "network" ? "blocked" : "todo";
    await card(page, tasks[0]).getByRole("combobox", { name: "Move to: Alpha", exact: true }).selectOption(target);
    await page.locator("main").getByRole("alert").waitFor(); await page.getByRole("button", { name: "Retry exact move", exact: true }).waitFor();
    await page.waitForFunction(() => ![...document.querySelectorAll('button')].find((n) => n.textContent === 'Retry exact move')?.disabled);
    const original = requests.at(-1);
    const intermediate = await saved();
    if (mode !== "lost") assert.deepEqual(intermediate, before); else assert.equal(intermediate.tasks.find((task) => task.id === tasks[0].id).columnId, target);
    await order(page, intermediate.tasks.find((task) => task.id === tasks[0].id).columnId, intermediate.tasks.filter((task) => task.columnId === intermediate.tasks.find((item) => item.id === tasks[0].id).columnId).map((task) => task.title));
    await page.getByRole("button", { name: "Retry exact move", exact: true }).click(); await done(page);
    assert.deepEqual(requests.at(-1), original);
    if (mode === "lost") assert.deepEqual(await saved(), intermediate);
    else assert.equal((await saved()).orderRevision, before.orderRevision + 1);
    assert.equal(await page.locator("main").getByRole("alert").count(), 0);
  }
  cases.push("storage rejection/network abort synchronize unchanged board; lost response synchronizes committed result; retry identical UUID/anchor/revisions exactly once");

  const second = await context.newPage(); await second.goto(`${base}/tasks`); await ready(second);
  await card(page, tasks[0]).getByRole("combobox", { name: "Move to: Alpha", exact: true }).selectOption("review"); await done(page);
  const winner = await saved();
  await card(second, tasks[0]).getByRole("combobox", { name: "Move to: Alpha", exact: true }).selectOption("done");
  await second.getByRole("alert").filter({ hasText: "changed in another page" }).waitFor();
  await order(second, "review", winner.tasks.filter((task) => task.columnId === "review").map((task) => task.title));
  assert.deepEqual(await saved(), winner); assert.equal(await second.getByRole("button", { name: "Retry exact move", exact: true }).count(), 0);
  await second.close(); cases.push("two-page stale move visibly conflicts and adopts winner order/status rather than overwrite");

  // An opened 02 draft survives both a local reorder and a cross-column remount.
  await card(page, tasks[0]).locator("summary").click();
  await card(page, tasks[0]).getByRole("button", { name: "Edit task details", exact: true }).click();
  const edit = card(page, tasks[0]).getByRole("form", { name: "Edit task details", exact: true });
  await edit.getByLabel("Title", { exact: true }).fill("Keep the unsaved draft");
  await drag(tasks[0], column(page, "todo"), .1); await done(page);
  assert.equal(await edit.getByLabel("Title", { exact: true }).inputValue(), "Keep the unsaved draft");
  await edit.getByRole("button", { name: "Save details", exact: true }).click();
  await edit.getByRole("alert").filter({ hasText: "changed in another page" }).waitFor();
  await edit.getByRole("button", { name: "Cancel", exact: true }).click();
  cases.push("02 unsaved editor survives dragging/remount with original revision; stale edit rejects");
  await page.screenshot({ path: path.join(evidence, "order-desktop.png"), fullPage: true });

  // Real Chromium touch input through CDP (not dispatchEvent). This tests TouchSensor,
  // long-press activation, cancel, and normal pan scrolling; not a real Safari device.
  await page.setViewportSize({ width: 390, height: 844 }); await page.reload(); await ready(page);
  const cdp = await context.newCDPSession(page);
  const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" || type === "touchCancel" ? [] : [{ x, y, id: 1, radiusX: 2, radiusY: 2 }] });
  await page.locator("main").evaluate((n) => n.scrollTop = 0);
  const count = requests.length;
  // Pan from card text, then quickly pan on handle before 250ms: neither may drag.
  for (const startOnHandle of [false, true]) {
    await page.locator("main").evaluate((n) => n.scrollTop = 0);
    const element = startOnHandle ? handle(page, tasks[1]) : card(page, tasks[1]).locator("summary");
    await element.scrollIntoViewIfNeeded(); const rect = await element.boundingBox();
    const x = rect.x + rect.width / 2, y = Math.min(rect.y + rect.height / 2, 680);
    await touch("touchStart", x, y);
    for (let i = 1; i <= 8; i++) { await touch("touchMove", x, y - i * 25); await page.waitForTimeout(12); }
    await touch("touchEnd"); await page.waitForTimeout(250);
    assert.equal(await page.locator("[data-task-overlay]").count(), 0); assert.equal(requests.length, count);
    assert.ok(await page.locator("main").evaluate((n) => n.scrollTop > 0));
  }
  cases.push("390px CDP touch pan on text and quick handle pan scroll normally without activating or writing");

  await handle(page, tasks[1]).scrollIntoViewIfNeeded();
  let from = await handle(page, tasks[1]).boundingBox();
  await touch("touchStart", from.x + 20, from.y + 20); await page.waitForTimeout(330);
  await page.locator("[data-task-overlay]").waitFor(); await touch("touchCancel");
  await page.locator('p[role="status"]').filter({ hasText: "Drag cancelled" }).waitFor(); assert.equal(requests.length, count);
  // Position both source and neighbor inside the portrait viewport, then move upward.
  await page.locator("main").evaluate((n) => n.scrollTop = 0);
  const neighborRect = await card(page, tasks[1]).boundingBox();
  await page.locator("main").evaluate((n, top) => n.scrollTop = top - 150, neighborRect.y);
  from = await handle(page, tasks[3]).boundingBox();
  const mobileTarget = await card(page, tasks[1]).boundingBox();
  assert.ok(from.y > 0 && from.y + 30 < 800 && mobileTarget.y > 0 && mobileTarget.y + 30 < 800);
  await touch("touchStart", from.x + 20, from.y + 20); await page.waitForTimeout(330); await page.locator("[data-task-overlay]").waitFor();
  const y = mobileTarget.y + mobileTarget.height * .25;
  await touch("touchMove", mobileTarget.x + 90, y); await page.waitForTimeout(30); await touch("touchEnd"); await done(page);
  const mobileBoard = await saved();
  assert.deepEqual(mobileBoard.tasks.filter((task) => task.columnId === "todo").map((task) => task.title), ["Alpha", "Charlie", "Hidden sibling"]);
  await order(page, "todo", ["Alpha", "Charlie", "Hidden sibling"]);
  assert.equal(requests.length, count + 1); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.reload(); await ready(page); await order(page, "todo", mobileBoard.tasks.filter((task) => task.columnId === "todo").map((task) => task.title));
  await page.screenshot({ path: path.join(evidence, "order-mobile.png"), fullPage: true });
  cases.push("CDP touch long-press drag/reorder persists; touchCancel no write; no horizontal overflow");

  // Portrait cross-column drag uses the dashboard's actual edge auto-scroll.
  await handle(page, tasks[3]).scrollIntoViewIfNeeded(); from = await handle(page, tasks[3]).boundingBox();
  const scrollBefore = await page.locator("main").evaluate((n) => n.scrollTop);
  await touch("touchStart", from.x + 20, from.y + 20); await page.waitForTimeout(330);
  await page.locator("[data-task-overlay]").waitFor(); await touch("touchMove", 195, 820);
  let destination;
  for (let i = 0; i < 35; i++) {
    await page.waitForTimeout(120); destination = await column(page, "in-progress").boundingBox();
    if (destination.y > 0 && destination.y + destination.height / 2 < 780) break;
  }
  assert.ok(await page.locator("main").evaluate((n) => n.scrollTop) > scrollBefore, "active touch drag edge-scrolls the dashboard");
  assert.ok(destination.y > 0 && destination.y + destination.height / 2 < 780, "empty destination reached by auto-scroll");
  // Stop edge scrolling before measuring the final target, then observe the actual
  // droppable highlight before release (not a stale pre-scroll bounding box).
  await touch("touchMove", 195, 420); await page.waitForTimeout(100);
  destination = await column(page, "in-progress").boundingBox();
  await touch("touchMove", 195, destination.y + destination.height / 2);
  await column(page, "in-progress").locator(':scope[data-drop-over="true"]').waitFor();
  await touch("touchEnd"); await done(page);
  await order(page, "in-progress", ["Charlie"]);
  assert.equal((await saved()).tasks.find((task) => task.id === tasks[3].id).columnId, "in-progress");
  cases.push("390px portrait long-press cross-column drag reaches empty column using real edge auto-scroll");
  assert.equal(agentRequests, 0); assert.deepEqual(errors, []);
  await writeFile(path.join(evidence, "results.json"), JSON.stringify({ cases, agentRequests, errors, requests, agentDir, board: await saved() }, null, 2));
  console.log(`PASS ${cases.length} scenarios; evidence=${evidence}; isolatedAgentDir=${agentDir}`);
} catch (error) {
  await page.screenshot({ path: path.join(evidence, "failure.png"), fullPage: true });
  await writeFile(path.join(evidence, "failure.json"), JSON.stringify({ error: String(error), cases, errors, requests, agentRequests, agentDir }, null, 2)); throw error;
} finally { await browser.close(); }
