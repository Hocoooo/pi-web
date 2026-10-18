import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createJiti } from "jiti";

// All APIs are fixtures using the sole public operation and real temporary storage.
const base = process.env.E2E_BASE_URL || "http://127.0.0.1:30142";
const evidence = process.env.E2E_ARTIFACT_DIR || await mkdtemp(path.join(os.tmpdir(), "p05-browser-")); await mkdir(evidence, { recursive: true });
const agentDir = await mkdtemp(path.join(os.tmpdir(), "p05-data-")), options = { agentDir }, file = path.join(agentDir, "tasks", "board.json");
const { taskOperation } = await createJiti(import.meta.url).import("../lib/task-operations.ts");
const list = () => taskOperation({ action: "list" }, options);
const project = path.join(agentDir, "project"); await mkdir(project);
const tasks = [];
for (const [title, cwd, priority, labels] of [["Visible A", null, 1, ["focus", "both"]], ["Hidden A", null, 3, []], ["Visible B", null, 3, ["focus", "both"]], ["Project match", project, 2, ["focus"]], ["Hidden destination", null, 0, []]]) {
  let task = (await taskOperation({ action: "create", id: randomUUID(), title, description: "Search description", completionCriteria: "Confirm", cwd }, options)).task;
  task = (await taskOperation({ action: "edit", id: task.id, expectedRevision: task.revision, title, description: task.description, completionCriteria: task.completionCriteria, priority, labels }, options)).task;
  tasks.push(task);
}
let board = await list();
await taskOperation({ action: "move", id: tasks[4].id, columnId: "review", expectedRevision: tasks[4].revision, expectedOrderRevision: board.orderRevision, operationId: randomUUID(), position: { edge: "end" } }, options);
const customId = randomUUID(); board = await list();
await taskOperation({ action: "set-columns", expectedColumnsRevision: board.columnsRevision, columns: [...board.columns.map(({ id, label }) => ({ id, label })), { id: customId, label: "Custom status" }] }, options);
const stored = JSON.parse(await readFile(file, "utf8")); stored.tasks.find((task) => task.id === tasks[0].id).sessionIds = ["queue-fixture"]; await writeFile(file, JSON.stringify(stored));
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1500, height: 2600 }, hasTouch: true });
await context.addInitScript(() => { if (location.protocol.startsWith("http")) localStorage.setItem("pi-locale", "en"); });
const cases = [], errors = [], posts = []; let unexpected = 0, saveFailure = "", moveFailure = "", activityFailure = false, running = [];
context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
await context.route("**/api/**", async (route) => {
  const req = route.request(), url = new URL(req.url());
  if (url.pathname === "/api/tasks") {
    const input = req.method() === "GET" ? { action: "list" } : req.postDataJSON();
    if (req.method() === "POST") posts.push(input);
    const mode = input.action === "save-view" ? saveFailure : input.action === "move" ? moveFailure : "";
    if (input.action === "save-view") saveFailure = ""; if (input.action === "move") moveFailure = "";
    if (mode === "before") return route.fulfill({ status: 503, json: { error: "Fixture rejected before save", code: "storage-unavailable" } });
    try {
      const result = await taskOperation(input, options);
      if (mode === "lost") return route.fulfill({ status: 503, json: { error: "Fixture response lost after save", code: "storage-unavailable" } });
      return route.fulfill({ json: result });
    } catch (error) { return route.fulfill({ status: error.code === "conflict" ? 409 : 400, json: { error: error.message, code: error.code } }); }
  }
  if (url.pathname === "/api/agent/running" && req.method() === "GET") return route.fulfill(activityFailure ? { status: 503, json: { error: "Activity failed" } } : { json: { runningSessionIds: running, sessionActivity: {} } });
  unexpected++; return route.fulfill({ json: {} });
});
const page = await context.newPage();
const controls = (p = page) => p.getByRole("region", { name: "Filters and sorting", exact: true });
const card = (task, p = page) => p.locator(`[data-task-card="${task.id}"]`);
const col = (id) => page.locator(`[data-task-column="${id}"]`);
const clear = (p = page) => controls(p).getByRole("button", { name: "Clear filters", exact: true }).click();
const saveForm = (p = page) => p.getByRole("form", { name: "Save view", exact: true });
async function ready(p = page) { await p.locator('[data-task-column="todo"]').waitFor(); await p.waitForFunction(() => !document.querySelector('header button')?.disabled); }
async function titles(id, expected) { await page.waitForFunction(({ id, expected }) => JSON.stringify([...document.querySelectorAll(`[data-task-column="${id}"] summary`)].map((node) => node.textContent)) === JSON.stringify(expected), { id, expected }); }
async function savedView(p = page) { await saveForm(p).waitFor({ state: "hidden" }); await p.getByRole("status").filter({ hasText: "View save confirmed." }).waitFor(); }
async function beginSave(name, p = page) { await controls(p).getByRole("button", { name: "Save view", exact: true }).click(); await saveForm(p).getByLabel("View name", { exact: true }).fill(name); }
async function confirm(p = page) { await saveForm(p).getByRole("button", { name: "Confirm save view", exact: true }).click(); }
async function moved() { await page.getByRole("status").filter({ hasText: "Task status and position saved" }).waitFor(); }
async function drag(task, target, fraction = .25) {
  const handle = card(task).getByRole("button", { name: `Drag task: ${task.title}`, exact: true }); await handle.scrollIntoViewIfNeeded();
  const from = await handle.boundingBox(), to = await target.boundingBox();
  await page.mouse.move(from.x + 15, from.y + 15); await page.mouse.down(); await page.mouse.move(from.x + 30, from.y + 15);
  await page.locator("[data-task-overlay]").waitFor(); await page.mouse.move(to.x + to.width / 2, to.y + to.height * fraction, { steps: 10 }); await page.mouse.up();
}
try {
  await page.goto(`${base}/tasks`); await ready();
  const original = await list(), bytes = await readFile(file, "utf8");
  await controls().getByLabel("Search task text", { exact: true }).fill("search description");
  await controls().getByLabel("Project filter", { exact: true }).selectOption({ label: project });
  await controls().getByRole("group", { name: "Status filter (any selected)", exact: true }).getByLabel("To do", { exact: true }).check();
  await controls().getByRole("group", { name: "Priority", exact: true }).getByLabel("High", { exact: true }).check();
  await controls().getByRole("group", { name: "Labels (all selected)", exact: true }).getByLabel("focus", { exact: true }).check();
  await controls().getByLabel("AI work filter", { exact: true }).selectOption("idle");
  await titles("todo", ["Project match"]); assert.equal(await page.locator("[data-task-card]").count(), 1);
  assert.equal(await readFile(file, "utf8"), bytes);
  await clear(); await controls().getByLabel("Project filter", { exact: true }).selectOption({ label: "No project" });
  assert.equal(await card(tasks[3]).count(), 0); await controls().getByLabel("Search task text", { exact: true }).fill("no matching title");
  await page.getByRole("status").filter({ hasText: "No tasks match" }).waitFor(); assert.equal(await page.locator("[data-task-card]").count(), 0);
  await clear(); cases.push("combined six filters, single project/no-project/true empty feedback; storage bytes unchanged");

  // Save through keyboard, reopen after a full browser refresh, same real store.
  await controls().getByLabel("Search task text", { exact: true }).fill("Visible");
  await controls().getByLabel("Sort tasks", { exact: true }).selectOption("priority");
  await titles("todo", ["Visible B", "Visible A"]);
  await controls().getByRole("button", { name: "Save view", exact: true }).focus(); await page.keyboard.press("Enter");
  await saveForm().getByLabel("View name", { exact: true }).fill("Priority visible");
  await saveForm().getByRole("button", { name: "Confirm save view", exact: true }).focus(); await page.keyboard.press("Enter"); await savedView();
  const viewId = (await list()).savedViews[0].id;
  await page.reload(); await ready(); await controls().getByLabel("Saved views", { exact: true }).selectOption(viewId);
  await titles("todo", ["Visible B", "Visible A"]); assert.equal(await controls().getByLabel("Search task text", { exact: true }).inputValue(), "Visible");
  assert.deepEqual((await list()).tasks, original.tasks); cases.push("keyboard named save, refresh/reopen reuses server conditions and automatic sort without altering manual order");

  assert.ok(await card(tasks[0]).getByRole("button", { name: "Move down: Visible A", exact: true }).isDisabled());
  const beforeAuto = posts.length; await drag(tasks[0], card(tasks[2]));
  await page.getByRole("status").filter({ hasText: "Automatic sorting disables" }).waitFor(); assert.equal(posts.length, beforeAuto);
  await controls().getByLabel("Sort tasks", { exact: true }).selectOption("manual"); await titles("todo", ["Visible A", "Visible B"]);
  await card(tasks[2]).getByRole("button", { name: "Move up: Visible B", exact: true }).click(); await moved();
  assert.deepEqual(posts.at(-1).position, { before: tasks[0].id }); await titles("todo", ["Visible B", "Visible A"]);
  const afterNeighbor = await list(); assert.deepEqual(afterNeighbor.tasks.filter((task) => task.title.startsWith("Hidden")), original.tasks.filter((task) => task.title.startsWith("Hidden")));
  // Destination is visibly empty but has a hidden task: one edge-anchored move, not visible-array replacement.
  await drag(tasks[2], col("review"), .65); await moved(); assert.equal(posts.at(-1).id, tasks[2].id); assert.deepEqual(posts.at(-1).position, { edge: "end" });
  await titles("review", ["Visible B"]); assert.equal((await list()).tasks.find((task) => task.id === tasks[4].id).columnId, "review");
  await controls().getByRole("group", { name: "Status filter (any selected)", exact: true }).getByLabel("To do", { exact: true }).check();
  await card(tasks[0]).getByRole("combobox", { name: "Move to: Visible A", exact: true }).selectOption("review"); await moved();
  await page.getByRole("status").filter({ hasText: "No tasks match" }).waitFor(); assert.equal(await page.locator("[data-task-card]").count(), 0);
  assert.equal((await list()).tasks.length, 5); cases.push("automatic within-column drag refused; manual neighbor move preserves hidden records; mouse visible-empty target safe; move out of status filter disappears correctly");

  await clear(); await controls().getByLabel("Search task text", { exact: true }).fill("Visible"); await controls().getByLabel("Sort tasks", { exact: true }).selectOption("priority");
  await card(tasks[0]).getByRole("combobox", { name: "Move to: Visible A", exact: true }).selectOption("todo"); await moved();
  await card(tasks[2]).getByRole("combobox", { name: "Move to: Visible B", exact: true }).selectOption("todo"); await moved();
  await titles("todo", ["Visible B", "Visible A"]); await controls().getByLabel("Sort tasks", { exact: true }).selectOption("updated"); await titles("todo", ["Visible B", "Visible A"]);
  await controls().getByLabel("Sort tasks", { exact: true }).selectOption("manual"); await titles("todo", ["Visible A", "Visible B"]);
  cases.push("automatic cross-column changes remain usable and resort; priority/updated/manual switching preserves saved manual order");

  await beginSave("Lost view"); saveFailure = "lost"; await confirm(); await saveForm().getByRole("alert").filter({ hasText: "response lost" }).waitFor();
  const exact = posts.at(-1), committed = await list(); assert.equal(committed.savedViews.length, 2);
  await page.locator("header").getByRole("button", { name: "Refresh", exact: true }).click(); await ready();
  assert.equal(await saveForm().getByLabel("View name", { exact: true }).inputValue(), "Lost view"); await confirm(); await savedView();
  assert.deepEqual(posts.at(-1), exact); assert.deepEqual(await list(), committed);
  await beginSave("Failure recovery"); saveFailure = "before"; await confirm(); await saveForm().getByRole("alert").waitFor(); assert.deepEqual(await list(), committed);
  await confirm(); await savedView(); cases.push("lost response remains unconfirmed; refresh preserves fixed save base; exact retry confirms once; rejected save retains draft and retries");

  const second = await context.newPage(); await second.goto(`${base}/tasks`); await ready(second);
  await beginSave("Winner"); await beginSave("Stale draft", second); await confirm(); await savedView();
  await second.evaluate(() => window.dispatchEvent(new Event("online"))); await ready(second); await confirm(second);
  await saveForm(second).getByRole("alert").filter({ hasText: "Saved views changed" }).waitFor();
  assert.equal(await saveForm(second).getByLabel("View name", { exact: true }).inputValue(), "Stale draft"); assert.equal((await list()).savedViews.length, 4);
  await saveForm(second).getByRole("button", { name: "Cancel", exact: true }).click(); await second.close();
  cases.push("two-page view CAS conflict and online reload do not rebase or discard draft; no duplicate record");

  await clear(); await controls().getByLabel("Search task text", { exact: true }).fill("Visible");
  moveFailure = "lost"; await card(tasks[0]).getByRole("combobox", { name: "Move to: Visible A", exact: true }).selectOption("done");
  await page.getByRole("alert").filter({ hasText: "response lost" }).waitFor(); const exactMove = posts.at(-1), moveCommitted = await list();
  await page.evaluate(() => window.dispatchEvent(new Event("online"))); await ready(); await page.getByRole("button", { name: "Retry exact move", exact: true }).click(); await moved();
  assert.deepEqual(posts.at(-1), exactMove); assert.deepEqual(await list(), moveCommitted);
  const third = await context.newPage(); await third.goto(`${base}/tasks`); await ready(third);
  await card(tasks[0]).getByRole("combobox", { name: "Move to: Visible A", exact: true }).selectOption("todo"); await moved();
  await card(tasks[0], third).getByRole("combobox", { name: "Move to: Visible A", exact: true }).selectOption("review");
  await third.getByRole("alert").filter({ hasText: "changed in another page" }).waitFor(); await third.close();
  cases.push("filtered lost move keeps 03 receipt/retry across online, exact confirmation no extra move; two-page move still conflicts");

  await clear(); running = ["queue-fixture"]; await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await controls().getByLabel("AI work filter", { exact: true }).selectOption("working"); await card(tasks[0]).waitFor(); assert.equal(await page.locator("[data-task-card]").count(), 1);
  running = []; await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await page.getByRole("status").filter({ hasText: "No tasks match" }).waitFor();
  await controls().getByLabel("AI work filter", { exact: true }).selectOption("idle"); await card(tasks[0]).waitFor();
  activityFailure = true; await page.evaluate(() => window.dispatchEvent(new Event("online"))); await page.getByRole("status").filter({ hasText: "AI activity unavailable" }).waitFor();
  assert.equal(await card(tasks[0]).count(), 0); await controls().getByLabel("AI work filter", { exact: true }).selectOption("all");
  await card(tasks[0]).locator("[data-task-activity]").filter({ hasText: "AI activity unknown" }).waitFor();
  activityFailure = false; running = ["queue-fixture"]; await page.reload(); await ready(); await controls().getByLabel("AI work filter", { exact: true }).selectOption("working"); await card(tasks[0]).waitFor();
  cases.push("working/idle filter updates with lifecycle snapshots; failed/stale snapshot excludes unknown from idle and card says unknown; reopen resynchronizes");

  await clear(); await controls().getByRole("group", { name: "Status filter (any selected)", exact: true }).getByLabel("Custom status", { exact: true }).check();
  await beginSave("Custom stable ID"); await confirm(); await savedView(); const customView = (await list()).savedViews.find((view) => view.name === "Custom stable ID");
  assert.deepEqual(customView.filter.columnIds, [customId]);
  board = await list(); await taskOperation({ action: "set-columns", expectedColumnsRevision: board.columnsRevision, columns: board.columns.map(({ id, label }) => ({ id, label: id === customId ? "Renamed custom" : label })) }, options);
  await page.reload(); await ready(); await controls().getByLabel("Saved views", { exact: true }).selectOption(customView.id); await controls().getByLabel("Renamed custom", { exact: true }).waitFor();
  // A future deleted-column condition remains well-formed storage, invalid in projection: 14 consumer contract.
  const invalidDoc = JSON.parse(await readFile(file, "utf8")); invalidDoc.savedViews.find((view) => view.id === customView.id).filter.columnIds = [randomUUID()]; await writeFile(file, JSON.stringify(invalidDoc));
  await page.reload(); await ready(); await controls().getByLabel("Saved views", { exact: true }).selectOption(customView.id);
  await page.getByRole("alert").filter({ hasText: "missing status column" }).waitFor(); assert.equal(await page.locator("[data-task-card]").count(), 0);
  await clear(); assert.equal(await page.locator("[data-task-card]").count(), 5);
  cases.push("custom status saved by stable ID survives rename; unknown/deleted ID explicitly fails closed, clear recovers without broadening silently");

  // Both accepted draft domains remain above the filtered cards, with their original bases.
  const draftCard = card(tasks[0]); await draftCard.locator("summary").first().click();
  await draftCard.getByRole("button", { name: "Edit task details", exact: true }).click();
  const editForm = draftCard.getByRole("form", { name: "Edit task details", exact: true });
  await editForm.getByLabel("Title", { exact: true }).fill("Unsaved detail survives filter");
  const contextArea = draftCard.getByRole("region", { name: "Shared context", exact: true });
  await contextArea.getByRole("button", { name: "Write shared context", exact: true }).click();
  const contextForm = contextArea.getByRole("form", { name: "Review shared context", exact: true });
  await contextForm.getByLabel("Goal", { exact: true }).fill("Unsaved knowledge survives filter");
  const draftBytes = await readFile(file, "utf8");
  await controls().getByLabel("Search task text", { exact: true }).fill("nothing matches");
  assert.equal(await draftCard.count(), 0); await clear();
  assert.equal(await editForm.getByLabel("Title", { exact: true }).inputValue(), "Unsaved detail survives filter");
  assert.equal(await contextForm.getByLabel("Goal", { exact: true }).inputValue(), "Unsaved knowledge survives filter");
  await controls().getByLabel("Sort tasks", { exact: true }).selectOption("priority");
  await draftCard.getByRole("combobox", { name: "Move to: Visible A", exact: true }).selectOption("review"); await moved();
  assert.equal(await editForm.getByLabel("Title", { exact: true }).inputValue(), "Unsaved detail survives filter");
  assert.equal(await contextForm.getByLabel("Goal", { exact: true }).inputValue(), "Unsaved knowledge survives filter");
  await editForm.getByRole("button", { name: "Save details", exact: true }).click();
  await editForm.getByRole("alert").filter({ hasText: "changed in another page" }).waitFor();
  await editForm.getByRole("button", { name: "Cancel", exact: true }).click(); await contextForm.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal((await list()).tasks.find((task) => task.id === tasks[0].id).title, "Visible A");
  assert.equal(JSON.parse(draftBytes).tasks.find((task) => task.id === tasks[0].id).sharedContext.versions.length, 0);
  cases.push("02/06 simultaneous drafts survive filter unmount, sort and auto cross-column remount; old edit base conflicts, no accidental publish");

  await page.setViewportSize({ width: 390, height: 844 }); await page.reload(); await ready();
  await controls().getByLabel("Project filter", { exact: true }).selectOption({ label: "No project" });
  await controls().getByLabel("Search task text", { exact: true }).tap(); await controls().getByLabel("Search task text", { exact: true }).fill("Visible");
  await controls().getByRole("button", { name: "Save view", exact: true }).tap(); await saveForm().getByLabel("View name", { exact: true }).fill("Touch view");
  assert.equal(await saveForm().getByLabel("View name", { exact: true }).evaluate((node) => getComputedStyle(node).fontSize), "16px");
  await saveForm().getByRole("button", { name: "Confirm save view", exact: true }).tap(); await savedView();
  await card(tasks[0]).getByRole("combobox", { name: "Move to: Visible A", exact: true }).selectOption("blocked"); await moved();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await page.screenshot({ path: path.join(evidence, "views-mobile.png"), fullPage: true });
  cases.push("390px touch/native filtering, named confirmation and equivalent move menu; 16px text and no horizontal overflow");
  assert.equal(unexpected, 0); assert.deepEqual(errors, []);
  await writeFile(path.join(evidence, "results.json"), JSON.stringify({ cases, errors, unexpected, posts, agentDir, board: await list() }, null, 2));
  console.log(`PASS ${cases.length} view scenarios; evidence=${evidence}; agentDir=${agentDir}`);
} catch (error) {
  await page.screenshot({ path: path.join(evidence, "failure.png"), fullPage: true }).catch(() => {});
  await writeFile(path.join(evidence, "failure.json"), JSON.stringify({ error: String(error), cases, errors, unexpected, posts, agentDir }, null, 2)); throw error;
} finally { await browser.close(); }
