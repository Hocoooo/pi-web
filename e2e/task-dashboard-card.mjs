import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createJiti } from "jiti";

// Reuse checkout dev. Every API is intercepted; only a temporary task store is written.
const base = process.env.E2E_BASE_URL || "http://127.0.0.1:30142";
const root = await mkdtemp(path.join(os.tmpdir(), "task-card-"));
const agentDir = path.join(root, "agent");
const options = { agentDir };
const { taskOperation } = await createJiti(import.meta.url).import("../lib/task-operations.ts");
const tasks = [];
for (const title of ["Alpha", "Bravo", "Charlie", ...Array.from({ length: 12 }, (_, i) => `Scroll task ${i}`)]) {
  const { task } = await taskOperation({ action: "create", id: randomUUID(), title, description: "", completionCriteria: "", cwd: null }, options);
  tasks.push((await taskOperation({ action: "edit", id: task.id, expectedRevision: task.revision,
    title, description: "", completionCriteria: "", priority: task.priority, labels: ["Card label"] }, options)).task);
}
const boardFile = path.join(agentDir, "tasks", "board.json");
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, hasTouch: true });
await context.addInitScript(() => localStorage.setItem("pi-locale", "en"));
const writes = [], errors = [], cases = [];
let agentWrites = 0;
await context.route("**/api/**", async route => {
  const request = route.request(), url = new URL(request.url());
  if (url.pathname === "/api/tasks") {
    const input = request.method() === "GET" ? { action: "list" } : request.postDataJSON();
    if (input.action === "sessions") return route.fulfill({ json: { linked: [], candidates: [] } });
    if (request.method() === "POST" && input.action !== "projects") writes.push(input);
    try { return route.fulfill({ json: await taskOperation(input, options) }); }
    catch (error) { return route.fulfill({ status: 409, json: { error: error.message, code: error.code } }); }
  }
  if (url.pathname.startsWith("/api/agent/") && request.method() === "POST") agentWrites++;
  const fixtures = {
    "/api/sessions": { sessions: [], runningSessionIds: [] },
    "/api/agent/running": { runningSessionIds: [] },
    "/api/default-cwd": { cwd: root, projectRoot: root, projectKey: "pi-web:chat", sessionKind: "chat" },
    "/api/home": { home: root }, "/api/models": { models: [], modelList: [], defaultModel: null },
    "/api/web-auth": { enabled: false }, "/api/subagents/settings": { enabled: false },
  };
  return route.fulfill({ json: fixtures[url.pathname] ?? {} });
});
const page = await context.newPage();
page.on("pageerror", error => errors.push(error.message));
const dialog = page.getByRole("dialog", { name: "Task dashboard", exact: true });
const card = task => dialog.locator(`[data-task-card="${task.id}"]`);
const inspector = () => dialog.locator("[data-task-inspector]:visible");
const overlay = () => dialog.locator("[data-task-overlay]");
async function ready() {
  await card(tasks[0]).waitFor();
  await page.waitForFunction(() => ![...document.querySelectorAll("button")].find(n => n.textContent === "Refresh")?.disabled);
}
async function open(target, task, clickOptions) {
  await target.click(clickOptions);
  await inspector().waitFor();
  assert.equal(await inspector().getAttribute("data-task-inspector"), task.id);
  assert.equal(await inspector().getByRole("combobox", { name: /^Move to:/ }).count(), 0);
  assert.equal(await inspector().locator('select option[value="todo"]').count(), 0);
  assert.equal(await card(task).getAttribute("aria-expanded"), "true");
  await inspector().getByRole("button", { name: "Close task details", exact: true }).click();
  await inspector().waitFor({ state: "hidden" });
}
async function mouseStart(task, selector = "[data-task-activity]") {
  const from = await card(task).locator(selector).boundingBox();
  assert.ok(from);
  const x = from.x + from.width / 2, y = from.y + from.height / 2;
  await page.mouse.move(x, y); await page.mouse.down();
  await page.mouse.move(x + 10, y, { steps: 3 });
  await overlay().waitFor();
  assert.equal(await inspector().count(), 0);
}
async function settled() {
  await overlay().waitFor({ state: "hidden" });
  await ready();
  // dnd-kit retains release-click suppression for 50ms after sensor teardown.
  await page.waitForTimeout(100);
  assert.equal(await inspector().count(), 0, "drag release must not open task details");
}
async function moveAndSave(target, fraction = .25) {
  const to = await target.boundingBox(); assert.ok(to);
  const previousWrites = writes.length;
  await page.mouse.move(to.x + to.width / 2, to.y + to.height * fraction, { steps: 12 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('p[role="status"]')?.textContent === "Task status and position saved.");
  await settled();
  assert.equal(writes.length, previousWrites + 1);
  assert.equal(writes.at(-1).action, "move");
}
const saved = () => taskOperation({ action: "list" }, options);
const idsIn = (board, columnId) => board.tasks.filter(task => task.columnId === columnId).map(task => task.id);
try {
  await page.goto(`${base}/?tasks=1`); await ready();
  const beforeClicks = await readFile(boardFile, "utf8");
  for (const selector of ["span:first-child", "p", "[data-task-activity]", "li"]) await open(card(tasks[0]).locator(selector).first(), tasks[0]);
  await open(card(tasks[0]), tasks[0], { position: { x: 4, y: 4 } }); // card padding, not its text
  assert.equal(writes.length, 0);
  assert.equal(await readFile(boardFile, "utf8"), beforeClicks);
  cases.push("title, project, activity, label and card background clicks open details without writes");

  const bounds = await card(tasks[0]).boundingBox();
  await page.mouse.move(bounds.x + 4, bounds.y + 4); await page.mouse.down();
  await page.mouse.move(bounds.x + 7, bounds.y + 4); await page.mouse.up();
  await inspector().waitFor(); assert.equal(await overlay().count(), 0);
  await page.keyboard.press("Escape"); await inspector().waitFor({ state: "hidden" });
  cases.push("sub-threshold mouse movement remains a click");

  for (const key of ["Enter", "Space"]) {
    await card(tasks[0]).focus(); await page.keyboard.press(key); await inspector().waitFor();
    assert.equal(await inspector().getAttribute("data-task-inspector"), tasks[0].id);
    await page.keyboard.press("Escape"); await inspector().waitFor({ state: "hidden" });
  }
  assert.equal(writes.length, 0);
  cases.push("Enter and Space open details from the card's single keyboard stop");

  await mouseStart(tasks[2], "li"); await moveAndSave(card(tasks[0]));
  assert.deepEqual(idsIn(await saved(), "todo").slice(0, 3), [tasks[2].id, tasks[0].id, tasks[1].id]);
  await mouseStart(tasks[0]); await moveAndSave(dialog.locator('[data-task-column="in-progress"]'), .7);
  assert.equal((await saved()).tasks.find(task => task.id === tasks[0].id).columnId, "in-progress");
  await page.reload(); await page.getByRole("button", { name: "Task dashboard", exact: true }).click(); await ready();
  assert.equal(await card(tasks[0]).locator("..").getAttribute("data-task-column"), "in-progress");
  cases.push("dragging labels/activity supports same-column reorder and cross-column move; reload retains state; no detail click");

  for (const cancel of ["escape", "outside", "self"]) {
    const before = await readFile(boardFile, "utf8"), count = writes.length;
    await mouseStart(tasks[2]);
    if (cancel === "escape") await page.keyboard.press("Escape");
    else if (cancel === "outside") await page.mouse.move(2, 2);
    await page.mouse.up(); await settled();
    assert.equal(writes.length, count); assert.equal(await readFile(boardFile, "utf8"), before);
  }
  await open(card(tasks[2]).locator("li"), tasks[2]);
  cases.push("Escape, outside and self drop cancel without writes or details; next click works");

  await card(tasks[1]).click(); await inspector().waitFor();
  assert.equal(await inspector().getByRole("combobox", { name: /^Move to:/ }).count(), 0);
  const originalOrder = idsIn(await saved(), "todo");
  for (const direction of ["up", "down"]) {
    const button = inspector().getByRole("button", { name: `Move ${direction}: Bravo`, exact: true });
    await button.focus(); await page.keyboard.press("Enter"); await ready();
    const board = await saved();
    assert.equal(board.tasks.find(task => task.id === tasks[1].id).columnId, "todo");
    assert.equal(writes.at(-1).columnId, "todo");
    assert.equal(await overlay().count(), 0);
    if (direction === "up") assert.equal(idsIn(board, "todo")[0], tasks[1].id);
    else assert.deepEqual(idsIn(board, "todo"), originalOrder);
  }
  await page.keyboard.press("Escape"); await inspector().waitFor({ state: "hidden" });
  await mouseStart(tasks[1]); await moveAndSave(dialog.locator('[data-task-column="review"]'), .7);
  assert.equal((await saved()).tasks.find(task => task.id === tasks[1].id).columnId, "review");
  cases.push("details have no status selector; keyboard up/down only reorders within the status; cross-status drag remains available");

  // Mobile viewport and real CDP touch sequences: tap, long press, cancel and scroll.
  await page.setViewportSize({ width: 390, height: 844 });
  await card(tasks[2]).scrollIntoViewIfNeeded();
  await card(tasks[2]).locator("p").tap(); await inspector().waitFor();
  assert.equal(await inspector().getByRole("combobox", { name: /^Move to:/ }).count(), 0);
  await inspector().getByRole("button", { name: "Close task details", exact: true }).tap();
  await inspector().waitFor({ state: "hidden" });
  const cdp = await context.newCDPSession(page);
  const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" || type === "touchCancel" ? [] : [{ x, y }] });
  async function touchStart(task) {
    await card(task).scrollIntoViewIfNeeded();
    const from = await card(task).locator("li").boundingBox(); assert.ok(from);
    const point = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
    await touch("touchStart", point.x, point.y); return point;
  }
  await touchStart(tasks[2]); await overlay().waitFor();
  const target = await card(tasks[3]).boundingBox(); assert.ok(target);
  const touchWrites = writes.length;
  await touch("touchMove", target.x + target.width / 2, target.y + target.height * .75);
  await touch("touchEnd"); await settled();
  assert.equal(writes.length, touchWrites + 1);
  assert.equal(writes.at(-1).action, "move");
  assert.deepEqual(idsIn(await saved(), "todo").slice(0, 2), [tasks[3].id, tasks[2].id]);
  cases.push("mobile tap opens details; long press on a label reorders without opening details");

  const beforeCancel = await readFile(boardFile, "utf8"), count = writes.length;
  await touchStart(tasks[3]); await overlay().waitFor(); await touch("touchCancel"); await settled();
  assert.equal(writes.length, count); assert.equal(await readFile(boardFile, "utf8"), beforeCancel);
  const point = await touchStart(tasks[3]);
  await touch("touchMove", point.x, point.y - 70); await touch("touchEnd");
  await page.waitForTimeout(350);
  assert.equal(await overlay().count(), 0); assert.equal(await inspector().count(), 0);
  assert.equal(writes.length, count); assert.equal(await readFile(boardFile, "utf8"), beforeCancel);
  const afterScroll = await card(tasks[3]).boundingBox();
  assert.ok(afterScroll.y < point.y - 70, "swiping on a card scrolls the panel rather than dragging");
  cases.push("touchCancel and swipe-before-delay preserve store and do not open details; swipe scrolls");

  await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" });
  assert.equal(agentWrites, 0); assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(root, "mobile.png") });
  await writeFile(path.join(root, "result.json"), JSON.stringify({ cases, writes, errors, agentWrites }, null, 2));
  console.log(`PASS ${cases.length} task-card scenarios; evidence=${root}`);
} catch (error) {
  await page.screenshot({ path: path.join(root, "failure.png"), fullPage: true });
  await writeFile(path.join(root, "failure.json"), JSON.stringify({ error: String(error), cases, writes, errors }, null, 2));
  console.error(`Evidence: ${root}`); throw error;
} finally { await browser.close(); }
