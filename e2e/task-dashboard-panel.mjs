import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createJiti } from "jiti";

// Reuse an existing dev server; all APIs intercepted, no real agent/model/session writes.
const base = process.env.E2E_BASE_URL || "http://127.0.0.1:30142";
const root = await mkdtemp(path.join(os.tmpdir(), "task-panel-"));
const agentDir = path.join(root, "agent");
await mkdir(agentDir);
const { taskOperation } = await createJiti(import.meta.url).import("../lib/task-operations.ts");
for (const [index, title] of ["Design the task workspace", "Review keyboard navigation", "Polish mobile layout", "Verify shared context"].entries()) {
  const result = await taskOperation({ action: "create", id: randomUUID(), title, description: "Keep the interface focused. Show details only when they are needed.", completionCriteria: "Keyboard and mobile checks pass", cwd: null }, { agentDir });
  if (index) await taskOperation({ action: "move", id: result.task.id, columnId: ["todo", "in-progress", "review", "done"][index], expectedRevision: result.task.revision, expectedOrderRevision: result.board.orderRevision, operationId: randomUUID(), position: { edge: "end" } }, { agentDir });
}
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
await context.addInitScript(() => localStorage.setItem("pi-locale", "en"));
let agentWrites = 0, boardReads = 0, activityReads = 0;
const chatCwd = path.join(root, "chat-workspace");
const linkedSession = { id: randomUUID(), name: "Linked task conversation", cwd: chatCwd, sessionKind: "chat", projectKey: "pi-web:chat", timestamp: new Date().toISOString(), messageCount: 0 };
const errors = [];
await context.route("**/api/**", async route => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname === "/api/tasks") {
    if (request.method() === "GET") boardReads++;
    const input = request.method() === "GET" ? { action: "list" } : request.postDataJSON();
    if (input.action === "sessions") return route.fulfill({ json: { linked: [linkedSession], candidates: [] } });
    if (input.action === "prepare-start") {
      const task = (await taskOperation({ action: "list" }, { agentDir })).tasks.find(task => task.id === input.id);
      return route.fulfill({ json: { selection: { taskId: task.id, taskRevision: task.revision, currentVersionId: null, operationId: input.operationId, sessionId: input.sessionId, mode: input.sessionId ? "continue" : "new" }, snapshot: { taskId: task.id, title: task.title, description: task.description, completionCriteria: task.completionCriteria, version: null }, cwd: chatCwd, sameCwdBusy: [] } });
    }
    try { return route.fulfill({ json: await taskOperation(input, { agentDir }) }); }
    catch (error) { return route.fulfill({ status: 409, json: { error: error.message, code: error.code } }); }
  }
  if (url.pathname.startsWith("/api/agent/") && request.method() === "POST") agentWrites++;
  if (url.pathname === "/api/agent/running") activityReads++;
  if (url.pathname === `/api/sessions/${linkedSession.id}`) return route.fulfill({ json: { info: linkedSession, context: { messages: [], entryIds: [], model: null, thinkingLevel: "off" }, tree: [], activeLeafId: null } });
  const fixtures = {
    "/api/sessions": { sessions: [], runningSessionIds: [] }, "/api/agent/running": { runningSessionIds: [] },
    "/api/default-cwd": { cwd: path.join(root, "chat-workspace"), projectRoot: path.join(root, "chat-workspace"), projectKey: "pi-web:chat", sessionKind: "chat" },
    "/api/home": { home: root }, "/api/models": { models: [], modelList: [], defaultModel: null },
    "/api/web-auth": { enabled: false }, "/api/subagents/settings": { enabled: false },
    "/api/tasks/sessions": { sessions: [] },
    "/api/cwd/browse": { path: root, parentPath: null, directories: [] },
  };
  return route.fulfill({ json: fixtures[url.pathname] ?? {} });
});
const page = await context.newPage();
page.on("pageerror", error => errors.push(error.message));
try {
  await page.goto(`${base}/`);
  const opener = page.getByRole("button", { name: "Task dashboard", exact: true });
  await opener.waitFor();
  const composer = page.locator("textarea").first();
  await composer.fill("Keep my chat draft");
  await page.waitForURL("**/?chat=1");
  const url = page.url();
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "Task dashboard", exact: true });
  await dialog.waitFor();
  await dialog.locator("[data-task-card]").first().waitFor();
  assert.equal(page.url(), url, "opening does not navigate");
  assert.equal(await composer.inputValue(), "Keep my chat draft");
  assert.equal(await dialog.getByLabel("Search task text").isVisible(), false); // filters hidden in accessibility tree
  assert.equal(await dialog.locator("[data-task-inspector]:visible").count(), 0);
  await page.screenshot({ path: path.join(root, "desktop.png") });
  await dialog.getByRole("button", { name: "Design the task workspace", exact: true }).click();
  const inspector = dialog.locator("[data-task-inspector]:visible");
  await inspector.getByRole("button", { name: "Edit task details", exact: true }).click();
  await inspector.getByLabel("Title", { exact: true }).fill("Unsaved task edit");
  await page.keyboard.press("Escape");
  assert.equal(await inspector.count(), 0, "first Escape closes details only");
  assert.equal(await dialog.count(), 1);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await opener.evaluate(node => node === document.activeElement), true, "focus returns to opener");
  const reads = boardReads;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForTimeout(100);
  assert.equal(boardReads, reads, "hidden board does not refresh");
  await opener.click();
  await dialog.getByRole("button", { name: "Design the task workspace", exact: true }).click();
  assert.equal(await inspector.getByLabel("Title", { exact: true }).inputValue(), "Unsaved task edit");
  await inspector.getByRole("button", { name: "Save details", exact: true }).click();
  await inspector.getByRole("heading", { name: "Unsaved task edit", exact: true }).waitFor();
  await page.screenshot({ path: path.join(root, "details.png") });
  await inspector.getByLabel("Move to: Unsaved task edit", { exact: true }).selectOption("in-progress");
  await dialog.locator('[data-task-column="in-progress"]').getByRole("button", { name: "Unsaved task edit", exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Close task details", exact: true }).click();
  await dialog.getByRole("button", { name: "New task", exact: true }).click();
  await dialog.getByLabel("Title", { exact: true }).fill("Draft survives close");
  await dialog.getByRole("button", { name: "Choose project…", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Select directory", exact: true });
  await picker.waitFor();
  assert.equal(await picker.evaluate(node => { const r = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(r.width / 2, r.height / 2)); }), true, "directory picker above task panel");
  await page.keyboard.press("Escape");
  await picker.waitFor({ state: "hidden" });
  assert.equal(await dialog.isVisible(), true, "picker Escape does not close board");
  await dialog.getByRole("button", { name: "Close task dashboard", exact: true }).click();
  await opener.click();
  assert.equal(await dialog.getByLabel("Title", { exact: true }).inputValue(), "Draft survives close");
  // IME Escape must not dismiss the board.
  await dialog.getByLabel("Title", { exact: true }).dispatchEvent("keydown", { key: "Escape", isComposing: true });
  assert.equal(await dialog.isVisible(), true);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await dialog.getByRole("button", { name: "Close task dashboard", exact: true }).focus();
  // Focus wraps inside the panel, never into the chat composer.
  await page.keyboard.press("Shift+Tab");
  assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)), true);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(root, "mobile.png") });
  await dialog.getByRole("button", { name: "Unsaved task edit", exact: true }).click();
  await inspector.getByRole("heading", { name: "Unsaved task edit" }).waitFor();
  const box = await inspector.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390);
  await page.screenshot({ path: path.join(root, "mobile-details.png") });
  await inspector.getByRole("button", { name: "Summarize shared context", exact: true }).click();
  assert.equal(await inspector.count(), 0, "summary is not covered by inspector on mobile");
  await dialog.getByRole("region", { name: "Summarize shared context", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 960 });
  await dialog.getByRole("button", { name: "Unsaved task edit", exact: true }).click();
  await inspector.getByRole("button", { name: "Start task", exact: true }).click();
  await inspector.getByRole("button", { name: "Preview task material", exact: true }).click();
  await inspector.getByRole("button", { name: "Open chat — do not send yet", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.waitForURL("**/*taskStart=*");
  await page.getByText("Preparation does not call a model. Review this source material, then send your own message in chat. Existing drafts are not replaced.", { exact: true }).filter({ visible: true }).waitFor();
  assert.equal(await page.locator("textarea").first().inputValue(), "Keep my chat draft", "prepared target retains composer text");
  assert.equal(await page.locator('[aria-modal="true"]').count(), 0, "hidden panel cannot suppress global shortcuts");
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.waitForURL("**/?chat=1");
  assert.equal(await page.getByText("Preparation does not call a model. Review this source material, then send your own message in chat. Existing drafts are not replaced.", { exact: true }).filter({ visible: true }).count(), 0, "ordinary New does not inherit preparation");
  await opener.click();
  await dialog.getByRole("button", { name: "Unsaved task edit", exact: true }).click();
  await inspector.getByRole("button", { name: "Chats (0)", exact: true }).click();
  await inspector.getByRole("link", { name: linkedSession.name, exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.waitForURL(`**/?session=${linkedSession.id}`);
  assert.equal(await page.locator("textarea").first().inputValue(), "", "linked chat is selected, not the old prepared composer");
  await page.goto(`${base}/tasks`);
  await page.getByRole("dialog", { name: "Task dashboard", exact: true }).waitFor();
  await page.waitForTimeout(400);
  assert.equal(await page.getByRole("dialog", { name: "Task dashboard", exact: true }).isVisible(), true, "legacy panel survives shell normalization");
  assert.equal(agentWrites, 0);
  assert.deepEqual(errors, []);
  console.log(`PASS task panel: no navigation/agent calls, compact board, detail edit/move, chat/task/create draft retention, Escape/IME/focus, hidden refresh, mobile, legacy route. Artifacts: ${root}; activity reads: ${activityReads}`);
} catch (error) {
  await page.screenshot({ path: path.join(root, "failure.png") });
  console.error(`Artifacts: ${root}; page errors: ${JSON.stringify(errors)}`);
  throw error;
} finally { await browser.close(); }
