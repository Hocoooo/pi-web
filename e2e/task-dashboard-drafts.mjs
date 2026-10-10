// Real Chromium navigation/composer; every API is intercepted, no real session/provider.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
const base = process.env.E2E_BASE_URL || "http://127.0.0.1:30142";
const evidence = process.env.E2E_ARTIFACT_DIR || await mkdtemp(path.join(os.tmpdir(), "pi-web-task-drafts-"));
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ headless: true });
const failures = [], scenarios = [];
const cases = [
  ...["project", "chat"].flatMap((kind) => ["back", "forward"].map((direction) => [kind, direction, "none"])),
  ...["project", "chat"].flatMap((kind) => ["edit", "clear-text", "remove-image", "clear-both"].map((mutation) => [kind, "back", mutation])),
];
const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=";
try {
  for (const [kind, historyReturn, pendingEdit] of cases) {
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await context.addInitScript(() => localStorage.setItem("pi-locale", "en"));
    const project = "/fixtures/alpha/worktree";
    const chat = { cwd: "/fixtures/chat-workspace", projectRoot: "/fixtures/chat-workspace", projectKey: "pi-web:chat", sessionKind: "chat" };
    const sessions = ["alpha", "beta"].map((id) => ({ id, name: id, cwd: `/fixtures/${id}`, projectRoot: `/fixtures/${id}`, projectKey: id, modified: "2026-10-09", created: "2026-10-09", messageCount: 1, firstMessage: id }));
    const agentRequests = [], errors = [];
    await context.route("**/api/**", async (route) => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname.startsWith("/api/agent/") && url.pathname !== "/api/agent/running") agentRequests.push(`${request.method()} ${url.pathname} ${request.postData() ?? ""}`);
      let data = {};
      if (url.pathname === "/api/sessions") data = { sessions, runningSessionIds: [] };
      else if (url.pathname === "/api/agent/running") data = { runningSessionIds: [] };
      else if (url.pathname === "/api/default-cwd") data = chat;
      else if (url.pathname === "/api/cwd/validate") { const { cwd } = request.postDataJSON(); data = cwd === chat.cwd ? chat : { cwd, projectRoot: cwd, projectKey: cwd }; }
      else if (url.pathname === "/api/tasks") data = { viewsRevision: 0, savedViews: [], orderRevision: 0, columnsRevision: 0, tasks: [], columns: ["todo", "in-progress", "review", "blocked", "done"].map((id) => ({ id, isCompletion: id === "done" })) };
      else if (url.pathname === "/api/models") data = { models: [], modelList: [] };
      else if (url.pathname === "/api/worktrees") data = { isGit: false, worktrees: [] };
      else if (url.pathname.startsWith("/api/sessions/")) data = { info: sessions.find((s) => url.pathname.includes(s.id)), context: { messages: [], entryIds: [] }, tree: [] };
      await route.fulfill({ json: data });
    });
    const page = await context.newPage();
    const timeline = [];
    const record = async (phase) => timeline.push(await page.evaluate((phase) => ({
      phase, time: performance.now(), pathname: location.pathname,
      text: document.querySelector("textarea")?.value ?? null,
      images: document.querySelectorAll('img[src^="blob:"], img[src^="data:image/"]').length,
      tabOpen: JSON.parse(sessionStorage.getItem("pi-web:tab-open-session")),
    }), phase));
    const navigationRequested = Promise.withResolvers(), releaseNavigation = Promise.withResolvers();
    let holdNavigation = pendingEdit !== "none";
    if (holdNavigation) await context.route((url) => url.pathname === "/tasks", async (route) => {
      if (holdNavigation) {
        holdNavigation = false;
        navigationRequested.resolve();
        await releaseNavigation.promise;
      }
      await route.continue();
    });
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(`${base}/${kind === "project" ? `?cwd=${encodeURIComponent(project)}` : "?chat=1"}`, { waitUntil: "networkidle" });
      const picker = page.getByRole("combobox", { name: "Session project", exact: true });
      const input = page.locator("textarea").first();
      await picker.waitFor();
      // Non-initial draft identities must also survive (picker creates a new UUID).
      await picker.selectOption("/fixtures/beta");
      if (kind === "chat") await picker.selectOption({ label: "No project" });
      else { // Return to a specific cwd, not merely the project root.
        await page.goto(`${base}/?cwd=${encodeURIComponent(project)}`, { waitUntil: "networkidle" });
      }
      await picker.waitFor();
      const expectedPicker = await picker.inputValue();
      const expectedCwd = kind === "chat" ? chat.cwd : project;
      let expectedText = `${kind} ${historyReturn} unsent text + image`;
      await input.fill(expectedText);
      await page.locator('input[type="file"][accept*="image"]').setInputFiles({ name: "draft.png", mimeType: "image/png", buffer: Buffer.from(image, "base64") });
      const attachment = page.locator('img[src^="blob:"], img[src^="data:image/"]');
      await attachment.waitFor();
      const imageBytes = async () => attachment.evaluate(async (img) => Array.from(new Uint8Array(await (await fetch(img.src)).arrayBuffer())));
      const source = await imageBytes();
      let expectedImages = 1;
      const assertDraft = async (checkpoint) => {
        await picker.waitFor();
        assert.deepEqual({ text: await input.inputValue(), images: await attachment.count() }, { text: expectedText, images: expectedImages }, `${kind}/${historyReturn}/${pendingEdit}: ${checkpoint} restores latest text/image without duplicate merging`);
        assert.equal(await picker.inputValue(), expectedPicker, `${kind}: cwd identity restored`);
        if (expectedImages) assert.deepEqual(await imageBytes(), source, `${kind}: image bytes restored`);
        const memory = await page.evaluate(() => JSON.parse(sessionStorage.getItem("pi-web:tab-open-session")));
        assert.equal(memory.cwd, expectedCwd);
        assert.equal(new URL(page.url()).searchParams.has("session"), false);
        assert.deepEqual(agentRequests, [], `${checkpoint}: zero Agent runtime requests`);
      };
      const assertBoard = () => page.getByRole("heading", { name: "Task dashboard", exact: true }).waitFor();
      // Establish A(chat) -> T(tasks) -> B(chat) with Links. The defect is
      // departing B via history, not returning to chat after a Link departure.
      await record("before navigation click");
      await page.getByRole("link", { name: "Task dashboard", exact: true }).click({ noWaitAfter: true });
      if (pendingEdit !== "none") {
        await navigationRequested.promise;
        await picker.waitFor();
        assert.equal(new URL(page.url()).pathname, "/", "blocked route has not committed; real composer is still mounted");
        await record("route blocked, before edit");
        if (pendingEdit === "edit") expectedText += "\nedit while navigation is pending";
        else if (pendingEdit === "clear-text" || pendingEdit === "clear-both") expectedText = "";
        await input.fill(expectedText);
        if (pendingEdit === "remove-image" || pendingEdit === "clear-both") {
          await attachment.locator("xpath=../..").getByRole("button").last().click();
          expectedImages = 0;
        }
        assert.equal(await input.inputValue(), expectedText);
        assert.equal(await attachment.count(), expectedImages);
        await record("route blocked, after final edit");
        releaseNavigation.resolve();
      }
      await assertBoard();
      await record("route committed, composer departed");
      await page.getByRole("link", { name: "Chat", exact: true }).click();
      await picker.waitFor();
      await record("Link return B");
      await assertDraft("Link return B");
      for (let iteration = 0; iteration < 3; iteration++) {
        await page.goBack(); // B -> T: history LEAVES the active composer.
        await assertBoard();
        if (historyReturn === "back") {
          await page.goBack(); // T -> original A
          await assertDraft(`history back A #${iteration}`);
          await page.goForward(); // A -> T: forward also LEAVES a composer.
          await assertBoard();
        }
        await page.goForward(); // T -> B
        await assertDraft(`history forward B #${iteration}`);
        // Later edits must replace the restored snapshot, not revive/merge it.
        expectedText += `\nedit ${iteration}`;
        await input.fill(expectedText);
      }
      // Explicit picker navigation carries the active draft rather than restoring a
      // stale dashboard identity. Ordinary New still chooses its own composer.
      await picker.selectOption("/fixtures/beta");
      await page.waitForFunction(() => document.querySelector('[aria-label="Session project"]')?.value === "/fixtures/beta");
      assert.equal(await input.inputValue(), expectedText);
      assert.equal(await attachment.count(), expectedImages);
      if (expectedImages) assert.deepEqual(await imageBytes(), source);
      await page.getByRole("button", { name: "New", exact: true }).click();
      await page.waitForFunction(() => document.querySelector("textarea")?.value === "");
      assert.equal(await attachment.count(), 0, "ordinary New never revives the dashboard return draft");
      await input.fill("explicit navigation must win");
      // Explicit different cwd wins over return memory and does not carry that draft.
      await page.getByRole("link", { name: "Task dashboard", exact: true }).click();
      await page.getByRole("heading", { name: "Task dashboard", exact: true }).waitFor();
      await page.goto(`${base}/?cwd=${encodeURIComponent("/fixtures/alpha")}`, { waitUntil: "networkidle" });
      await picker.waitFor();
      assert.equal(await picker.inputValue(), "/fixtures/alpha");
      assert.equal(await input.inputValue(), "");
      assert.equal(await attachment.count(), 0);
      assert.deepEqual(agentRequests, [], "navigation never reads/writes an Agent runtime");
      assert.deepEqual(errors, []);
      console.log(`PASS: ${kind}/${historyReturn}/${pendingEdit}: ${pendingEdit === "none" ? "Link" : "blocked route + final edit/removal"} A->T->B, history B->T->${historyReturn === "back" ? "A->T->B" : "B"} x3, latest text/image count+bytes, cwd, no duplicate merging, picker migration, ordinary New priority, explicit cwd precedence; zero Agent requests`);
    } catch (error) {
      failures.push(`${kind}/${historyReturn}/${pendingEdit}: ${error.stack}`);
      await page.screenshot({ path: path.join(evidence, `${kind}-${historyReturn}-${pendingEdit}-failure.png`), fullPage: true });
    } finally {
      releaseNavigation.resolve();
      scenarios.push({ kind, historyReturn, pendingEdit, timeline, agentRequests, errors });
      await context.close();
    }
  }
  await writeFile(path.join(evidence, "results.json"), JSON.stringify({ failures, scenarios }, null, 2));
  assert.deepEqual(failures, []);
} finally { await browser.close(); }
