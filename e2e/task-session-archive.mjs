import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createJiti } from "jiti";

// Browser/API fixture only: reuse the dev service, never mutate user sessions or send Agent commands.
const base = process.env.E2E_BASE_URL || "http://127.0.0.1:30142";
const root = await mkdtemp(path.join(os.tmpdir(), "task-session-archive-ui-"));
const agentDir = path.join(root, "agent");
await mkdir(agentDir);
const { taskOperation } = await createJiti(import.meta.url).import("../lib/task-operations.ts");
await taskOperation({ action: "create", id: randomUUID(), title: "Archive fixture task", description: "", completionCriteria: "", cwd: null }, { agentDir });
await taskOperation({ action: "create", id: randomUUID(), title: "Another fixture task", description: "", completionCriteria: "", cwd: null }, { agentDir });
let board = await taskOperation({ action: "list" }, { agentDir });
const linkedId = randomUUID(), rootId = randomUUID(), childId = randomUUID();
board.tasks[0].sessionIds = [linkedId];
const skipped = ["missing", "unpersisted", "unsupported-id", "unresolved-family"].map(reason => ({ sessionId: randomUUID(), reason }));
let crossTask = true, mode = "success", holdPreview = false, releasePreview;
let previewReads = 0, agentWrites = 0, failPreview = false;
const writes = [], errors = [];
const archivedRoots = new Set();
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
await context.addInitScript(() => { if (!localStorage.getItem("pi-locale")) localStorage.setItem("pi-locale", "en"); });
await context.route("**/api/**", async route => {
  const request = route.request(), url = new URL(request.url());
  if (url.pathname === "/api/tasks") {
    const input = request.method() === "GET" ? { action: "list" } : request.postDataJSON();
    if (input.action === "list") return route.fulfill({ json: board });
    if (input.action === "sessions") return route.fulfill({ json: { linked: [], candidates: [] } });
    if (input.action === "session-task") return route.fulfill({ json: { task: null } });
    if (input.action === "preview-archive") {
      previewReads++;
      if (failPreview) { failPreview = false; return route.fulfill({ status: 503, json: { error: "Preview metadata unavailable" } }); }
      const preview = { taskId: input.id, archiveRevision: board.tasks.find(task => task.id === input.id).archiveRevision,
        token: `frozen-preview-${previewReads}`, linkedSessionIds: [linkedId], skipped,
        families: [{ rootSessionId: rootId, name: "Shared family root", sessionIds: [rootId, linkedId, childId],
          otherTasks: crossTask ? [{ id: board.tasks[1].id, title: "Cross-task affected title with long wrapping text", sessionIds: [childId] }] : [] }] };
      if (holdPreview) { holdPreview = false; await new Promise(resolve => { releasePreview = resolve; }); }
      return route.fulfill({ json: preview });
    }
    assert.equal(input.action, "set-archive", "no unrelated task writes");
    writes.push(input);
    const task = board.tasks.find(item => item.id === input.id);
    if (mode === "conflict") { mode = "success"; return route.fulfill({ status: 409, json: { error: "Preview changed; cancel and review again", code: "conflict" } }); }
    if (input.archived && ["pending", "pending-ok"].includes(mode)) {
      const pendingOK = mode === "pending-ok";
      mode = "success";
      task.archived = true; task.archiveRevision++;
      task.pendingSessionArchive = { operationId: input.operationId, expectedArchiveRevision: input.expectedArchiveRevision, ...input.cascade };
      if (pendingOK) return route.fulfill({ json: { task, board } });
      return route.fulfill({ status: 503, json: { error: "Session batch not confirmed" } });
    }
    if (task.archived !== input.archived) { task.archived = input.archived; task.archiveRevision++; }
    delete task.pendingSessionArchive;
    if (input.cascade) archivedRoots.add(rootId);
    const result = { task, board, ...(input.cascade ? { sessionArchive: { rootSessionIds: [rootId], skipped } } : {}) };
    if (mode === "lost") { mode = "success"; return route.abort("failed"); }
    return route.fulfill({ json: result });
  }
  if (url.pathname.startsWith("/api/agent/") && request.method() === "POST") agentWrites++;
  assert.ok(request.method() === "GET" || ["/api/default-cwd", "/api/cwd/validate"].includes(url.pathname), `unexpected write ${request.method()} ${url.pathname}`);
  const fixtures = {
    "/api/sessions": { sessions: [], runningSessionIds: [] }, "/api/agent/running": { runningSessionIds: [] },
    "/api/default-cwd": { cwd: path.join(root, "chat"), projectRoot: path.join(root, "chat"), projectKey: "pi-web:chat", sessionKind: "chat" },
    "/api/home": { home: root }, "/api/models": { models: [], modelList: [], defaultModel: null },
    "/api/web-auth": { enabled: false }, "/api/subagents/settings": { enabled: false },
  };
  return route.fulfill({ json: fixtures[url.pathname] ?? {} });
});
const page = await context.newPage();
page.on("pageerror", error => errors.push(error.message));
const dialog = page.getByRole("dialog", { name: "Task dashboard", exact: true });
const inspector = page.locator("[data-task-inspector]:visible");
const review = inspector.locator("[data-task-archive-preview]");
const archive = inspector.getByRole("button", { name: "Archive: Archive fixture task", exact: true });
const confirm = review.getByRole("button", { name: "Archive task and session families", exact: true });
const consent = review.getByRole("checkbox");
async function openTask() {
  await page.getByRole("button", { name: "Task dashboard", exact: true }).click();
  await dialog.getByRole("combobox", { name: "Task list", exact: true }).click();
  await dialog.getByRole("option", { name: "All tasks", exact: true }).click();
  await dialog.getByRole("button", { name: "Archive fixture task", exact: true }).click();
}
async function openReview() { await archive.click(); await review.getByText("Shared family root", { exact: true }).waitFor(); }
async function restore() {
  await inspector.getByRole("button", { name: "Restore: Archive fixture task", exact: true }).click();
  await inspector.getByRole("status").filter({ hasText: "Task restored; session archives" }).waitFor();
  assert.equal(writes.at(-1).archived, false);
  assert.equal(Object.hasOwn(writes.at(-1), "cascade"), false, "restore never cascades");
}
try {
  await page.goto(`${base}/`);
  const composer = page.locator("textarea").first();
  await composer.fill("Archive must preserve my composer draft");
  await page.waitForURL("**/?chat=1");
  const url = page.url();
  await openTask();
  // Preserve parked task edits too.
  await inspector.getByRole("button", { name: "Edit task details", exact: true }).click();
  await inspector.getByLabel("Title", { exact: true }).fill("Unsaved archive draft");
  await openReview();
  assert.equal(writes.length, 0, "preview is read-only");
  assert.equal(await confirm.isEnabled(), false, "cross-task consent is mandatory");
  await consent.dispatchEvent("keydown", { key: "Escape", isComposing: true });
  await consent.dispatchEvent("keydown", { key: "Escape", keyCode: 229 });
  assert.equal(await review.isVisible(), true);
  for (const reason of ["Missing session", "Session not yet saved", "Unsupported session ID", "Session family could not be resolved"]) assert.ok((await review.innerText()).includes(reason));
  assert.match(await review.innerText(), /Cross-task affected title/);
  assert.match(await review.innerText(), /3 sessions/);
  await review.getByRole("button", { name: "Cancel", exact: true }).click();
  await review.waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Archive: Archive fixture task");
  assert.equal(await archive.evaluate(node => node === document.activeElement), true, "cancel returns trigger focus");
  await openReview(); await page.keyboard.press("Escape");
  await review.waitFor({ state: "hidden" });
  assert.equal(await inspector.isVisible(), true, "Escape cancels review only");
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Archive: Archive fixture task");
  assert.equal(await archive.evaluate(node => node === document.activeElement), true);
  assert.equal(writes.length, 0);
  failPreview = true; await archive.click();
  await review.getByRole("alert").filter({ hasText: "Preview metadata unavailable" }).waitFor();
  assert.equal(await confirm.isEnabled(), false);
  await review.getByRole("button", { name: "Refresh", exact: true }).click();
  await review.getByRole("checkbox").waitFor();
  await page.keyboard.press("Escape"); await review.waitFor({ state: "hidden" });
  assert.equal(writes.length, 0, "failed preview and cancellation never write archive");
  // Delayed preview cannot reopen after details dismissal or a different task.
  holdPreview = true; await archive.click();
  await review.getByRole("status").waitFor();
  await inspector.getByRole("button", { name: "Close task details", exact: true }).click();
  await dialog.getByRole("button", { name: "Another fixture task", exact: true }).click();
  releasePreview(); await page.waitForTimeout(200);
  assert.equal(await review.count(), 0);
  await inspector.getByRole("button", { name: "Close task details", exact: true }).click();
  await dialog.getByRole("button", { name: "Archive fixture task", exact: true }).click();
  holdPreview = true; await archive.click(); await review.getByRole("status").waitFor();
  await page.mouse.click(3, 3); // Dismiss the whole panel via its backdrop.
  releasePreview(); await page.waitForTimeout(200);
  await page.getByRole("button", { name: "Task dashboard", exact: true }).click();
  assert.equal(await review.count(), 0, "dismissed dashboard discards slow preview");
  // Stale preview fails visibly, without claiming success or silently obtaining a new token.
  await openReview(); await consent.check(); mode = "conflict";
  const beforeConflict = previewReads, originalBase = board.tasks[0].archiveRevision;
  board.tasks[0].archiveRevision++;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.waitForFunction(() => [...document.querySelectorAll('[data-task-archive-preview] button')].some(button => button.textContent === "Archive task and session families" && !button.disabled));
  assert.equal(await consent.isChecked(), true, "focus refresh does not replace reviewed consent");
  await confirm.click();
  await inspector.getByRole("alert").filter({ hasText: "Preview changed" }).waitFor();
  assert.equal(board.tasks[0].archived, false);
  assert.equal(previewReads, beforeConflict);
  assert.equal(writes.at(-1).expectedArchiveRevision, originalBase, "focus refresh never rebases a reviewed preview");
  assert.equal(writes.at(-1).cascade.previewToken, `frozen-preview-${beforeConflict}`);
  assert.equal(await inspector.getByRole("button", { name: "Retry exact archive request" }).count(), 0);
  // Lost response: focus/reload must not rebase UUID, archive revision or token.
  await openReview(); assert.equal(await consent.isChecked(), false);
  await consent.check(); mode = "lost"; await confirm.click();
  const retry = inspector.getByRole("button", { name: "Retry exact archive request", exact: true });
  await retry.waitFor();
  const original = structuredClone(writes.at(-1)), previewsAtLoss = previewReads;
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await retry.waitFor(); await retry.click();
  await inspector.getByRole("status").filter({ hasText: "1 session families archived, 4 linked sessions skipped" }).waitFor();
  assert.deepEqual(writes.at(-1), original);
  assert.equal(previewReads, previewsAtLoss);
  assert.equal(await inspector.getByLabel("Title", { exact: true }).inputValue(), "Unsaved archive draft");
  assert.equal(await composer.inputValue(), "Archive must preserve my composer draft");
  assert.equal(page.url(), url, "archive never navigates chat");
  await restore(); assert.ok(archivedRoots.has(rootId), "task restore leaves session archives alone");
  // Public pending intent survives full page reload and drives exact resume.
  await openReview(); await consent.check(); mode = "pending"; await confirm.click();
  await inspector.getByText("Task archived, but the session archive batch is not confirmed. This is not a completed session archive.", { exact: true }).waitFor();
  const pendingRequest = structuredClone(writes.at(-1));
  assert.equal(await inspector.getByRole("status").filter({ hasText: "session families archived," }).count(), 0, "pending is not full success");
  await page.reload(); await openTask();
  await inspector.getByRole("button", { name: "Resume exact session archive request", exact: true }).click();
  await inspector.getByRole("status").filter({ hasText: "1 session families archived" }).waitFor();
  assert.deepEqual(writes.at(-1), pendingRequest);
  await restore();
  crossTask = false;
  await openReview(); assert.equal(await consent.count(), 0); assert.equal(await confirm.isEnabled(), true);
  await confirm.click(); await inspector.getByRole("status").filter({ hasText: "1 session families archived" }).waitFor();
  assert.equal(writes.at(-1).cascade.confirmCrossTask, false);
  await restore();
  // Pending cancellation is an explicit restore, not automatic recovery.
  crossTask = true; await openReview(); await consent.check(); mode = "pending"; await confirm.click();
  await inspector.getByRole("button", { name: "Resume exact session archive request", exact: true }).waitFor();
  await restore(); assert.equal(board.tasks[0].pendingSessionArchive, undefined);
  // Even a 2xx task response with an unconfirmed batch is not a success notice.
  await openReview(); await consent.check(); mode = "pending-ok"; await confirm.click();
  await inspector.getByRole("button", { name: "Resume exact session archive request", exact: true }).waitFor();
  await inspector.getByRole("button", { name: "Retry exact archive request", exact: true }).waitFor();
  assert.equal(await inspector.getByRole("status").filter({ hasText: "session families archived," }).count(), 0);
  await restore();
  // A fresh composer draft stays intact through the floating UI flow.
  await page.mouse.click(3, 3);
  await composer.fill("Fresh draft for archive review");
  await page.getByRole("button", { name: "Task dashboard", exact: true }).click();
  await openReview(); await page.keyboard.press("Escape");
  await page.mouse.click(3, 3);
  assert.equal(await composer.inputValue(), "Fresh draft for archive review");
  assert.equal(page.url(), url);
  // 390px, all locales and themes: review, consent, cancellation and wrapping.
  for (const [locale, dashboardName, archiveName, reviewName, confirmName] of [
    ["en", "Task dashboard", "Archive", "Review task and session archive", "Archive task and session families"],
    ["zh-CN", "任务看板", "归档", "确认任务与对话归档范围", "归档任务及对话族"],
    ["zh-TW", "任務看板", "封存", "確認任務與對話封存範圍", "封存任務及對話族"],
  ]) for (const theme of ["light", "dark"]) {
    await page.evaluate(({ locale, theme }) => { localStorage.setItem("pi-locale", locale); localStorage.setItem("pi-theme", theme); }, { locale, theme });
    await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`${base}/`);
    await page.getByRole("button", { name: locale === "en" ? "Show sidebar" : locale === "zh-CN" ? "显示侧边栏" : "顯示側邊欄", exact: true }).click();
    await page.getByRole("button", { name: dashboardName, exact: true }).click();
    const localDialog = page.getByRole("dialog", { name: dashboardName, exact: true });
    await localDialog.getByRole("button", { name: "Archive fixture task", exact: true }).click();
    await inspector.getByRole("button", { name: `${archiveName}: Archive fixture task`, exact: true }).click();
    const localReview = inspector.getByRole("region", { name: reviewName, exact: true });
    await localReview.getByRole("checkbox").waitFor();
    assert.equal(await localReview.getByRole("checkbox").isChecked(), false);
    assert.equal(await localReview.getByRole("button", { name: confirmName, exact: true }).isEnabled(), false);
    assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.ok(await localReview.evaluate(node => node.scrollWidth <= node.clientWidth));
    await page.screenshot({ path: path.join(root, `${locale}-${theme}.png`) });
    await page.keyboard.press("Escape"); await localReview.waitFor({ state: "hidden" });
    assert.equal(await inspector.isVisible(), true);
  }
  assert.equal(agentWrites, 0); assert.deepEqual(errors, []);
  console.log(`PASS task session archive UI: cancel/Escape/IME/focus, stale/dismissed preview, required cross-task consent, skipped reasons, conflict, lost-response exact retry, durable pending resume/cancel, restore without cascade, drafts/no Agent commands, 390px three languages/two themes. Artifacts: ${root}`);
} catch (error) {
  await page.screenshot({ path: path.join(root, "failure.png") }); console.error(`Artifacts: ${root}; page errors: ${JSON.stringify(errors)}`); throw error;
} finally { await browser.close(); }
