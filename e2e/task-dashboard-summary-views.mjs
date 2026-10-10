import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { summaryFixture, content } from "../lib/task-summary-fixture.mjs";
const base = process.env.E2E_BASE_URL || "http://127.0.0.1:30142";
const evidence = process.env.E2E_ARTIFACT_DIR || await mkdtemp(join(tmpdir(), "b07v-")); await mkdir(evidence, { recursive: true });
const f = await summaryFixture(); process.env.PI_CODING_AGENT_DIR = f.agentDir;
const other = await f.call({ action: "create", id: randomUUID(), title: "Other task", description: "", completionCriteria: "", cwd: null });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
await context.addInitScript(() => { if (location.protocol.startsWith("http")) localStorage.setItem("pi-locale", "en"); });
const errors = [], unexpected = [], posts = [], cases = []; let activityFailure = false;
context.on("page", (p) => p.on("pageerror", (e) => errors.push(e.message)));
await context.route("**/*", async (route) => {
  const req = route.request(), url = new URL(req.url());
  if (url.origin !== new URL(base).origin) { unexpected.push(url.href); return route.abort(); }
  if (!url.pathname.startsWith("/api/")) return route.continue();
  if (url.pathname === "/api/tasks") {
    const input = req.method() === "GET" ? { action: "list" } : req.postDataJSON(); if (req.method() === "POST") posts.push(input);
    try { return route.fulfill({ json: await f.call(input) }); }
    catch (e) { return route.fulfill({ status: e.code === "conflict" ? 409 : e.code === "invalid-input" ? 400 : 503, json: { error: e.message, code: e.code } }); }
  }
  if (url.pathname === "/api/agent/running" && req.method() === "GET") return route.fulfill(activityFailure ? { status: 503, json: { error: "Fixture activity unavailable" } } : { json: { runningSessionIds: [], sessionActivity: {} } });
  unexpected.push(url.href); return route.fulfill({ json: {} });
});
const page = await context.newPage();
const card = () => page.locator(`[data-task-card="${f.task.id}"]`);
const form = () => card().getByRole("form", { name: "Review shared context", exact: true });
const edit = () => card().getByRole("form", { name: "Edit task details", exact: true });
const controls = () => page.getByRole("region", { name: "Filters and sorting", exact: true });
const panel = () => page.getByRole("region", { name: "Summarize shared context", exact: true });
async function ready() { await page.locator('[data-task-column="todo"]').waitFor(); await page.waitForFunction(() => !document.querySelector("header button")?.disabled); }
async function open() { const details = card().locator("details").first(); if (!await details.evaluate((e) => e.open)) await details.locator("summary").first().click(); }
async function generate() {
  await open(); await card().getByRole("button", { name: "Summarize shared context", exact: true }).click();
  await panel().getByLabel("Summary model (temporary)").waitFor(); await panel().getByRole("status").waitFor({ state: "hidden" });
  await panel().getByRole("checkbox", { name: f.source.getSessionId(), exact: true }).check();
  await panel().getByLabel(`user: ${f.user}`, { exact: true }).waitFor();
  await panel().getByRole("button", { name: "Preview selected input", exact: true }).click();
  await panel().getByRole("button", { name: "Confirm input and generate draft", exact: true }).click();
  await panel().waitFor({ state: "hidden" }); await form().getByLabel("Goal", { exact: true }).waitFor();
}
async function confirm() { await form().getByRole("button", { name: "Preview shared context", exact: true }).click(); await form().getByRole("button", { name: "Confirm and publish version", exact: true }).click(); }
try {
  await page.goto(`${base}/tasks`); await ready(); await open();
  await card().getByRole("button", { name: "Edit task details", exact: true }).click(); await edit().getByLabel("Title", { exact: true }).fill("Unsaved detail alongside AI");
  await generate(); await form().getByLabel("Goal", { exact: true }).fill("Unsaved reviewed AI");
  const request = posts.find((p) => p.action === "summary-generate"); const unchanged = await readFile(f.file);
  await controls().getByLabel("Search task text", { exact: true }).fill("no task matches"); assert.equal(await card().count(), 0);
  await controls().getByRole("button", { name: "Clear filters", exact: true }).click();
  assert.equal(await edit().getByLabel("Title", { exact: true }).inputValue(), "Unsaved detail alongside AI"); assert.equal(await form().getByLabel("Goal", { exact: true }).inputValue(), "Unsaved reviewed AI");
  await controls().getByLabel("Sort tasks", { exact: true }).selectOption("updated");
  await card().getByRole("combobox", { name: "Move to: Summary task", exact: true }).selectOption("review");
  await page.getByRole("status").filter({ hasText: "Task status and position saved" }).waitFor();
  activityFailure = true; await controls().getByLabel("AI work filter", { exact: true }).selectOption("idle");
  await page.evaluate(() => window.dispatchEvent(new Event("online"))); await page.getByRole("status").filter({ hasText: "AI activity unavailable" }).waitFor();
  assert.equal(await card().count(), 0); await controls().getByLabel("AI work filter", { exact: true }).selectOption("all");
  await card().locator("[data-task-activity]").filter({ hasText: "AI activity unknown" }).waitFor();
  assert.equal(await edit().getByLabel("Title", { exact: true }).inputValue(), "Unsaved detail alongside AI"); assert.equal(await form().getByLabel("Goal", { exact: true }).inputValue(), "Unsaved reviewed AI");
  await edit().getByRole("button", { name: "Save details", exact: true }).click(); await edit().getByRole("alert").filter({ hasText: "changed in another page" }).waitFor();
  const attemptedEdit = posts.filter((p) => p.action === "edit").at(-1); assert.equal(attemptedEdit.expectedRevision, 1);
  const winner = await f.call({ action: "publish-context", id: f.task.id, expectedCurrentVersionId: null, operationId: randomUUID(), content: { ...content, goal: "New manual winner" } });
  await page.evaluate(() => window.dispatchEvent(new Event("online"))); await card().getByLabel("Current confirmed version", { exact: true }).getByText("New manual winner", { exact: true }).waitFor();
  await confirm(); await form().getByRole("alert").filter({ hasText: "changed in another page" }).waitFor();
  const publication = posts.filter((p) => p.action === "publish-context").at(-1); assert.equal(publication.expectedCurrentVersionId, request.expectedCurrentVersionId); assert.equal(publication.generationId, request.operationId); assert.equal(publication.id, f.task.id);
  assert.equal((await f.call({ action: "list" })).tasks.find((t) => t.id === f.task.id).sharedContext.currentVersionId, winner.task.sharedContext.currentVersionId);
  assert.deepEqual((await f.call({ action: "list" })).tasks.find((t) => t.id === other.task.id), other.task);
  assert.equal(JSON.parse(unchanged).tasks[0].sharedContext.versions.length, 0); assert.equal(f.captures.length, 1);
  await form().getByText("Unsaved reviewed AI", { exact: true }).waitFor(); await form().getByRole("button", { name: "Cancel", exact: true }).click(); await edit().getByRole("button", { name: "Cancel", exact: true }).click();
  cases.push("02/07 dual fixed-base drafts survive 05 text/idle-unknown filtering, auto-sort and cross-column remount; competing 06 current rejects original AI base without wrong-task publication");
  activityFailure = false; await page.reload(); await ready(); await generate();
  const document = JSON.parse(await readFile(f.file, "utf8")); document.tasks.find((t) => t.id === f.task.id).sessionIds = []; await writeFile(f.file, JSON.stringify(document));
  const bytes = await readFile(f.file); await confirm(); await form().getByRole("alert").filter({ hasText: "does not belong to this task" }).waitFor();
  assert.deepEqual(await readFile(f.file), bytes); await form().getByText("Generated goal", { exact: true }).waitFor();
  assert.deepEqual((await f.call({ action: "list" })).tasks.find((t) => t.id === other.task.id), other.task);
  cases.push("source relationship invalidated after generation rejects 06 confirmation, retains draft and does not publish to another task");
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  await writeFile(join(evidence, "results.json"), JSON.stringify({ cases, posts, errors, unexpected, captures: f.captures.map((c) => ({ model: c.model, context: c.context })) }, null, 2));
  console.log(`PASS ${cases.length} joint summary/view scenarios; evidence=${evidence}`);
} catch (error) { await page.screenshot({ path: join(evidence, "failure.png"), fullPage: true }).catch(() => {}); await writeFile(join(evidence, "failure.json"), JSON.stringify({ error: String(error), cases, errors, unexpected, posts }, null, 2)); throw error; }
finally { await browser.close(); }
