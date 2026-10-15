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
for (const [index, title] of ["Design the task workspace", "Review keyboard navigation", "Polish mobile layout", "Manage session groups"].entries()) {
  const result = await taskOperation({ action: "create", id: randomUUID(), title, description: "Keep the interface focused. Show details only when they are needed.", completionCriteria: "Keyboard and mobile checks pass", cwd: null }, { agentDir });
  if (index) await taskOperation({ action: "move", id: result.task.id, columnId: ["todo", "in-progress", "review", "done"][index], expectedRevision: result.task.revision, expectedOrderRevision: result.board.orderRevision, operationId: randomUUID(), position: { edge: "end" } }, { agentDir });
}
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
await context.addInitScript(() => { if (!localStorage.getItem("pi-locale")) localStorage.setItem("pi-locale", "en"); });
let agentWrites = 0, boardReads = 0, activityReads = 0;
let failMembership = false, includeSessions = false, failNextLink = false;
let failNextRemoval = false, loseNextRemovalResponse = false;
const relationRequests = [];
const sharedRequests = [];
const initialBoard = await taskOperation({ action: "list" }, { agentDir });
const chatCwd = path.join(root, "chat-workspace");
const linkedSession = { id: randomUUID(), name: "Linked task conversation", cwd: chatCwd, sessionKind: "chat", projectKey: "pi-web:chat", created: new Date().toISOString(), modified: new Date().toISOString(), path: path.join(root, "fixture-session.jsonl"), firstMessage: "", messageCount: 0 };
const otherSession = { ...linkedSession, id: randomUUID(), name: "Second task conversation" };
linkedSession.relationGeneration = 3;
linkedSession.updateRevision = 5;
otherSession.relationGeneration = 2;
otherSession.updateRevision = 4;
// Synthetic session catalogue/membership; task edits/moves/archive use a real isolated store.
const memberships = new Map([[linkedSession.id, initialBoard.tasks[0].id], [otherSession.id, initialBoard.tasks[0].id]]);
const sessionFixtures = [linkedSession, otherSession];
const relationRevisions = new Map();
const touchRelation = id => { if (id) relationRevisions.set(id, (relationRevisions.get(id) ?? 0) + 1); };
const withMembership = board => ({ ...board, tasks: board.tasks.map(task => ({ ...task, revision: task.revision + (relationRevisions.get(task.id) ?? 0), sessionIds: [...memberships].filter(([, owner]) => owner === task.id).map(([id]) => id) })) });
const errors = [];
await context.route("**/api/**", async route => {
  const request = route.request();
  const url = new URL(request.url());
  if (url.pathname === "/api/tasks") {
    if (request.method() === "GET") boardReads++;
    const input = request.method() === "GET" ? { action: "list" } : request.postDataJSON();
    if (input.action === "projects" || input.action === "preview-archive") return route.fulfill({ json: await taskOperation(input, { agentDir }) });
    if (input.action === "sessions") return route.fulfill({ json: {
      linked: sessionFixtures.filter(session => memberships.get(session.id) === input.id),
      candidates: sessionFixtures.filter(session => !memberships.has(session.id)),
    } });
    if (input.action === "session-task") {
      if (failMembership) return route.fulfill({ status: 503, json: { error: "Fixture membership unavailable" } });
      const owner = (await taskOperation({ action: "list" }, { agentDir })).tasks.find(task => task.id === memberships.get(input.sessionId));
      return route.fulfill({ json: { task: owner ? { id: owner.id, title: owner.title, archived: owner.archived } : null } });
    }
    if (input.action === "link" && failNextLink) {
      failNextLink = false;
      return route.fulfill({ status: 409, json: { error: "Fixture link conflict: refresh and choose again", code: "conflict" } });
    }
    if (input.action === "change-session-relation" || input.action === "link") {
      if (input.action === "change-session-relation") {
        relationRequests.push(input);
        assert.equal(input.targetTaskId, null, "inspector menu only removes membership");
        if (failNextRemoval) {
          failNextRemoval = false;
          return route.fulfill({ status: 409, json: { error: "Fixture removal conflict" } });
        }
        const previousOwner = memberships.get(input.sessionId) ?? null;
        if (input.targetTaskId) memberships.set(input.sessionId, input.targetTaskId); else memberships.delete(input.sessionId);
        if (previousOwner !== input.targetTaskId) { touchRelation(previousOwner); touchRelation(input.targetTaskId); }
        if (loseNextRemovalResponse) {
          loseNextRemovalResponse = false;
          return route.fulfill({ status: 503, json: { error: "Fixture removal response lost" } });
        }
      } else for (const id of input.sessionIds) { memberships.set(id, input.id); touchRelation(input.id); }
      const board = withMembership(await taskOperation({ action: "list" }, { agentDir }));
      return route.fulfill({ json: input.action === "link" ? { board, task: board.tasks.find(task => task.id === input.id) } : board });
    }
    if (!new Set(["list", "create", "createFromSession", "edit", "move", "set-archive", "set-columns", "save-view", "remove-column"]).has(input.action)) sharedRequests.push(input.action);
    try {
      const result = await taskOperation(input, { agentDir });
      return route.fulfill({ json: result.board ? { ...result, board: withMembership(result.board) } : withMembership(result) });
    }
    catch (error) { return route.fulfill({ status: 409, json: { error: error.message, code: error.code } }); }
  }
  if (url.pathname.startsWith("/api/agent/") && request.method() === "POST") agentWrites++;
  if (url.pathname === "/api/agent/running") activityReads++;
  if (url.pathname === `/api/sessions/${linkedSession.id}`) return route.fulfill({ json: { info: linkedSession, context: { messages: [], entryIds: [], model: null, thinkingLevel: "off" }, tree: [], activeLeafId: null } });
  const fixtures = {
    "/api/sessions": { sessions: includeSessions ? sessionFixtures : [], runningSessionIds: [] }, "/api/agent/running": { runningSessionIds: [] },
    "/api/default-cwd": { cwd: path.join(root, "chat-workspace"), projectRoot: path.join(root, "chat-workspace"), projectKey: "pi-web:chat", sessionKind: "chat" },
    "/api/home": { home: root }, "/api/models": { models: [], modelList: [], defaultModel: null },
    "/api/web-auth": { enabled: false }, "/api/subagents/settings": { enabled: false },
    "/api/tasks/sessions": { sessions: [] },
    // Report rendering is outside this panel fixture; archive now creates report IDs.
    "/api/task-reports": { reports: [], latestSuccessfulReportId: null },
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
  assert.equal(await inspector.getByRole("combobox", { name: /^Move to:/ }).count(), 0, "details no longer offer state changes");
  await dialog.getByRole("button", { name: "Close task details", exact: true }).click();
  const movingCard = dialog.locator('[data-task-column="todo"]').getByRole("button", { name: "Unsaved task edit", exact: true });
  const from = await movingCard.boundingBox();
  const to = await dialog.locator('[data-task-column="in-progress"]').boundingBox();
  await page.mouse.move(from.x + 8, from.y + 8); await page.mouse.down();
  await page.mouse.move(from.x + 20, from.y + 8); await dialog.locator("[data-task-overlay]").waitFor();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height * .8, { steps: 12 }); await page.mouse.up();
  await dialog.locator('[data-task-column="in-progress"]').getByRole("button", { name: "Unsaved task edit", exact: true }).waitFor();
  assert.equal(await inspector.count(), 0, "cross-status dragging does not reopen details");
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
  assert.equal(await inspector.getByRole("button", { name: "Summarize shared context", exact: true }).count(), 0);
  assert.equal(await inspector.getByRole("button", { name: "Start task", exact: true }).count(), 0);
  assert.equal(await inspector.getByRole("region", { name: "Shared context", exact: true }).count(), 0);
  await inspector.getByRole("heading", { name: "Chats (2)", exact: true }).waitFor();
  assert.equal(await inspector.getByText("Only unassigned chats in this project can be linked. The entire selection is saved together. Linking never starts AI or changes history.", {exact: true}).count(), 0, "linking policy belongs to the expanded link action");
  assert.equal(await inspector.locator("[data-task-activity]").count(), 0, "chat count/activity should not be repeated below task details");
  await inspector.getByRole("link", { name: otherSession.name, exact: true }).waitFor();
  await page.setViewportSize({ width: 1440, height: 960 });
  await inspector.getByRole("link", { name: linkedSession.name, exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.waitForURL(`**/?session=${linkedSession.id}`);
  assert.equal(await page.locator("textarea").first().inputValue(), "", "linked chat is selected, not the previous composer");
  const membership = page.locator("[data-session-task]");
  await membership.getByRole("button", { name: "Task: Unsaved task edit", exact: true }).waitFor();
  await membership.getByRole("button", { name: "Task details", exact: true }).click();
  await inspector.getByRole("heading", { name: "Unsaved task edit", exact: true }).waitFor();
  const linkedRow = inspector.getByRole("list", { name: "Linked chats", exact: true }).locator("li").filter({ has: page.getByRole("link", { name: linkedSession.name, exact: true }) });
  assert.match(await linkedRow.innerText(), /Current chat/);
  const trigger = linkedRow.getByRole("button", { name: "Chat actions", exact: true });
  const menu = inspector.getByRole("menu", { name: "Chat actions", exact: true });
  await trigger.click();
  assert.equal(await trigger.getAttribute("aria-expanded"), "true");
  assert.deepEqual(await menu.getByRole("menuitem").allTextContents(), ["Remove"]);
  assert.equal(relationRequests.length, 0, "opening the menu does not mutate membership");
  await menu.getByRole("menuitem").dispatchEvent("keydown", { key: "Escape", isComposing: true });
  await menu.getByRole("menuitem").dispatchEvent("keydown", { key: "Escape", keyCode: 229 });
  assert.equal(await menu.isVisible(), true, "IME Escape leaves the menu open");
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
  assert.equal(await inspector.isVisible(), true, "Escape dismisses only the menu");
  assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
  await page.keyboard.press("ArrowDown");
  await menu.waitFor();
  assert.equal(await menu.getByRole("menuitem").evaluate(node => node === document.activeElement), true);
  await inspector.getByRole("heading", { name: "Unsaved task edit", exact: true }).click();
  await menu.waitFor({ state: "hidden" });
  assert.equal(relationRequests.length, 0, "outside click does not remove a chat");
  await trigger.click();
  await page.keyboard.press("Tab");
  await menu.waitFor({ state: "hidden" });
  assert.equal(await inspector.evaluate(node => node.contains(document.activeElement)), true, "Tab stays in the inspector");
  await trigger.click();
  await page.mouse.click(3, 3); // Backdrop closes the entire panel, retaining the inspector.
  await dialog.waitFor({ state: "hidden" });
  await opener.click();
  assert.equal(await menu.count(), 0, "hidden panels do not retain an open menu");
  await linkedRow.getByRole("link", { name: linkedSession.name, exact: true }).waitFor();

  // A deleted chat remains removable using its real (nonzero) relation snapshot.
  otherSession.missing = true;
  await inspector.getByRole("button", { name: "Refresh chats", exact: true }).click();
  const otherRow = inspector.getByRole("list", { name: "Linked chats", exact: true }).locator("li").filter({ hasText: otherSession.id });
  await otherRow.waitFor();
  assert.equal(await otherRow.getByRole("link").count(), 0, "a missing chat cannot be opened");
  assert.equal(await otherRow.getByRole("button", { name: "Chat actions", exact: true }).isEnabled(), true, "a missing chat can be removed");
  // A committed removal with a lost response must retry the identical operation, not silently rebase.
  loseNextRemovalResponse = true;
  await otherRow.getByRole("button", { name: "Chat actions", exact: true }).click();
  await menu.getByRole("menuitem", { name: "Remove", exact: true }).click();
  await inspector.getByRole("alert").filter({ hasText: "Fixture removal response lost" }).waitFor();
  await otherRow.getByRole("button", { name: "Chat actions", exact: true }).click();
  await menu.getByRole("menuitem", { name: "Remove", exact: true }).click();
  await otherRow.waitFor({ state: "hidden" });
  assert.deepEqual(relationRequests[1], relationRequests[0], "lost-response retry preserves UUID and CAS");
  assert.equal(relationRequests[0].sessionId, otherSession.id);
  assert.equal(relationRequests[0].expectedGeneration, 2);
  assert.equal(relationRequests[0].expectedUpdateRevision, 4);

  failNextRemoval = true;
  await trigger.click();
  await menu.getByRole("menuitem", { name: "Remove", exact: true }).click();
  await inspector.getByRole("alert").filter({ hasText: "Fixture removal conflict" }).waitFor();
  assert.equal(await linkedRow.isVisible(), true, "failed removal keeps the linked row");
  failNextRemoval = true;
  await trigger.click();
  await menu.getByRole("menuitem", { name: "Remove", exact: true }).click();
  await inspector.getByRole("alert").filter({ hasText: "Fixture removal conflict" }).waitFor();
  assert.deepEqual(relationRequests[3], relationRequests[2], "failure retry preserves UUID and CAS");
  assert.equal(relationRequests[2].expectedGeneration, 3);
  assert.equal(relationRequests[2].expectedUpdateRevision, 5);
  assert.equal(relationRequests[2].sourceTaskId, initialBoard.tasks[0].id);
  // Explicit refresh abandons a stale retry, unlike passive board refresh/focus.
  linkedSession.relationGeneration = 7;
  linkedSession.updateRevision = 9;
  await inspector.getByRole("button", { name: "Refresh chats", exact: true }).click();
  await page.waitForFunction(() => !!document.querySelector('[data-task-inspector]:not([hidden]) button[aria-haspopup="menu"]:not(:disabled)'));
  await trigger.focus();
  await page.keyboard.press("Enter");
  await menu.waitFor();
  await page.keyboard.press("Enter");
  await linkedRow.waitFor({ state: "hidden" });
  assert.notEqual(relationRequests[4].operationId, relationRequests[2].operationId);
  assert.equal(relationRequests[4].expectedGeneration, 7);
  assert.equal(relationRequests[4].expectedUpdateRevision, 9);
  await page.keyboard.press("Escape");
  assert.equal(await dialog.isVisible(), true, "successful removal leaves details open");
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await membership.getByRole("button", { name: "Link to task", exact: true }).waitFor();
  await opener.click();
  await dialog.locator("summary").filter({ hasText: "Current chat" }).click();
  await dialog.getByRole("combobox", { name: "Link to task", exact: true }).selectOption(initialBoard.tasks[1].id);
  failNextLink = true;
  await dialog.getByRole("button", { name: "Link to task", exact: true }).click();
  await dialog.getByRole("alert").filter({ hasText: "Fixture link conflict" }).waitFor();
  await page.waitForTimeout(200);
  assert.equal(await dialog.getByRole("alert").filter({ hasText: "Fixture link conflict" }).isVisible(), true, "mutation failure must not disappear after an automatic refresh");
  await dialog.getByRole("button", { name: "Link to task", exact: true }).click();
  await inspector.getByRole("heading", { name: initialBoard.tasks[1].title, exact: true }).waitFor();
  await inspector.getByRole("button", { name: `Archive: ${initialBoard.tasks[1].title}`, exact: true }).click();
  await inspector.getByRole("button", { name: "Archive task and session families", exact: true }).click();
  await inspector.getByRole("button", { name: `Restore: ${initialBoard.tasks[1].title}`, exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Close task details", exact: true }).click();
  await dialog.getByRole("button", { name: "Close task dashboard", exact: true }).click();
  await membership.getByRole("button", { name: `Task: ${initialBoard.tasks[1].title} · Archived`, exact: true }).waitFor();
  assert.equal(await page.locator('[aria-modal="true"]').count(), 0);
  failMembership = true;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await membership.getByRole("button", { name: "Task membership unavailable · Open task dashboard", exact: true }).waitFor();
  assert.equal(await membership.getByRole("button", { name: "Link to task", exact: true }).count(), 0, "failed read is unknown, not unassigned");
  failMembership = false;
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await membership.getByRole("button", { name: `Task: ${initialBoard.tasks[1].title} · Archived`, exact: true }).waitFor();
  assert.deepEqual(sharedRequests, [], "management UI never requests shared/start/update actions");
  // Simulate another tab creating a task while the retained board is closed.
  const externalTask = (await taskOperation({ action: "create", id: randomUUID(), title: "Created in another tab", description: "", completionCriteria: "", cwd: null }, { agentDir })).task;
  memberships.set(linkedSession.id, externalTask.id);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await membership.getByRole("button", { name: `Task: ${externalTask.title}`, exact: true }).waitFor();
  await membership.getByRole("button", { name: "Task details", exact: true }).click();
  await inspector.getByRole("heading", { name: externalTask.title, exact: true }).waitFor();
  assert.equal(await inspector.getByRole("heading", {name: "Description", exact: true}).count(), 0, "empty optional details should not create placeholder sections");
  assert.equal(await inspector.getByRole("heading", {name: "Completion requirements", exact: true}).count(), 0);
  await dialog.getByRole("button", { name: "Close task details", exact: true }).click();
  await dialog.getByRole("button", { name: "Close task dashboard", exact: true }).click();
  memberships.set(linkedSession.id, initialBoard.tasks[1].id);
  await page.goto(`${base}/tasks`);
  await page.getByRole("dialog", { name: "Task dashboard", exact: true }).waitFor();
  await page.waitForTimeout(400);
  assert.equal(await page.getByRole("dialog", { name: "Task dashboard", exact: true }).isVisible(), true, "legacy panel survives shell normalization");
  // Archived membership opens directly even while the board hides archived tasks.
  includeSessions = true;
  await page.goto(`${base}/?session=${linkedSession.id}&taskStart=retired-preview`);
  const retiredNotice = page.getByText("Task execution preparation is disabled. Reopen a normal conversation or start a new chat before sending. Your draft will not be sent automatically.", { exact: true });
  await retiredNotice.waitFor();
  await page.locator("textarea").first().fill("Keep the stale URL draft");
  await membership.getByRole("button", { name: `Task: ${initialBoard.tasks[1].title} · Archived`, exact: true }).waitFor();
  await membership.getByRole("button", { name: "Task details", exact: true }).click();
  await inspector.getByRole("link", { name: linkedSession.name, exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await retiredNotice.waitFor({ state: "hidden" });
  await page.waitForURL(url => !url.searchParams.has("taskStart"));
  assert.equal(new URL(page.url()).searchParams.has("taskStart"), false);
  assert.equal(await page.locator("textarea").first().inputValue(), "Keep the stale URL draft");
  for (const [locale, dashboardName, taskLabel, archivedLabel, detailsLabel] of [["en", "Task dashboard", "Task", "Archived", "Task details"], ["zh-CN", "任务看板", "所属任务", "已归档", "任务详情"], ["zh-TW", "任務看板", "所屬任務", "已封存", "任務詳情"]]) {
    for (const theme of ["light", "dark"]) {
      await page.evaluate(({ locale, theme }) => { localStorage.setItem("pi-locale", locale); localStorage.setItem("pi-theme", theme); }, { locale, theme });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${base}/?session=${linkedSession.id}`);
      await membership.getByRole("button", { name: `${taskLabel}: ${initialBoard.tasks[1].title} · ${archivedLabel}`, exact: true }).waitFor();
      await membership.getByRole("button", { name: detailsLabel, exact: true }).click();
      const localizedDialog = page.getByRole("dialog", { name: dashboardName, exact: true });
      await localizedDialog.locator("[data-task-inspector]:visible").getByRole("link", { name: linkedSession.name, exact: true }).waitFor();
      assert.equal(await localizedDialog.locator('[data-task-inspector]:visible select option[value="in-progress"]').count(), 0, "no state selector in any locale/theme");
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
      const actionsLabel = locale === "en" ? "Chat actions" : locale === "zh-CN" ? "对话操作" : "對話操作";
      await localizedDialog.locator("[data-task-inspector]:visible").getByRole("button", { name: actionsLabel, exact: true }).click();
      const localizedMenu = localizedDialog.getByRole("menu", { name: actionsLabel, exact: true });
      assert.deepEqual(await localizedMenu.getByRole("menuitem").allTextContents(), [locale === "en" ? "Remove" : "移除"]);
      const menuBox = await localizedMenu.boundingBox();
      assert.ok(menuBox.x >= 0 && menuBox.x + menuBox.width <= 390, "menu fits the mobile viewport");
      await page.screenshot({ path: path.join(root, `${locale}-${theme}-membership.png`) });
      await page.keyboard.press("Escape");
      await localizedMenu.waitFor({ state: "hidden" });
      assert.equal(await localizedDialog.locator("[data-task-inspector]:visible").count(), 1);
    }
  }
  assert.deepEqual(sharedRequests, []);
  assert.equal(agentWrites, 0);
  assert.deepEqual(errors, []);
  console.log(`PASS task management panel: remove-only menu/keyboard/IME/outside/hidden/lost-response retry, default multi-session list, membership/unlink/relink/archive, unknown-read recovery, no shared/agent calls, drafts, Escape/IME/focus, hidden refresh, mobile, three locales/two themes, legacy route. Artifacts: ${root}; activity reads: ${activityReads}`);
} catch (error) {
  await page.screenshot({ path: path.join(root, "failure.png") });
  console.error(`Artifacts: ${root}; page errors: ${JSON.stringify(errors)}`);
  throw error;
} finally { await browser.close(); }
