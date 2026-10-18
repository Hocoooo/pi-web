import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createJiti } from "jiti";

// UI acceptance, not provider/backend integration: real isolated store for ordinary
// task operations; synthetic session/summary/start responses; no network API escapes.
const base = process.env.E2E_BASE_URL || "http://127.0.0.1:30142";
const root = await mkdtemp(path.join(os.tmpdir(), "task-ui-"));
const jiti = createJiti(import.meta.url);
const { taskOperation } = await jiti.import("../lib/task-operations.ts");
const { enLocale } = await jiti.import("../lib/i18n/messages/en.ts");
const t = key => enLocale.messages[key];
const browser = await chromium.launch();
const report = [];
let smokeBoard;
const errors = [];
const seedContent = { goal: "## Goal\n\nKeep the task board simple.\n\n- [x] passive checklist\n- [ ] next check\n\n[passive link](https://example.invalid)\n![passive image](https://example.invalid/image.png)", decisions: "| Choice | Reason |\n| --- | --- |\n| Compact | Less clutter |", progress: "```js\nconst result = '" + "x".repeat(220) + "';\n```", nextSteps: "Review rendering" };
async function runScenario(name, viewport, colorScheme = "light") {
  const dir = path.join(root, name); await mkdir(dir);
  const options = { agentDir: path.join(dir, "agent") };
  await mkdir(options.agentDir);
  const create = async title => (await taskOperation({ action: "create", id: randomUUID(), title, description: "Description with a long path /" + "project/".repeat(25), completionCriteria: "The user confirms the result", cwd: null }, options)).task;
  const first = await create("Dashboard polish");
  const other = await create("Review alternative");
  const long = await create("LongTitle".repeat(20));
  await taskOperation({ action: "edit", id: first.id, expectedRevision: first.revision, title: first.title, description: first.description, completionCriteria: first.completionCriteria, priority: 0, labels: ["design", "frontend", "accessibility", "LongLabel".repeat(5)] }, options);
  await taskOperation({ action: "publish-context", id: first.id, expectedCurrentVersionId: null, operationId: randomUUID(), content: seedContent }, options);
  await taskOperation({ action: "set-archive", id: long.id, expectedArchiveRevision: long.archiveRevision, archived: true, operationId: randomUUID() }, options);
  const chat = { sessionKind: "chat", projectKey: "pi-web:chat", path: "fixture.jsonl", created: new Date().toISOString(), modified: new Date().toISOString(), messageCount: 0, firstMessage: "", id: randomUUID(), name: "Conversation".repeat(18), cwd: path.join(dir, "chat"), missing: false, relationGeneration: 0, updateRevision: 0 };
  const candidate = { ...chat, id: randomUUID(), name: "Available conversation" };
  const missing = { ...chat, id: randomUUID(), name: "Missing conversation", missing: true };
  const linked = new Map([[first.id, [chat.id, missing.id]]]);
  const projection = board => ({ ...board, tasks: board.tasks.map(task => ({ ...task, sessionIds: linked.get(task.id) ?? [] })) });
  let failAction = null, activityFailure = false, readFailure = false, summaryFailure = false, summaryDelay = null;
  let agentWrites = 0, summaryGenerations = 0;
  const context = await browser.newContext({ viewport, colorScheme, isMobile: viewport.width < 600, hasTouch: viewport.width < 600 });
  await context.addInitScript(theme => { localStorage.setItem("pi-locale", "en"); localStorage.setItem("pi-theme", theme); }, colorScheme);
  await context.route("**/api/**", async route => {
    const request = route.request(); const url = new URL(request.url());
    if (url.pathname.startsWith("/api/agent/") && request.method() === "POST") agentWrites++;
    if (url.pathname === "/api/tasks") {
      const input = request.method() === "GET" ? { action: "list" } : request.postDataJSON();
      if (input.action === "list" && readFailure) return route.fulfill({ status: 503, json: { error: "UI fixture read failure" } });
      if (input.action === failAction) { failAction = null; const uncertain = ["move", "set-archive"].includes(input.action); return route.fulfill({ status: uncertain ? 503 : 409, json: { error: "UI fixture failure — draft kept", code: uncertain ? "storage-unavailable" : "conflict" } }); }
      const board = () => taskOperation({ action: "list" }, options);
      if (input.action === "createFromSession") return route.fulfill({ status: 409, json: { error: "UI fixture: this chat already belongs to a task", code: "conflict" } });
      if (input.action === "sessions") return route.fulfill({ json: { linked: (linked.get(input.id) ?? []).map(id => [chat, candidate, missing].find(s => s.id === id)), candidates: (linked.get(input.id) ?? []).includes(candidate.id) ? [] : [candidate] } });
      if (input.action === "link") {
        linked.set(input.id, [...new Set([...(linked.get(input.id) ?? []), ...input.sessionIds])]);
        const result = projection(await board()); return route.fulfill({ json: { task: result.tasks.find(task => task.id === input.id), board: result } });
      }
      if (input.action === "change-session-relation") {
        linked.set(input.sourceTaskId, (linked.get(input.sourceTaskId) ?? []).filter(id => id !== input.sessionId));
        if (input.targetTaskId) linked.set(input.targetTaskId, [...(linked.get(input.targetTaskId) ?? []), input.sessionId]);
        return route.fulfill({ json: projection(await board()) });
      }
      if (input.action === "summary-options") return route.fulfill({ json: { sessions: [chat, missing], models: [{ provider: "fixture", modelId: "ui-only" }], defaultModel: { provider: "fixture", modelId: "ui-only" } } });
      if (input.action === "summary-source") return route.fulfill({ json: { snapshotId: randomUUID(), sessionId: input.sessionId, leafId: input.leafId ?? "leaf-one", branches: ["leaf-one", "leaf-two"], items: [{ entryId: "user-one", role: "user", text: "User material " + "longtext".repeat(30) }, { entryId: "assistant-one", role: "assistant", text: "Decisions and progress" }, { entryId: "tool-one", role: "toolResult", text: "Tool output is opt-in" }] } });
      if (input.action === "summary-generate") {
        summaryGenerations++;
        if (summaryDelay) await summaryDelay;
        if (summaryFailure) return route.fulfill({ status: 503, json: { error: "UI fixture generation unavailable" } });
        const generationId = randomUUID();
        return route.fulfill({ json: { generationId, content: { ...seedContent, goal: "Generated draft for review" }, source: { kind: "ai", generationId, generatedAt: new Date().toISOString(), model: input.model, responseModel: "ui-only", inputHash: "fixture", sources: [{ sessionId: chat.id, leafId: "leaf-one", entryIds: ["user-one", "assistant-one"], toolEntryIds: [] }] } } });
      }
      if (input.action === "summary-cancel") return route.fulfill({ json: { cancelled: true } });
      if (input.action === "prepare-start") {
        const task = (await board()).tasks.find(task => task.id === input.id);
        return route.fulfill({ json: { selection: { taskId: task.id, taskRevision: task.revision, currentVersionId: task.sharedContext.currentVersionId, operationId: input.operationId, sessionId: input.sessionId, mode: input.sessionId ? "continue" : "new" }, cwd: chat.cwd, snapshot: { taskId: task.id, title: task.title, description: task.description, completionCriteria: task.completionCriteria, version: task.sharedContext.versions.at(-1) ?? null }, sameCwdBusy: [chat.id], ...(input.sessionId ? { inheritedFromSessionId: chat.id } : {}) } });
      }
      try {
        // UI-only generated publishing: provider provenance validation belongs to
        // summary integration tests, not this synthetic rendering fixture.
        if (input.action === "publish-context") delete input.generationId;
        const result = await taskOperation(input, options);
        return route.fulfill({ json: result.board ? { ...result, board: projection(result.board), task: { ...result.task, sessionIds: linked.get(result.task.id) ?? [] } } : projection(result) });
      } catch (error) { return route.fulfill({ status: 409, json: { error: error.message, code: error.code } }); }
    }
    if (url.pathname === "/api/agent/running" && activityFailure) return route.fulfill({ status: 503, json: { error: "UI fixture activity unavailable" } });
    if (url.pathname === `/api/sessions/${chat.id}`) return route.fulfill({ json: { info: chat, context: { messages: [], entryIds: [], model: null, thinkingLevel: "off" }, tree: [], activeLeafId: null } });
    const fixtures = {
      "/api/agent/running": { runningSessionIds: [chat.id], sessionActivity: { [chat.id]: { waitingForInput: true } } },
      "/api/sessions": { sessions: [chat], runningSessionIds: [] }, "/api/home": { home: dir },
      "/api/default-cwd": { cwd: chat.cwd, projectRoot: chat.cwd, projectKey: "pi-web:chat", sessionKind: "chat" },
      "/api/models": { models: [], modelList: [], defaultModel: null }, "/api/web-auth": { enabled: false },
      "/api/subagents/settings": { enabled: false }, "/api/cwd/browse": { path: dir, parentPath: null, directories: [] },
    };
    return route.fulfill({ json: fixtures[url.pathname] ?? {} });
  });
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(`${name}: ${error.message}`));
  const dialog = page.getByRole("dialog", { name: t("tasks.dashboard"), exact: true });
  const inspector = dialog.locator("[data-task-inspector]:visible");
  const button = (scope, key) => scope.getByRole("button", { name: t(key), exact: true });
  const label = (scope, key) => scope.getByLabel(t(key), { exact: true });
  const region = key => dialog.getByRole("region", { name: t(key), exact: true });
  const openTask = async title => { await dialog.getByRole("button", { name: title, exact: true }).click(); await inspector.waitFor(); };
  const closeTask = async () => button(inspector, "tasks.panel.closeDetails").click();
  const showChats = async () => { const control = inspector.getByRole("button", { name: /^Chats \(/ }); if (await control.getAttribute("aria-expanded") !== "true") await control.click(); };
  const checkLayout = async () => {
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "document must not overflow horizontally");
    const violations = await dialog.locator('form, fieldset, [data-task-inspector], section[aria-label]').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length && !node.closest('[hidden], details:not([open])')).flatMap(node => {
      const rect = node.getBoundingClientRect();
      return rect.width > innerWidth || rect.x < -1 || rect.right > innerWidth + 1 || node.scrollWidth > node.clientWidth + 2 ? [{ element: node.tagName, label: node.getAttribute("aria-label"), x: rect.x, width: rect.width, client: node.clientWidth, scroll: node.scrollWidth }] : [];
    }));
    assert.deepEqual(violations, [], "only the board/code/table may scroll horizontally");
  };
  async function step(title, fn) {
    try { await fn(); await checkLayout(); await page.screenshot({ path: path.join(dir, `${String(report.filter(r => r.viewport === name).length + 1).padStart(2, "0")}-${title}.png`) }); report.push({ viewport: name, case: title, result: "pass" }); }
    catch (error) { report.push({ viewport: name, case: title, result: "fail", error: String(error) }); throw error; }
  }
  try {
    await page.goto(`${base}/tasks`); await dialog.waitFor(); await dialog.locator("[data-task-card]").first().waitFor();
    await page.addStyleTag({ content: "nextjs-portal { display:none !important }" });
    await step("board", async () => { assert.equal(await dialog.locator("[data-task-card]").count(), 2); });
    await step("drag-move-cancel", async () => {
      const handle = dialog.getByRole("button", { name: `${t("tasks.dragHandle")}: ${first.title}`, exact: true });
      async function drag(to) {
        await handle.scrollIntoViewIfNeeded(); const box = await handle.boundingBox();
        const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        if (viewport.width < 600) {
          const cdp = await context.newCDPSession(page);
          await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [from] }); await page.waitForTimeout(300);
          for (let n = 1; n <= 12; n++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x + (to.x - from.x) * n / 12, y: from.y + (to.y - from.y) * n / 12 }] }); await page.waitForTimeout(20); }
          await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await cdp.detach();
        } else { await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 12 }); await page.mouse.up(); }
        await page.waitForTimeout(150); // dnd-kit suppresses the release click briefly.
      }
      const target = await dialog.locator('[data-task-column="in-progress"]').boundingBox();
      await drag({ x: Math.min(target.x + 25, viewport.width - 25), y: target.y + 80 });
      await page.waitForFunction(id => document.querySelector(`[data-task-column="in-progress"] [data-task-card="${id}"]`), first.id);
      await drag({ x: viewport.width / 2, y: 85 });
      assert.equal((await taskOperation({ action: "list" }, options)).tasks.find(task => task.id === first.id).columnId, "in-progress", "drop on toolbar is cancelled");
      await openTask(first.title); await inspector.getByLabel(`${t("tasks.moveTo")}: ${first.title}`, { exact: true }).selectOption("todo"); await closeTask();
    });
    await step("simple-filters", async () => {
      await button(dialog, "tasks.view.controls").click();
      const filters = region("tasks.view.controls");
      assert.equal(await filters.getByRole("checkbox").count(), 0, "advanced filters collapsed");
      assert.equal(await filters.getByRole("combobox").count(), 2);
      await label(filters, "tasks.view.text").fill("Dashboard");
      assert.equal(await dialog.locator("[data-task-card]").count(), 1);
    });
    await step("advanced-filters", async () => {
      const filters = region("tasks.view.controls");
      await filters.locator("summary").click();
      await filters.getByRole("checkbox", { name: t("tasks.column.todo"), exact: true }).check();
      await filters.getByRole("checkbox", { name: "design", exact: true }).check();
      await filters.locator("summary").click();
      await filters.getByRole("button", { name: /Remove filter:.*design/ }).click();
      assert.equal(await filters.getByRole("button", { name: /Remove filter:/ }).count(), 2);
      await filters.locator("summary").click();
    });
    await step("saved-view-error-retry", async () => {
      const filters = region("tasks.view.controls");
      await button(filters, "tasks.view.save").click();
      await label(filters, "tasks.view.name").fill("Focused view");
      failAction = "save-view";
      await button(filters, "tasks.view.confirm").click();
      await filters.getByRole("alert").waitFor();
      assert.equal(await label(filters, "tasks.view.name").inputValue(), "Focused view");
      await button(filters, "tasks.view.confirm").click();
      await label(filters, "tasks.view.saved").waitFor();
      await button(filters, "tasks.view.clear").click();
      await label(filters, "tasks.view.saved").selectOption({ label: "Focused view" });
      assert.equal(await label(filters, "tasks.view.text").inputValue(), "Dashboard");
      await button(filters, "tasks.view.save").click(); await label(filters, "tasks.view.name").fill("Same conditions, different name");
      await button(filters, "tasks.view.confirm").click();
      await label(filters, "tasks.view.saved").selectOption({ label: "Focused view" });
      await label(filters, "tasks.view.saved").selectOption({ label: "Same conditions, different name" });
      assert.equal(await label(filters, "tasks.view.saved").locator("option:checked").textContent(), "Same conditions, different name");
      await button(filters, "tasks.view.save").click(); await button(filters, "sidebar.cancel").click();
      assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)), true, "local saved-view Cancel retains modal focus immediately");
    });
    await step("filter-empty-sort", async () => {
      const filters = region("tasks.view.controls");
      await label(filters, "tasks.view.text").fill("no-matching-task");
      await dialog.getByText(t("tasks.view.empty"), { exact: true }).waitFor();
      await button(filters, "tasks.view.clear").click();
      await label(filters, "tasks.view.sort").selectOption("priority");
      await openTask(first.title);
      assert.equal(await inspector.getByRole("button", { name: `${t("tasks.moveUp")}: ${first.title}`, exact: true }).isDisabled(), true);
      await closeTask();
      await button(filters, "tasks.view.clear").click(); await button(dialog, "tasks.view.controls").click();
    });
    await step("create-error-retry", async () => {
      await button(dialog, "tasks.new").click(); await label(dialog, "tasks.title").fill("New UI task");
      await label(dialog, "tasks.description").fill("UI only, no model");
      failAction = "create"; await button(dialog, "tasks.create").click(); await dialog.getByRole("alert").waitFor();
      assert.equal(await label(dialog, "tasks.title").inputValue(), "New UI task");
      await button(dialog, "tasks.create").click(); await dialog.getByRole("button", { name: "New UI task", exact: true }).waitFor();
    });
    await step("edit-draft-error", async () => {
      await openTask(first.title); await button(inspector, "tasks.edit").click();
      await label(inspector, "tasks.description").fill("Edited description");
      failAction = "edit"; await button(inspector, "tasks.save").click(); await inspector.getByRole("alert").waitFor();
      assert.equal(await label(inspector, "tasks.description").inputValue(), "Edited description");
      await button(inspector, "tasks.save").click(); await inspector.getByText("Edited description", { exact: true }).waitFor();
    });
    await step("move-failure-visible", async () => {
      failAction = "move"; await inspector.getByLabel(`${t("tasks.moveTo")}: ${first.title}`, { exact: true }).selectOption("in-progress");
      await inspector.getByRole("alert").waitFor(); await button(inspector, "tasks.retryMove").click();
      await page.waitForFunction(id => document.querySelector(`[data-task-column="in-progress"] [data-task-card="${id}"]`), first.id);
      assert.equal(await inspector.count(), 1, "moving cannot unmount an open inspector");
    });
    await step("archive-failure-restore", async () => {
      failAction = "set-archive";
      await inspector.getByRole("button", { name: `${t("tasks.archive.archive")}: ${first.title}`, exact: true }).click();
      await inspector.getByRole("alert").waitFor(); await button(inspector, "tasks.archive.retry").click();
      await inspector.getByRole("button", { name: `${t("tasks.archive.restore")}: ${first.title}`, exact: true }).waitFor();
      assert.equal(await button(inspector, "tasks.start").isDisabled(), true);
      await inspector.getByRole("button", { name: `${t("tasks.archive.restore")}: ${first.title}`, exact: true }).click();
      await closeTask(); await label(dialog, "tasks.archive.list").click();
      await dialog.getByRole("option", { name: t("tasks.archive.all"), exact: true }).click();
      await dialog.locator(`[data-task-card="${long.id}"]`).getByText(t("tasks.archive.archived"), { exact: true }).waitFor();
      await label(dialog, "tasks.archive.list").click();
      await dialog.getByRole("option", { name: t("tasks.archive.active"), exact: true }).click();
    });
    await step("context-current-passive-markdown", async () => {
      await openTask(first.title);
      const shared = inspector.getByRole("region", { name: t("tasks.context.title"), exact: true });
      assert.equal(await shared.locator('a[href], img[src]').count(), 0);
      const boxes = await shared.locator('input[type="checkbox"]').evaluateAll(nodes => nodes.map(node => ({ width: node.getBoundingClientRect().width, padding: getComputedStyle(node).padding })));
      assert.ok(boxes.every(box => box.width <= 22 && box.padding === "0px"), JSON.stringify(boxes));
    });
    await step("context-edit-preview-conflict", async () => {
      await button(inspector, "tasks.context.edit").click();
      await label(inspector, "tasks.context.goal").fill("Second confirmed goal");
      await button(inspector, "tasks.context.preview").click(); await button(inspector, "tasks.context.back").click();
      assert.equal(await label(inspector, "tasks.context.goal").inputValue(), "Second confirmed goal");
      await button(inspector, "tasks.context.preview").click(); failAction = "publish-context";
      await button(inspector, "tasks.context.confirm").click(); await inspector.getByRole("alert").waitFor();
      await button(inspector, "tasks.context.confirm").click();
      await inspector.getByText("Second confirmed goal", { exact: true }).waitFor();
    });
    await step("context-history-compare-restore", async () => {
      await inspector.locator("summary").filter({ hasText: t("tasks.context.history") }).click();
      const versions = await label(inspector, "tasks.context.version").locator("option").evaluateAll(nodes => nodes.map(node => node.value));
      await label(inspector, "tasks.context.version").selectOption(versions[0]);
      await label(inspector, "tasks.context.compare").selectOption(versions[1]);
      await inspector.getByLabel(t("tasks.context.comparison"), { exact: true }).waitFor();
      await button(inspector, "tasks.context.restore").click(); await button(inspector, "sidebar.cancel").click();
      await button(inspector, "tasks.context.restore").click(); await button(inspector, "tasks.context.confirm").click();
      assert.equal((await taskOperation({ action: "list" }, options)).tasks.find(task => task.id === first.id).sharedContext.versions.length, 3);
    });
    await step("sessions-missing-link-stale", async () => {
      await showChats();
      await inspector.getByText(t("tasks.sessionMissing"), { exact: false }).waitFor();
      await inspector.getByRole("checkbox", { name: /Available conversation/ }).check();
      await closeTask(); await openTask(first.title); await showChats();
      assert.equal(await inspector.getByRole("checkbox", { name: /Available conversation/ }).isChecked(), true, "closing details preserves unsent chat selection");
      await inspector.getByRole("button", { name: /^Link selected chats/ }).click();
      await button(inspector, "tasks.refreshSessions").click();
      await inspector.getByRole("link", { name: candidate.name, exact: true }).waitFor();
      activityFailure = true; await page.evaluate(() => dispatchEvent(new Event("online")));
      await inspector.getByText(t("tasks.activityUnknown"), { exact: false }).first().waitFor();
      assert.equal(await inspector.getByText(t("tasks.waitingInput"), { exact: false }).count(), 0);
      activityFailure = false;
    });
    await step("relation-ime-error-cancel", async () => {
      await button(inspector, "tasks.relation.title").first().click();
      const relation = region("tasks.relation.title");
      await label(relation, "tasks.relation.target").selectOption(other.id);
      await label(relation, "tasks.relation.target").dispatchEvent("keydown", { key: "Escape", keyCode: 229 });
      assert.equal(await relation.isVisible(), true);
      failAction = "change-session-relation"; await button(relation, "tasks.relation.confirm").click(); await relation.getByRole("alert").waitFor();
      await button(relation, "sidebar.cancel").click();
      assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)), true, "cancel must not leave focus behind the modal");
    });
    await step("relation-reassign-unlink", async () => {
      await openTask(first.title); await showChats();
      await button(inspector, "tasks.relation.title").last().click();
      await label(region("tasks.relation.title"), "tasks.relation.target").selectOption(other.id);
      await button(region("tasks.relation.title"), "tasks.relation.confirm").click();
      await region("tasks.relation.title").waitFor({ state: "hidden" });
      assert.deepEqual(linked.get(other.id), [candidate.id]);
      await openTask(other.title); await showChats();
      await button(inspector, "tasks.relation.title").click();
      await button(region("tasks.relation.title"), "tasks.relation.confirm").click();
      await region("tasks.relation.title").waitFor({ state: "hidden" });
      assert.deepEqual(linked.get(other.id), []);
    });
    await step("start-new-continue-risk", async () => {
      await openTask(first.title); await button(inspector, "tasks.start").click();
      await button(inspector, "tasks.startPreview").click(); await inspector.getByText(t("tasks.startCwdRisk"), { exact: true }).waitFor();
      await button(inspector, "tasks.startReview").click(); await label(inspector, "tasks.startTarget").selectOption(chat.id);
      await button(inspector, "tasks.startPreview").click(); await inspector.getByText(t("tasks.startKeepVersion"), { exact: true }).waitFor();
      await closeTask(); await openTask(first.title);
      await inspector.getByText(t("tasks.startKeepVersion"), { exact: true }).waitFor();
      await inspector.getByRole("region", { name: t("tasks.start"), exact: true }).getByRole("button", { name: t("sidebar.cancel"), exact: true }).click();
      assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)), true, "local Start Cancel retains modal focus immediately");
    });
    await step("summary-source-review-ime", async () => {
      await button(inspector, "tasks.summary.title").click(); const summary = region("tasks.summary.title");
      await summary.getByRole("checkbox", { name: chat.name, exact: true }).check();
      assert.equal(await summary.getByRole("checkbox", { name: /toolResult/ }).isChecked(), false);
      await summary.getByLabel(`user: user-one`, { exact: true }).fill("Redacted source");
      await summary.getByLabel(`user: user-one`, { exact: true }).dispatchEvent("keydown", { key: "Escape", keyCode: 229 });
      assert.equal(await summary.isVisible(), true);
      await button(summary, "tasks.summary.preview").click();
      assert.equal(await summary.getByText("Redacted source", { exact: true }).isVisible(), true);
      summaryFailure = true; await button(summary, "tasks.summary.generate").click(); await summary.getByRole("alert").waitFor();
      await page.evaluate(() => new Promise(requestAnimationFrame));
      assert.equal(await summary.getByRole("alert").evaluate(node => { const r = node.getBoundingClientRect(); return node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }), true, "generation failure must be on screen, not above a long scrolled source list");
    });
    await step("summary-result-outside-filter", async () => {
      const summary = region("tasks.summary.title"); summaryFailure = false;
      await button(dialog, "tasks.view.controls").click(); await label(region("tasks.view.controls"), "tasks.view.text").fill("Review alternative");
      await button(summary, "tasks.summary.generate").click();
      await label(inspector, "tasks.context.goal").waitFor();
      assert.equal(await label(inspector, "tasks.context.goal").inputValue(), "Generated draft for review");
      assert.equal(await dialog.locator(`[data-task-card="${first.id}"]`).count(), 0, "review independent of filter projection");
      assert.equal(await button(inspector, "tasks.summary.title").isDisabled(), true);
      await inspector.getByRole("form", { name: t("tasks.context.review"), exact: true }).getByRole("button", { name: t("sidebar.cancel"), exact: true }).click();
      await closeTask(); await button(region("tasks.view.controls"), "tasks.view.clear").click(); await button(dialog, "tasks.view.controls").click();
    });
    await step("summary-cancel-late-response", async () => {
      await openTask(first.title); await button(inspector, "tasks.summary.title").click();
      const summary = region("tasks.summary.title");
      await summary.getByRole("checkbox", { name: chat.name, exact: true }).check();
      await button(summary, "tasks.summary.preview").click();
      let finish; summaryDelay = new Promise(resolve => { finish = resolve; });
      await button(summary, "tasks.summary.generate").click();
      await summary.getByRole("status").waitFor();
      await button(summary, "sidebar.cancel").click(); finish(); summaryDelay = null;
      await page.waitForTimeout(150);
      assert.equal(await inspector.count(), 0, "cancelled generation cannot open a late review");
      assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)), true);
    });
    await step("hidden-summary-completion-focus", async () => {
      await openTask(first.title); await button(inspector, "tasks.summary.title").click();
      const summary = region("tasks.summary.title");
      await summary.getByRole("checkbox", { name: chat.name, exact: true }).check();
      await button(summary, "tasks.summary.preview").click();
      let finish; summaryDelay = new Promise(resolve => { finish = resolve; });
      await button(summary, "tasks.summary.generate").click(); await summary.getByRole("status").waitFor();
      await button(dialog, "tasks.panel.close").click();
      const composer = page.locator("textarea:visible").first(); await composer.fill("Chat while summary runs");
      finish(); summaryDelay = null; await page.waitForTimeout(150);
      assert.equal(await composer.evaluate(node => node === document.activeElement), true, "hidden result cannot steal chat focus");
      const opener = page.getByRole("button", { name: t("tasks.dashboard"), exact: true });
      const openerBox = await opener.boundingBox();
      if (!openerBox || openerBox.x < 0 || openerBox.x >= viewport.width) await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
      await opener.click(); await label(inspector, "tasks.context.goal").waitFor();
      assert.equal(await label(inspector, "tasks.context.goal").inputValue(), "Generated draft for review");
      await label(inspector, "tasks.context.goal").focus(); await closeTask();
      assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)), true, "closing hidden-born inspector cannot restore focus behind modal");
      await openTask(first.title);
      await inspector.getByRole("form", { name: t("tasks.context.review"), exact: true }).getByRole("button", { name: t("sidebar.cancel"), exact: true }).click(); await closeTask();
    });
    await step("column-edit-add-reorder", async () => {
      await button(dialog, "tasks.columnsSettings").click(); const columns = dialog.getByRole("form", { name: t("tasks.columnsSettings"), exact: true });
      await button(columns, "tasks.addColumn").click(); await columns.locator("[data-column-setting]").last().locator("input").fill("Later");
      await columns.getByRole("button", { name: `${t("tasks.columnUp")}: Later`, exact: true }).click();
      await button(columns, "tasks.saveColumns").click(); await columns.waitFor({ state: "hidden" });
      await dialog.locator("[data-task-column] h2").filter({ hasText: "Later" }).waitFor();
    });
    await step("column-removal-completion-consent", async () => {
      await button(dialog, "tasks.columnsSettings").click(); const columns = dialog.getByRole("form", { name: t("tasks.columnsSettings"), exact: true });
      await columns.getByRole("button", { name: `${t("tasks.removeColumn")}: ${t("tasks.column.todo")}`, exact: true }).click();
      await label(columns, "tasks.receivingColumn").selectOption("done");
      assert.equal(await button(columns, "tasks.confirmRemoval").isDisabled(), true);
      const consent = columns.getByRole("checkbox", { name: t("tasks.confirmCompletion"), exact: true });
      assert.equal(await consent.locator("..").evaluate(node => getComputedStyle(node).display), "flex");
      await consent.check(); failAction = "remove-column"; await button(columns, "tasks.confirmRemoval").click(); await columns.getByRole("alert").waitFor();
      await button(columns, "tasks.retryRemoval").click(); await columns.waitFor({ state: "hidden" });
      assert.equal(await dialog.locator('[data-task-column="todo"]').count(), 0);
    });
    await step("unavailable-saved-view", async () => {
      await button(dialog, "tasks.view.controls").click(); const filters = region("tasks.view.controls");
      await label(filters, "tasks.view.saved").selectOption({ label: "Focused view" });
      await dialog.getByText(t("tasks.view.invalid"), { exact: true }).waitFor();
      if (await filters.locator("details").getAttribute("open") === null) await filters.locator("summary").click();
      await filters.getByRole("checkbox", { name: `${t("tasks.view.unavailable")}: todo`, exact: true }).waitFor();
    });
    await step("read-error-refresh", async () => {
      await button(region("tasks.view.controls"), "tasks.view.clear").click(); await button(dialog, "tasks.view.controls").click();
      readFailure = true; await button(dialog, "tasks.refresh").click(); await dialog.getByRole("alert").waitFor();
      readFailure = false; await dialog.getByRole("alert").getByRole("button", { name: t("tasks.refresh"), exact: true }).click();
      await dialog.getByRole("alert").waitFor({ state: "hidden" });
    });
    await step("current-chat-draft-guard", async () => {
      await page.goto(`${base}/?session=${chat.id}&tasks=1`); await dialog.waitFor();
      await page.addStyleTag({ content: "nextjs-portal { display:none !important }" });
      await openTask(first.title); await button(inspector, "tasks.context.edit").click();
      await label(inspector, "tasks.context.goal").fill("Do not replace my manual draft"); await closeTask();
      await dialog.locator("summary").filter({ hasText: t("tasks.panel.currentChat") }).click();
      await button(dialog, "tasks.summary.title").click();
      assert.equal(await label(inspector, "tasks.context.goal").inputValue(), "Do not replace my manual draft");
      assert.equal(await region("tasks.summary.title").count(), 0);
      await inspector.getByRole("form", { name: t("tasks.context.review"), exact: true }).getByRole("button", { name: t("sidebar.cancel"), exact: true }).click(); await closeTask();
    });
    await step("source-chat-create-form", async () => {
      await dialog.locator("summary").filter({ hasText: t("tasks.panel.currentChat") }).click();
      await button(dialog, "tasks.createFromChat").click();
      assert.equal(await label(dialog, "tasks.projectDirectory").count(), 0, "source chat owns project");
      await label(dialog, "tasks.title").fill("Source task"); await button(dialog, "tasks.create").click();
      await dialog.getByRole("alert").waitFor(); await button(dialog, "sidebar.cancel").click();
    });
    assert.equal(agentWrites, 0, "all UI actions must leave Agent untouched");
    assert.equal(summaryGenerations, 4, "only explicit synthetic generations");
    smokeBoard = projection(await taskOperation({ action: "list" }, options));
  } catch (error) { await page.screenshot({ path: path.join(dir, "FAILURE.png"), fullPage: true }); throw error; }
  finally { await context.close(); }
}
async function renderMatrix() {
  const { zhCNLocale } = await jiti.import("../lib/i18n/messages/zh-CN.ts");
  const { zhTWLocale } = await jiti.import("../lib/i18n/messages/zh-TW.ts");
  const configs = [
    ["small-320-zh", { width: 320, height: 740 }, zhCNLocale, "dark"],
    ["small-360-tw", { width: 360, height: 780 }, zhTWLocale, "light"],
    ["tablet-en", { width: 768, height: 1024 }, enLocale, "light"],
    ["landscape-zh", { width: 844, height: 390 }, zhCNLocale, "dark"],
    ["desktop-tw", { width: 1280, height: 800 }, zhTWLocale, "dark"],
    ["empty-board", { width: 390, height: 844 }, enLocale, "light"],
  ];
  for (const [name, viewport, locale, theme] of configs) {
    const dir = path.join(root, name); await mkdir(dir);
    const messages = locale.messages;
    const empty = name === "empty-board";
    const renderBoard = empty ? { ...smokeBoard, tasks: [], savedViews: [] } : smokeBoard;
    const context = await browser.newContext({ viewport, colorScheme: theme });
    await context.addInitScript(({ locale, theme }) => { localStorage.setItem("pi-locale", locale); localStorage.setItem("pi-theme", theme); }, { locale: locale.id, theme });
    await context.route("**/api/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/tasks") {
        const input = route.request().method() === "GET" ? { action: "list" } : route.request().postDataJSON();
        if (input.action === "summary-options") return route.fulfill({ json: { sessions: [], models: [], defaultModel: null } });
        assert.equal(input.action, "list", "render-only matrix cannot mutate");
        return route.fulfill({ json: renderBoard });
      }
      const fixtures = { "/api/sessions": { sessions: [], runningSessionIds: [] }, "/api/agent/running": { runningSessionIds: [] }, "/api/default-cwd": { cwd: dir, projectRoot: dir, projectKey: "pi-web:chat", sessionKind: "chat" }, "/api/home": { home: dir }, "/api/models": { models: [], modelList: [], defaultModel: null }, "/api/web-auth": { enabled: false } };
      return route.fulfill({ json: fixtures[url.pathname] ?? {} });
    });
    const page = await context.newPage(); page.on("pageerror", error => errors.push(`${name}: ${error.message}`));
    const dialog = page.getByRole("dialog", { name: messages["tasks.dashboard"], exact: true });
    const b = (scope, key) => scope.getByRole("button", { name: messages[key], exact: true });
    async function snap(caseName) {
      const overflow = await dialog.locator('form, fieldset, [data-task-inspector], section[aria-label]').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length && !node.closest('[hidden], details:not([open])')).flatMap(node => {
        const r = node.getBoundingClientRect(); return r.x < -1 || r.right > innerWidth + 1 || node.scrollWidth > node.clientWidth + 2 ? [`${node.tagName}:${node.getAttribute("aria-label")}:${node.scrollWidth}/${node.clientWidth}`] : [];
      }));
      assert.deepEqual(overflow, [], `${name}/${caseName} layout`);
      const unnamed = await dialog.getByRole("button").evaluateAll(nodes => nodes.filter(node => !node.getAttribute("aria-label") && !node.getAttribute("title") && !node.textContent.trim()).length);
      assert.equal(unnamed, 0, "controls need accessible names");
      await page.screenshot({ path: path.join(dir, `${caseName}.png`) });
      report.push({ viewport: name, case: caseName, result: "pass" });
    }
    try {
      await page.goto(`${base}/tasks`); await dialog.locator("[data-task-column]").first().waitFor();
      await page.addStyleTag({ content: "nextjs-portal { display:none !important }" });
      await snap("board");
      await b(dialog, "tasks.view.controls").click(); await snap("simple-filters");
      const filters = dialog.getByRole("region", { name: messages["tasks.view.controls"], exact: true });
      await filters.locator("summary").click();
      if (empty) await filters.getByText(messages["tasks.view.noLabels"], { exact: true }).waitFor();
      await snap("advanced-filters");
      await b(dialog, "tasks.view.controls").click();
      await b(dialog, "tasks.new").click(); await snap("create"); await b(dialog, "sidebar.cancel").click();
      await b(dialog, "tasks.columnsSettings").click(); await snap("columns"); await b(dialog, "sidebar.cancel").click();
      if (empty) continue;
      await dialog.getByRole("button", { name: "Dashboard polish", exact: true }).click();
      const inspector = dialog.locator("[data-task-inspector]:visible"); await snap("details");
      await b(inspector, "tasks.context.edit").click();
      const closeBox = await b(inspector, "tasks.panel.closeDetails").boundingBox();
      const panelBox = await inspector.boundingBox();
      assert.ok(closeBox.y >= panelBox.y && closeBox.y + closeBox.height <= panelBox.y + panelBox.height, "detail close control remains visible while editing/scrolled");
      const headerBox = await inspector.locator("header").boundingBox();
      assert.ok(Math.abs(headerBox.y - panelBox.y) <= 1, "sticky header must cover the top edge, not expose scrolled text above it");
      await snap("context-edit");
      await b(inspector, "tasks.context.preview").click(); await snap("context-preview");
      await b(inspector, "sidebar.cancel").click();
      await b(inspector, "tasks.summary.title").click();
      const summary = dialog.getByRole("region", { name: messages["tasks.summary.title"], exact: true });
      await summary.getByRole("combobox").waitFor();
      assert.equal(await b(summary, "tasks.summary.preview").isDisabled(), true);
      await snap("summary-no-models");
      await b(summary, "sidebar.cancel").click();
      assert.equal(await dialog.evaluate(node => node.contains(document.activeElement)), true);
      await b(dialog, "tasks.panel.close").click();
      assert.equal(await page.locator('[aria-modal="true"]').count(), 0);
    } catch (error) {
      report.push({ viewport: name, case: "render-matrix", result: "fail", error: String(error) });
      await page.screenshot({ path: path.join(dir, "FAILURE.png"), fullPage: true }); throw error;
    } finally { await context.close(); }
  }
}
try {
  await runScenario("desktop-light", { width: 1440, height: 960 });
  await runScenario("phone-dark", { width: 390, height: 844 }, "dark");
  await renderMatrix();
  assert.deepEqual(errors, []);
  console.log(`PASS ${report.length} task UI workflow checks; artifacts=${root}`);
} finally {
  await writeFile(path.join(root, "report.json"), JSON.stringify({ report, errors }, null, 2));
  console.log(`UI report: ${root}/report.json`);
  await browser.close();
}
