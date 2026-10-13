// Reuses an existing dev server; all API/EventSource traffic is mocked.
// No real sessions, extensions, provider requests or server lifecycle changes.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.E2E_BASE_URL || "http://127.0.0.1:30141";
const browser = await chromium.launch({ headless: true, ...(process.env.E2E_BROWSER_CHANNEL ? { channel: process.env.E2E_BROWSER_CHANNEL } : {}) });
try {
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ locale: "en-US", viewport });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem("pi-locale", "en");
      const sources = [];
      window.EventSource = class {
        readyState = 1;
        onmessage = null;
        onerror = null;
        constructor(url) {
          this.url = url;
          sources.push(this);
          setTimeout(() => this.onmessage?.({ data: JSON.stringify({ type: "connected", isStreaming: false, isPromptRunning: false }) }), 10);
        }
        close() { this.readyState = 2; }
      };
      window.emitTitle = (event) => sources.forEach((source) => {
        if (source.readyState === 1 && source.url.includes(event.sessionId)) source.onmessage?.({ data: JSON.stringify(event) });
      });
    });
    const root = {
      id: "auto-title-root", name: "Original generated title", autoTitleEnabled: true,
      cwd: "/fixtures/title", projectRoot: "/fixtures/title", projectKey: "title",
      path: "/fixtures/title/root.jsonl", created: "2026-10-13T00:00:00Z", modified: "2026-10-13T00:00:00Z",
      messageCount: 2, firstMessage: "Implement a feature", transient: false,
    };
    const child = { ...root, id: "auto-title-child", name: "Worker task", autoTitleEnabled: false,
      path: "/fixtures/title/child.jsonl", parentSessionId: root.id,
      relation: { kind: "subagent", parentSessionId: root.id, profile: "worker", description: "Worker task", status: "completed" } };
    const stats = { userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 };
    const liveState = { isStreaming: false, isPromptRunning: false, isBashRunning: false, isCompacting: false,
      autoCompactionEnabled: true, extensionStatuses: [], extensionWidgets: [], queuedMessages: { steering: [], followUp: [] } };
    let version = 1;
    let listRequests = 0;
    let detailRequests = 0;
    let paidRequests = 0;
    let failPatch = false;
    const heldList = Promise.withResolvers();
    const releaseList = Promise.withResolvers();
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      let data = {};
      if (url.pathname === "/api/sessions") {
        listRequests++;
        data = { sessions: structuredClone([root, child]), sessionListVersion: version, runningSessionIds: [], completionNotificationSuppressedSessionIds: [child.id] };
        if (listRequests === 2) { heldList.resolve(); await releaseList.promise; }
      } else if (url.pathname === "/api/agent/running") {
        data = { sessionListVersion: version, runningSessionIds: [], completionNotificationSuppressedSessionIds: [child.id] };
      } else if (url.pathname === "/api/models") data = { models: [], modelList: [] };
      else if (url.pathname === "/api/home") data = { home: "/fixtures" };
      else if (url.pathname === "/api/cwd/validate") data = { cwd: root.cwd, projectRoot: root.projectRoot, projectKey: root.projectKey };
      else if (url.pathname === "/api/worktrees") data = { projectRoot: root.projectRoot, projectKey: root.projectKey, isGit: false, worktrees: [] };
      else if (url.pathname.endsWith("/auto-name") || url.pathname.endsWith("/next-cue")) { paidRequests++; data = {}; }
      else if (url.pathname.startsWith("/api/sessions/")) {
        const info = url.pathname.includes(child.id) ? child : root;
        if (request.method() === "PATCH") {
          if (failPatch) { failPatch = false; await route.fulfill({ status: 503, json: { error: "Simulated settings failure" } }); return; }
          const body = request.postDataJSON();
          if (typeof body.name === "string") { info.name = body.name; info.autoTitleEnabled = false; }
          else info.autoTitleEnabled = body.autoTitleEnabled;
          version++;
          await page.evaluate((event) => window.emitTitle(event), { type: "session_title_updated", sessionId: info.id, title: info.name, autoTitleEnabled: info.autoTitleEnabled, sessionListVersion: version });
          data = { ok: true, title: info.name, autoTitleEnabled: info.autoTitleEnabled, sessionListVersion: version };
        } else if (url.pathname.endsWith("/state")) data = { running: false, state: liveState };
        else {
          detailRequests++;
          data = { sessionId: info.id, filePath: info.path, info, sessionListVersion: version, totalActiveMs: 0, leafId: "reply", tree: [], stats,
            context: { messages: [
              { role: "user", content: "Implement a feature", timestamp: 1 },
              { role: "assistant", content: [{ type: "text", text: "Feature delivered" }], stopReason: "stop", timestamp: 2 },
            ], entryIds: ["user", "reply"], oldestEntryId: "user", hasMore: false, thinkingLevel: "off", model: null } };
        }
      } else if (url.pathname.startsWith("/api/agent/")) {
        if (request.method() === "POST" && ["prompt", "steer", "follow_up"].includes(request.postDataJSON()?.type)) paidRequests++;
        data = { success: true, state: liveState, data: liveState, commands: [], tools: [] };
      } else if (url.pathname.startsWith("/api/files")) data = { entries: [] };
      await route.fulfill({ json: data });
    });
    try {
      await page.goto(`${base}/?session=${root.id}`, { waitUntil: "domcontentloaded" });
      await page.getByText("Feature delivered", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Session info", exact: true }).click();
      const panel = page.locator(".session-info-popover");
      const toggle = panel.getByRole("checkbox", { name: "Update title after each completed turn", exact: true });
      await toggle.waitFor();
      assert.equal(await toggle.isChecked(), true);
      await panel.getByText(/one extra request per successful turn/).waitFor();
      const input = page.locator("textarea").first();
      await input.fill("Unsent draft stays");
      await heldList.promise;
      const readsBeforeTitle = detailRequests;
      root.name = "Updated after the turn";
      version++;
      await page.evaluate((event) => window.emitTitle(event), { type: "session_title_updated", sessionId: root.id, title: root.name, autoTitleEnabled: true, sessionListVersion: version });
      await panel.getByText(root.name, { exact: true }).waitFor();
      releaseList.resolve();
      await page.waitForTimeout(600);
      assert.equal(await panel.getByText(root.name, { exact: true }).count(), 1, "a delayed old list cannot roll back the active title");
      assert.equal(await input.inputValue(), "Unsent draft stays");
      assert.equal(detailRequests, readsBeforeTitle, "title metadata must not reload chat history");
      assert.equal(paidRequests, 0, "title SSE does not submit prompts or request cues/naming again");

      await toggle.click();
      await page.waitForFunction(() => !document.querySelector('.session-info-popover input[type="checkbox"]').checked);
      assert.equal(root.autoTitleEnabled, false);
      failPatch = true;
      await toggle.click();
      await panel.getByRole("alert").getByText("Simulated settings failure").waitFor();
      assert.equal(await toggle.isChecked(), false, "failed save must retain the server policy");
      await toggle.click();
      await page.waitForFunction(() => document.querySelector('.session-info-popover input[type="checkbox"]').checked);
      assert.equal(root.autoTitleEnabled, true);
      root.name = "Pinned by user";
      root.autoTitleEnabled = false;
      version++;
      await page.evaluate((event) => window.emitTitle(event), { type: "session_title_updated", sessionId: root.id, title: root.name, autoTitleEnabled: false, sessionListVersion: version });
      await panel.getByText("Pinned by user", { exact: true }).waitFor();
      assert.equal(await toggle.isChecked(), false);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "Session info", exact: true }).click();
      await toggle.waitFor();
      assert.equal(await toggle.isChecked(), false, "policy restores from the server after reload");
      await page.goto(`${base}/?session=${child.id}`, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "Session info", exact: true }).click();
      await panel.waitFor();
      assert.equal(await panel.getByRole("checkbox").count(), 0, "subagent title automation is not exposed");
      assert.equal(paidRequests, 0);
      assert.deepEqual(errors, []);
      console.log(`PASS ${viewport.width}px: title SSE, delayed-catalog protection, draft/history preservation, no paid requests, policy toggle/error/reload, manual lock and subagent exclusion`);
    } catch (error) {
      console.error("Browser diagnostics", JSON.stringify({
        viewport, listRequests, detailRequests, errors,
        panel: await page.locator(".session-info-popover").allTextContents(),
      }));
      throw error;
    } finally {
      releaseList.resolve();
      await context.close();
    }
  }
} finally { await browser.close(); }
