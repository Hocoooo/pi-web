import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createJiti } from "jiti";
import { moveRequest } from "../lib/task-test-helpers.mjs";

// Existing source dev only. Every API is intercepted; data lives in our own temporary store.
const base = process.env.E2E_BASE_URL || "http://127.0.0.1:30142";
const evidence = process.env.E2E_ARTIFACT_DIR || await mkdtemp(path.join(os.tmpdir(), "pi-web-task-details-browser-"));
await mkdir(evidence, { recursive: true });
const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-web-task-details-browser-data-"));
const options = { agentDir };
const project = path.join(agentDir, "fixture-project"); await mkdir(project);
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { taskOperation } = await jiti.import("../lib/task-operations.ts");
const create = (extra = {}) => ({ action: "create", id: randomUUID(), title: "Legacy task", description: "Original explanation", completionCriteria: "Original requirements", cwd: null, ...extra });
const legacyCreate = create();
const legacy = (await taskOperation(legacyCreate, options)).task;
const projectTask = (await taskOperation(create({ title: "Project task", cwd: project }), options)).task;
const file = path.join(agentDir, "tasks", "board.json");
const legacyDocument = JSON.parse(await readFile(file, "utf8"));
legacyDocument.version = 1; delete legacyDocument.sessionRelations; delete legacyDocument.orderRevision;
for (const key of ["priority", "labels", "creationFingerprint"]) delete legacyDocument.tasks[0][key];
await writeFile(file, JSON.stringify(legacyDocument));
const savedTask = async (id = legacy.id) => (await taskOperation({ action: "list" }, options)).tasks.find((task) => task.id === id);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, hasTouch: true });
await context.addInitScript(() => {
  if (location.protocol === "http:" || location.protocol === "https:") localStorage.setItem("pi-locale", "en");
});
const errors = [], cases = [];
let failNext = false, loseNext = false, agentRequests = 0;
context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
await context.route("**/api/**", async (route) => {
  const request = route.request(), url = new URL(request.url());
  if (url.pathname === "/api/tasks") {
    if (failNext && request.method() === "POST") { failNext = false; return route.fulfill({ status: 503, json: { error: "Fixture edit storage unavailable", code: "storage-unavailable" } }); }
    try {
      const result = await taskOperation(request.method() === "GET" ? { action: "list" } : request.postDataJSON(), options);
      if (loseNext && request.method() === "POST") { loseNext = false; return route.fulfill({ status: 503, json: { error: "Fixture response lost after edit commit", code: "storage-unavailable" } }); }
      return route.fulfill({ json: result });
    } catch (error) {
      return route.fulfill({ status: error.code === "conflict" ? 409 : error.code === "storage-unavailable" ? 503 : 400, json: { error: error.message, code: error.code } });
    }
  }
  if (url.pathname.startsWith("/api/agent/") && request.method() === "POST") agentRequests++;
  return route.fulfill({ json: {} });
});
const page = await context.newPage();
const card = (p, id = legacy.id) => p.locator(`[data-task-card="${id}"]`);
const form = (p, id = legacy.id) => card(p, id).getByRole("form", { name: "Edit task details", exact: true });
async function begin(p, id = legacy.id) {
  const c = card(p, id); await c.waitFor();
  if (!await c.locator("details").evaluate((details) => details.open)) await c.locator("summary").click();
  await c.getByRole("button", { name: "Edit task details", exact: true }).click();
  await form(p, id).waitFor();
}
async function save(p, id = legacy.id) {
  await form(p, id).getByRole("button", { name: "Save details", exact: true }).click();
}
try {
  await page.goto(`${base}/tasks`); await card(page).waitFor();
  assert.ok((await card(page).innerText()).includes("Priority: Normal"));
  assert.ok((await card(page).innerText()).includes("No project"));
  assert.equal(await card(page).locator("time").getAttribute("datetime"), legacy.updatedAt);
  assert.ok((await card(page, projectTask.id).innerText()).includes(project));
  assert.equal((await page.locator("main").innerText()).includes("chat-workspace"), false);
  cases.push("v1 defaults / project and no-project / precise saved timestamp");

  // Keyboard-only activation, tab traversal and submit. Browser typing drives the actual inputs.
  await card(page).locator("summary").focus(); await page.keyboard.press("Enter");
  await card(page).getByRole("button", { name: "Edit task details", exact: true }).focus(); await page.keyboard.press("Enter");
  await form(page).getByLabel("Title", { exact: true }).waitFor();
  await form(page).getByLabel("Title", { exact: true }).focus();
  await page.keyboard.press("Meta+A"); await page.keyboard.type("Keyboard edited task");
  await page.keyboard.press("Tab"); await page.keyboard.press("Meta+A"); await page.keyboard.type("<img src=x onerror=alert(1)> **plain** /private/secret");
  await page.keyboard.press("Tab"); await page.keyboard.press("Meta+A"); await page.keyboard.type("Tests pass and I confirm");
  await page.keyboard.press("Tab"); await page.keyboard.press("u");
  assert.equal(await form(page).getByLabel("Priority", { exact: true }).inputValue(), "3");
  await page.keyboard.press("Tab"); await page.keyboard.type(" bug \nbug\nBug\na,b");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement.textContent), "Save details");
  await page.keyboard.press("Enter");
  await card(page).locator("summary").filter({ hasText: "Keyboard edited task" }).waitFor();
  const updated = await savedTask();
  assert.equal(updated.title, "Keyboard edited task"); assert.equal(updated.priority, 3); assert.deepEqual(updated.labels, ["bug", "Bug", "a,b"]);
  assert.equal(updated.description, "<img src=x onerror=alert(1)> **plain** /private/secret"); assert.equal(updated.completionCriteria, "Tests pass and I confirm");
  assert.equal(updated.columnId, "todo"); assert.equal(updated.project, null);
  assert.ok(Date.parse(updated.updatedAt) > Date.parse(legacy.updatedAt));
  assert.equal(await card(page).locator("time").getAttribute("datetime"), updated.updatedAt);
  assert.equal(await card(page).locator("img, script, a").count(), 0);
  assert.deepEqual(await card(page).getByRole("list", { name: "Labels", exact: true }).locator("li").allTextContents(), updated.labels);
  await page.reload(); await card(page).locator("summary").filter({ hasText: updated.title }).waitFor();
  await begin(page); assert.equal(await form(page).getByLabel("Description", { exact: true }).inputValue(), updated.description);
  cases.push("keyboard full-field edit / canonical labels / pure text / card and detail persisted after reload");

  const beforeCancel = await readFile(file, "utf8");
  await form(page).getByLabel("Title", { exact: true }).fill("Cancelled title");
  await form(page).getByLabel("Priority", { exact: true }).selectOption("0");
  await form(page).getByRole("button", { name: "Cancel", exact: true }).focus(); await page.keyboard.press("Enter");
  assert.equal(await readFile(file, "utf8"), beforeCancel);
  assert.equal(await card(page).locator("summary").textContent(), updated.title);
  cases.push("cancel makes no persistent change");

  await begin(page);
  await form(page).getByLabel("Title", { exact: true }).fill(" "); await save(page);
  await form(page).getByRole("alert").filter({ hasText: "A task title is required" }).waitFor();
  assert.equal(await readFile(file, "utf8"), beforeCancel);
  await form(page).getByLabel("Title", { exact: true }).fill("Retry title");
  await form(page).getByLabel("Labels", { exact: true }).fill("x".repeat(51)); await save(page);
  await form(page).getByRole("alert").filter({ hasText: "50 characters" }).waitFor();
  assert.equal(await form(page).getByLabel("Labels", { exact: true }).inputValue(), "x".repeat(51));
  assert.equal(await readFile(file, "utf8"), beforeCancel);
  await form(page).getByLabel("Labels", { exact: true }).fill("retry");
  failNext = true; await save(page);
  await form(page).getByRole("alert").filter({ hasText: "Fixture edit storage unavailable" }).waitFor();
  assert.equal(await form(page).getByLabel("Title", { exact: true }).inputValue(), "Retry title");
  assert.equal(await readFile(file, "utf8"), beforeCancel);
  await save(page); await card(page).locator("summary").filter({ hasText: "Retry title" }).waitFor();
  assert.deepEqual((await savedTask()).labels, ["retry"]);
  cases.push("invalid title/label / failed save retains draft and prior content/time / retry succeeds");

  const second = await context.newPage(); await second.goto(`${base}/tasks`); await begin(second);
  await form(second).getByLabel("Title", { exact: true }).fill("Second page draft");
  await begin(page); await form(page).getByLabel("Title", { exact: true }).fill("First page wins"); await save(page);
  await card(page).locator("summary").filter({ hasText: "First page wins" }).waitFor();
  const winner = await savedTask();
  // Focus/online reread should show the saved card but MUST NOT rebase the draft revision.
  await second.evaluate(() => window.dispatchEvent(new Event("online")));
  await card(second).locator("summary").filter({ hasText: "First page wins" }).waitFor();
  assert.equal(await form(second).getByLabel("Title", { exact: true }).inputValue(), "Second page draft");
  await save(second); await form(second).getByRole("alert").filter({ hasText: "changed in another page" }).waitFor();
  assert.deepEqual(await savedTask(), winner);
  await second.getByRole("button", { name: "Refresh", exact: true }).click();
  await second.getByRole("status").filter({ hasText: "Loading" }).waitFor({ state: "hidden" });
  assert.equal(await form(second).getByLabel("Title", { exact: true }).inputValue(), "Second page draft");
  await form(second).getByRole("button", { name: "Cancel", exact: true }).click(); await begin(second);
  assert.equal(await form(second).getByLabel("Title", { exact: true }).inputValue(), "First page wins");
  await form(second).getByLabel("Title", { exact: true }).fill("Conflict resolved"); await save(second);
  await card(second).locator("summary").filter({ hasText: "Conflict resolved" }).waitFor();
  cases.push("two-page conflict rejects stale draft even after online/refresh / explicit cancel+reopen rebases");

  await begin(second); await form(second).getByLabel("Labels", { exact: true }).fill("uncertain");
  loseNext = true; await save(second);
  await form(second).getByRole("alert").filter({ hasText: "response lost after edit commit" }).waitFor();
  const committed = await savedTask(); assert.deepEqual(committed.labels, ["uncertain"]);
  await save(second); await form(second).getByRole("alert").filter({ hasText: "changed in another page" }).waitFor();
  assert.deepEqual(await savedTask(), committed);
  assert.equal(await form(second).getByLabel("Labels", { exact: true }).inputValue(), "uncertain");
  await second.getByRole("button", { name: "Refresh", exact: true }).click();
  await card(second).getByRole("list", { name: "Labels", exact: true }).getByText("uncertain", { exact: true }).waitFor();
  await form(second).getByRole("button", { name: "Cancel", exact: true }).click();
  assert.deepEqual((await taskOperation(legacyCreate, options)).task, committed);
  cases.push("lost edit response is not falsely reported saved / retry conflicts safely / original create retry remains immutable");

  await begin(second); await form(second).getByLabel("Title", { exact: true }).fill("Keep draft across columns");
  const moved = (await taskOperation(await moveRequest({ action: "move", id: legacy.id, columnId: "review", expectedRevision: committed.revision }, options), options)).task;
  await second.evaluate(() => window.dispatchEvent(new Event("online")));
  await second.locator('[data-task-column="review"]').locator(`[data-task-card="${legacy.id}"]`).waitFor();
  assert.equal(await form(second).getByLabel("Title", { exact: true }).inputValue(), "Keep draft across columns");
  await save(second); await form(second).getByRole("alert").filter({ hasText: "changed in another page" }).waitFor();
  assert.deepEqual(await savedTask(), moved);
  await form(second).getByRole("button", { name: "Cancel", exact: true }).click();
  cases.push("external move + refresh preserves draft across column remount and rejects stale edit");

  await page.screenshot({ path: path.join(evidence, "details-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await page.reload();
  await card(page, projectTask.id).locator("summary").tap();
  await card(page, projectTask.id).getByRole("button", { name: "Edit task details", exact: true }).tap();
  const mobile = form(page, projectTask.id);
  await mobile.getByLabel("Title", { exact: true }).tap(); await mobile.getByLabel("Title", { exact: true }).fill("Mobile project task");
  await mobile.getByLabel("Description", { exact: true }).fill("Mobile explanation");
  await mobile.getByLabel("Completion requirements", { exact: true }).fill("Touch save confirmed");
  await mobile.getByLabel("Priority", { exact: true }).selectOption("2");
  await mobile.getByLabel("Labels", { exact: true }).fill("mobile\n触摸");
  assert.equal(await mobile.getByLabel("Title", { exact: true }).evaluate((input) => getComputedStyle(input).fontSize), "16px");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await mobile.getByRole("button", { name: "Save details", exact: true }).tap();
  await card(page, projectTask.id).locator("summary").filter({ hasText: "Mobile project task" }).waitFor();
  const mobileSaved = await savedTask(projectTask.id);
  assert.deepEqual(mobileSaved.project, projectTask.project); assert.equal(mobileSaved.columnId, projectTask.columnId);
  assert.deepEqual(mobileSaved.labels, ["mobile", "触摸"]); assert.equal(mobileSaved.priority, 2);
  await page.reload(); await card(page, projectTask.id).locator("summary").filter({ hasText: mobileSaved.title }).waitFor();
  assert.equal(await card(page, projectTask.id).locator("time").getAttribute("datetime"), mobileSaved.updatedAt);
  await page.screenshot({ path: path.join(evidence, "details-mobile.png"), fullPage: true });
  cases.push("390px touch edit and save / no horizontal overflow / 16px inputs / unchanged project/status / reload");
  assert.equal(agentRequests, 0); assert.deepEqual(errors, []);
  await writeFile(path.join(evidence, "results.json"), JSON.stringify({ cases, agentRequests, errors, agentDir, tasks: (await taskOperation({ action: "list" }, options)).tasks }, null, 2));
  console.log(`PASS ${cases.length} scenarios: ${cases.join("; ")}; evidence=${evidence}; isolatedAgentDir=${agentDir}`);
} catch (error) {
  await page.screenshot({ path: path.join(evidence, "details-failure.png"), fullPage: true });
  await writeFile(path.join(evidence, "failure.json"), JSON.stringify({ error: String(error), cases, errors, agentRequests, agentDir }, null, 2));
  throw error;
} finally { await browser.close(); }
