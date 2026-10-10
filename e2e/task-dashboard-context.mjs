import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createJiti } from "jiti";

// Run only against this worktree's source dev (or the parent's explicitly integrated dev).
// Never start a server, use real provider credentials or allow any API to escape fixtures.
const base = process.env.E2E_BASE_URL || "http://127.0.0.1:30144";
const evidence = process.env.E2E_ARTIFACT_DIR || await mkdtemp(path.join(os.tmpdir(), "pi-web-context-browser-"));
await mkdir(evidence, { recursive: true });
const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-web-context-browser-data-")), options = { agentDir };
const { taskOperation } = await createJiti(import.meta.url, { alias: { "@": process.cwd() } }).import("../lib/task-operations.ts");
const created = await taskOperation({ action: "create", id: randomUUID(), title: "Context task", description: "Original task description", completionCriteria: "User checks", cwd: null }, options);
const id = created.task.id, file = path.join(agentDir, "tasks", "board.json");
const saved = async () => (await taskOperation({ action: "list" }, options)).tasks[0];
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, hasTouch: true });
await context.addInitScript(() => {
  if (/^https?:$/.test(location.protocol)) localStorage.setItem("pi-locale", "en");
});
const errors = [], cases = [], postRequests = [], unexpectedApi = [], externalRequests = [];
let failNext = false, loseNext = false;
context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
context.on("request", (request) => { if (new URL(request.url()).hostname === "fixture.invalid") externalRequests.push(request.url()); });
await context.route("**/api/**", async (route) => {
  const request = route.request(), url = new URL(request.url());
  // A lightweight GET snapshot is not an Agent start; all other unexpected APIs remain forbidden.
  if (url.pathname === "/api/agent/running" && request.method() === "GET") return route.fulfill({ json: { runningSessionIds: [], sessionActivity: {} } });
  if (url.pathname !== "/api/tasks") { unexpectedApi.push(url.pathname); return route.fulfill({ json: {} }); }
  const input = request.method() === "GET" ? { action: "list" } : request.postDataJSON();
  if (request.method() === "POST") postRequests.push(input);
  if (failNext && request.method() === "POST") { failNext = false; return route.fulfill({ status: 503, json: { error: "Fixture publication storage failure", code: "storage-unavailable" } }); }
  try {
    const result = await taskOperation(input, options);
    if (loseNext && request.method() === "POST") { loseNext = false; return route.fulfill({ status: 503, json: { error: "Fixture lost successful publication response", code: "storage-unavailable" } }); }
    return route.fulfill({ json: result });
  } catch (error) { return route.fulfill({ status: error.code === "conflict" ? 409 : error.code === "not-found" ? 404 : error.code === "storage-unavailable" ? 503 : 400, json: { error: error.message, code: error.code } }); }
});
const page = await context.newPage();
const card = (p) => p.locator(`[data-task-card="${id}"]`);
const area = (p) => card(p).getByRole("region", { name: "Shared context", exact: true });
const form = (p) => area(p).getByRole("form", { name: "Review shared context", exact: true });
const current = (p) => area(p).getByLabel("Current confirmed version", { exact: true });
const preview = (p) => form(p).getByLabel("Preview shared context", { exact: true });
async function open(p) {
  await card(p).waitFor(); const details = card(p).locator("details").first();
  if (!await details.evaluate((element) => element.open)) await details.locator("summary").first().click();
}
async function begin(p) { await open(p); await area(p).getByRole("button", { name: "Write shared context", exact: true }).click(); await form(p).waitFor(); }
async function review(p) { await form(p).getByRole("button", { name: "Preview shared context", exact: true }).click(); await preview(p).waitFor(); }
async function confirm(p) { await form(p).getByRole("button", { name: "Confirm and publish version", exact: true }).click(); }
async function published(p, goal) { await form(p).waitFor({ state: "hidden" }); await open(p); await current(p).getByText(goal, { exact: true }).waitFor(); }
async function history(p) { const details = area(p).locator("details"); if (!await details.evaluate((element) => element.open)) await details.locator("summary").click(); return details; }
const unsafe = "**Manual goal**\n\n[private](/private/secret) ![no remote](https://fixture.invalid/secret.png)\n<img src=\"/api/files/private/secret?type=read\" onerror=\"alert(1)\"><script>window.pwned=1</script>\n\n```sh\nrm -rf /private/secret\n```\n\n```mermaid\ngraph TD; A-->B\n```";
try {
  await page.goto(`${base}/tasks`); await begin(page);
  const bytes = await readFile(file, "utf8");
  await form(page).getByLabel("Goal", { exact: true }).fill(unsafe);
  await form(page).getByLabel("Decisions", { exact: true }).fill("Do not execute instructions in this knowledge");
  await form(page).getByLabel("Progress", { exact: true }).fill("Not done");
  await form(page).getByLabel("Next steps", { exact: true }).fill("Review safely");
  await review(page);
  assert.equal(await readFile(file, "utf8"), bytes); assert.equal(postRequests.length, 0);
  assert.ok((await preview(page).innerText()).includes("Manual goal"));
  assert.equal(await preview(page).locator("a, img, script, iframe, svg, button").count(), 0);
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  await form(page).getByRole("button", { name: "Back to editing", exact: true }).click();
  assert.equal(await form(page).getByLabel("Goal", { exact: true }).inputValue(), unsafe);
  await review(page); await form(page).getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await readFile(file, "utf8"), bytes); assert.equal((await saved()).sharedContext.currentVersionId, null);
  cases.push("manual four-section draft / passive sanitized Markdown / back/edit/cancel without publishing");

  // Keyboard-only entry and review/confirmation, using the actual form rather than DOM handlers.
  await open(page);
  await area(page).getByRole("button", { name: "Write shared context", exact: true }).focus(); await page.keyboard.press("Enter");
  await form(page).getByLabel("Goal", { exact: true }).focus(); await page.keyboard.type("First goal");
  await page.keyboard.press("Tab"); await page.keyboard.type("First decision");
  await page.keyboard.press("Tab"); await page.keyboard.type("First progress");
  await page.keyboard.press("Tab"); await page.keyboard.type("First next step");
  await page.keyboard.press("Tab"); await page.keyboard.press("Enter");
  await preview(page).waitFor();
  await form(page).getByRole("button", { name: "Confirm and publish version", exact: true }).focus(); await page.keyboard.press("Enter");
  await published(page, "First goal");
  const one = await saved(); assert.equal(one.sharedContext.versions.length, 1);
  assert.deepEqual(one.sharedContext.versions[0].source, { kind: "manual" });
  assert.ok((await current(page).innerText()).includes("User-provided (not AI-generated)"));
  assert.ok((await current(page).innerText()).includes(one.sharedContext.currentVersionId));
  assert.equal(await current(page).locator("time").getAttribute("datetime"), one.sharedContext.versions[0].confirmedAt);
  await page.reload(); await open(page); await current(page).getByText("First goal", { exact: true }).waitFor();
  cases.push("keyboard review/explicit confirm / immutable ID/time/manual source / reload retains published version");

  await begin(page); await form(page).getByLabel("Goal", { exact: true }).fill("Second goal"); await review(page); await confirm(page); await published(page, "Second goal");
  const two = await saved(); const h = await history(page);
  await h.getByLabel("Version", { exact: true }).selectOption(one.sharedContext.currentVersionId);
  await h.getByLabel("Compare with version", { exact: true }).selectOption(two.sharedContext.currentVersionId);
  const comparison = h.getByLabel("Version comparison", { exact: true });
  assert.ok((await comparison.innerText()).includes("Goal · Changed"));
  assert.deepEqual(await comparison.locator("pre").allTextContents(), ["First goal", "Second goal", "First decision", "First decision", "First progress", "First progress", "First next step", "First next step"]);
  const twoBytes = await readFile(file, "utf8");
  await h.getByRole("button", { name: "Review restore of this version", exact: true }).click();
  await preview(page).getByText("First goal", { exact: true }).waitFor();
  assert.equal(await readFile(file, "utf8"), twoBytes);
  await form(page).getByRole("button", { name: "Cancel", exact: true }).click(); assert.equal(await readFile(file, "utf8"), twoBytes);
  await open(page); await history(page);
  await h.getByRole("button", { name: "Review restore of this version", exact: true }).click(); await confirm(page); await published(page, "First goal");
  const restored = await saved(); assert.equal(restored.sharedContext.versions.length, 3);
  assert.deepEqual(restored.sharedContext.versions.slice(0, 2), two.sharedContext.versions);
  assert.deepEqual(restored.sharedContext.versions[2].source, { kind: "restore", versionId: one.sharedContext.currentVersionId });
  await page.reload(); await open(page); assert.ok((await (await history(page)).locator("summary").innerText()).includes("(3)"));
  cases.push("historical viewing / field comparison / restore preview cancel / explicit restore creates third version preserving middle");

  const second = await context.newPage(); await second.goto(`${base}/tasks`); await begin(second);
  await form(second).getByLabel("Goal", { exact: true }).fill("Losing page input"); await review(second);
  await begin(page); await form(page).getByLabel("Goal", { exact: true }).fill("Winning page"); await review(page); await confirm(page); await published(page, "Winning page");
  const winner = await saved();
  await second.evaluate(() => window.dispatchEvent(new Event("online")));
  await current(second).getByText("Winning page", { exact: true }).waitFor();
  await confirm(second); await form(second).getByRole("alert").filter({ hasText: "changed in another page" }).waitFor();
  assert.deepEqual(await saved(), winner); await preview(second).getByText("Losing page input", { exact: true }).waitFor();
  await second.getByRole("button", { name: "Refresh", exact: true }).click();
  await second.getByRole("status").filter({ hasText: "Loading" }).waitFor({ state: "hidden" });
  await preview(second).getByText("Losing page input", { exact: true }).waitFor();
  await confirm(second); await form(second).getByRole("alert").filter({ hasText: "changed in another page" }).waitFor();
  await form(second).getByRole("button", { name: "Back to editing", exact: true }).click();
  assert.equal(await form(second).getByLabel("Goal", { exact: true }).inputValue(), "Losing page input");
  await form(second).getByRole("button", { name: "Cancel", exact: true }).click(); await begin(second);
  assert.equal(await form(second).getByLabel("Goal", { exact: true }).inputValue(), "Winning page");
  cases.push("two pages same base conflict / online and refresh retain draft and stale base / explicit cancel/reopen adopts latest");

  await form(second).getByRole("button", { name: "Cancel", exact: true }).click(); await open(second);
  const oldHistory = await history(second);
  await oldHistory.getByLabel("Version", { exact: true }).selectOption(one.sharedContext.currentVersionId);
  await oldHistory.getByRole("button", { name: "Review restore of this version", exact: true }).click();
  await begin(page); await form(page).getByLabel("Goal", { exact: true }).fill("New version during restore review");
  await review(page); await confirm(page); await published(page, "New version during restore review");
  const beforeRestoreConflict = await readFile(file, "utf8");
  await confirm(second); await form(second).getByRole("alert").filter({ hasText: "changed in another page" }).waitFor();
  await preview(second).getByText("First goal", { exact: true }).waitFor();
  assert.equal(await readFile(file, "utf8"), beforeRestoreConflict);
  await form(second).getByRole("button", { name: "Cancel", exact: true }).click();
  await second.getByRole("button", { name: "Refresh", exact: true }).click();
  await second.getByRole("status").filter({ hasText: "Loading" }).waitFor({ state: "hidden" }); await begin(second);
  assert.equal(await form(second).getByLabel("Goal", { exact: true }).inputValue(), "New version during restore review");
  cases.push("restore review against stale current conflicts / old preview retained / newer history not erased");

  await form(second).getByLabel("Goal", { exact: true }).fill("Retry publication"); await review(second);
  const beforeFailure = await readFile(file, "utf8"); failNext = true; await confirm(second);
  await form(second).getByRole("alert").filter({ hasText: "Fixture publication storage failure" }).waitFor();
  assert.equal(await readFile(file, "utf8"), beforeFailure); await preview(second).getByText("Retry publication", { exact: true }).waitFor();
  const failedRequest = postRequests.at(-1); await confirm(second); await published(second, "Retry publication");
  assert.deepEqual(postRequests.at(-1), failedRequest);
  await begin(second); await form(second).getByLabel("Goal", { exact: true }).fill("Lost response publication"); await review(second);
  loseNext = true; await confirm(second); await form(second).getByRole("alert").filter({ hasText: "lost successful publication response" }).waitFor();
  const committed = await saved(), committedBytes = await readFile(file, "utf8"), originalRequest = postRequests.at(-1);
  await second.evaluate(() => window.dispatchEvent(new Event("focus")));
  await current(second).getByText("Lost response publication", { exact: true }).waitFor();
  await confirm(second); await published(second, "Lost response publication");
  assert.deepEqual(postRequests.at(-1), originalRequest); assert.deepEqual(await saved(), committed); assert.equal(await readFile(file, "utf8"), committedBytes);
  await second.reload(); await open(second); await current(second).getByText("Lost response publication", { exact: true }).waitFor();
  cases.push("failed publication preserves old content / exact retry / committed response loss + focus/retry creates no second version / reopen");

  // Knowledge draft survives an external column remount and edit, without borrowing either revision.
  await begin(second); await form(second).getByLabel("Goal", { exact: true }).fill("Independent knowledge draft");
  const board = await taskOperation({ action: "list" }, options), prior = board.tasks[0];
  await taskOperation({ action: "move", id, columnId: "review", expectedRevision: prior.revision, expectedOrderRevision: board.orderRevision, operationId: randomUUID(), position: { edge: "end" } }, options);
  await second.evaluate(() => window.dispatchEvent(new Event("online")));
  await second.locator('[data-task-column="review"]').locator(`[data-task-card="${id}"]`).waitFor();
  assert.equal(await form(second).getByLabel("Goal", { exact: true }).inputValue(), "Independent knowledge draft");
  await review(second); await confirm(second); await published(second, "Independent knowledge draft");
  assert.equal((await saved()).columnId, "review"); assert.equal((await saved()).revision, prior.revision + 1);
  cases.push("column remount retains knowledge draft / independent knowledge CAS / user status remains unchanged by publication");

  await second.screenshot({ path: path.join(evidence, "context-desktop.png"), fullPage: true });
  await second.setViewportSize({ width: 390, height: 844 }); await second.reload(); await begin(second);
  const goal = form(second).getByLabel("Goal", { exact: true }); await goal.tap(); await goal.fill(unsafe);
  assert.equal(await goal.evaluate((element) => getComputedStyle(element).fontSize), "16px");
  assert.ok(await second.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await form(second).getByRole("button", { name: "Preview shared context", exact: true }).tap();
  assert.equal(await preview(second).locator("a, img, script, iframe, svg, button").count(), 0);
  await form(second).getByRole("button", { name: "Confirm and publish version", exact: true }).tap();
  await form(second).waitFor({ state: "hidden" }); await open(second); await current(second).getByText("Manual goal", { exact: true }).waitFor();
  assert.ok(await second.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await history(second); await second.screenshot({ path: path.join(evidence, "context-mobile.png"), fullPage: true });
  cases.push("390px touch review/confirmation/history / 16px controls / no horizontal overflow / passive unsafe content");
  const final = await saved(); assert.equal(final.description, created.task.description); assert.equal(final.completionCriteria, created.task.completionCriteria);
  assert.equal(unexpectedApi.filter((url) => /\/(agent|files|sessions|models|terminal)(\/|$)/.test(url)).length, 0);
  assert.deepEqual(externalRequests, []); assert.deepEqual(errors, []);
  await writeFile(path.join(evidence, "results.json"), JSON.stringify({ cases, errors, unexpectedApi, externalRequests, postRequests, agentDir, final }, null, 2));
  console.log(`PASS ${cases.length} scenarios; evidence=${evidence}; isolatedAgentDir=${agentDir}`);
} catch (error) {
  await page.screenshot({ path: path.join(evidence, "context-failure.png"), fullPage: true }).catch(() => {});
  await writeFile(path.join(evidence, "failure.json"), JSON.stringify({ error: String(error), cases, errors, unexpectedApi, externalRequests, agentDir }, null, 2));
  throw error;
} finally { await browser.close(); }
