import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createJiti } from "jiti";

// Reuse existing source dev; all APIs are fixture-routed to our own real temporary store.
const base = process.env.E2E_BASE_URL || "http://127.0.0.1:30142";
const evidence = process.env.E2E_ARTIFACT_DIR || await mkdtemp(path.join(os.tmpdir(), "pi-web-retry-reload-browser-"));
await mkdir(evidence, { recursive: true });
const { taskOperation } = await createJiti(import.meta.url).import("../lib/task-operations.ts");
const browser = await chromium.launch({ headless: true });
const results = [];
const requestFields = ["action", "id", "columnId", "operationId", "expectedRevision", "expectedOrderRevision", "position"];

try {
  for (const mode of ["uncommitted", "lost-response"]) {
    for (const trigger of ["online", "focus", "manual"]) {
      const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-web-retry-reload-data-"));
      const options = { agentDir };
      const tasks = [];
      for (const title of ["Alpha", "Bravo"]) tasks.push((await taskOperation({ action: "create", id: randomUUID(), title, description: "Original", completionCriteria: "User confirms", cwd: null }, options)).task);
      const initial = await taskOperation({ action: "list" }, options);
      const file = path.join(agentDir, "tasks", "board.json");
      const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
      await context.addInitScript(() => { if (location.protocol.startsWith("http")) localStorage.setItem("pi-locale", "en"); });
      const requests = [], errors = [];
      let failMove = false, failedReads = false, failedGetCount = 0, agentRequests = 0;
      const page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      await context.route("**/api/**", async (route) => {
        const req = route.request(), url = new URL(req.url());
        if (url.pathname === "/api/tasks") {
          const input = req.method() === "GET" ? { action: "list" } : req.postDataJSON();
          if (req.method() === "POST") requests.push(input);
          if (req.method() === "GET" && failedReads) { failedGetCount++; return route.abort("failed"); }
          if (req.method() === "POST" && failMove) {
            failMove = false;
            if (mode === "uncommitted") { failedReads = true; return route.abort("failed"); }
            await taskOperation(input, options);
            return route.fulfill({ status: 503, json: { error: "Fixture lost response after move commit", code: "storage-unavailable" } });
          }
          try { return route.fulfill({ json: await taskOperation(input, options) }); }
          catch (error) { return route.fulfill({ status: error.code === "conflict" ? 409 : 503, json: { error: error.message, code: error.code } }); }
        }
        if (url.pathname.startsWith("/api/agent/") && req.method() === "POST") agentRequests++;
        return route.fulfill({ json: {} });
      });
      const card = (task) => page.locator(`[data-task-card="${task.id}"]`);
      const retry = page.getByRole("button", { name: "Retry exact move", exact: true });
      const refresh = page.locator("header").getByRole("button", { name: "Refresh", exact: true });
      const alert = page.locator("main").getByRole("alert");
      const target = trigger === "online" ? tasks[1] : tasks[0];
      const sibling = tasks.find((task) => task.id !== target.id);
      const record = { mode, trigger, agentDir };
      try {
        await page.goto(`${base}/tasks`); await card(target).waitFor();
        await page.waitForFunction(() => ![...document.querySelectorAll('header button')].find((n) => n.textContent === 'Refresh')?.disabled);
        failMove = true;
        if (trigger === "online") await card(target).getByRole("button", { name: `Move up: ${target.title}`, exact: true }).click();
        else if (trigger === "focus") await card(target).getByRole("button", { name: `Move down: ${target.title}`, exact: true }).click();
        else await card(target).getByRole("combobox", { name: `Move to: ${target.title}`, exact: true }).selectOption("review");
        await retry.waitFor();
        await page.waitForFunction(() => ![...document.querySelectorAll('button')].find((n) => n.textContent === 'Retry exact move')?.disabled);
        assert.equal(requests.length, 1);
        const original = structuredClone(requests[0]);
        assert.deepEqual(Object.keys(original).sort(), [...requestFields].sort());
        assert.equal(original.expectedRevision, target.revision);
        assert.equal(original.expectedOrderRevision, initial.orderRevision);
        assert.deepEqual(original.position, trigger === "online" ? { before: sibling.id } : trigger === "focus" ? { after: sibling.id } : { edge: "end" });
        if (mode === "uncommitted") {
          assert.ok(failedGetCount > 0, "immediate reconciliation really failed too");
          assert.deepEqual(await taskOperation({ action: "list" }, options), initial);
        } else {
          const committed = await taskOperation({ action: "list" }, options);
          assert.equal(committed.orderRevision, initial.orderRevision + 1);
          assert.equal(committed.tasks.find((task) => task.id === target.id).revision, target.revision + 1);
        }
        const beforeError = await alert.innerText();
        // Update a different task's details without advancing order/target revision. A successful
        // reload must adopt authority, while the original move intent remains retryable unchanged.
        await taskOperation({ action: "edit", id: sibling.id, expectedRevision: sibling.revision, title: sibling.title,
          description: sibling.description, completionCriteria: sibling.completionCriteria, priority: 2, labels: ["synchronized"] }, options);
        failedReads = false;
        const loaded = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/tasks" && response.request().method() === "GET" && response.ok());
        if (trigger === "manual") await refresh.click();
        else await page.evaluate((event) => window.dispatchEvent(new Event(event)), trigger);
        await loaded;
        await card(sibling).getByText("Priority: High", { exact: true }).waitFor();
        await page.waitForFunction(() => ![...document.querySelectorAll('header button')].find((n) => n.textContent === 'Refresh')?.disabled);
        assert.equal(await retry.count(), 1, "successful board reload must retain unconfirmed move retry");
        assert.equal(await alert.innerText(), beforeError, "successful board reload must retain move error");
        assert.equal(await retry.isEnabled(), true);
        assert.equal(requests.length, 1, "reload must not submit or confirm a move");
        const authoritative = await taskOperation({ action: "list" }, options);
        const currentTarget = authoritative.tasks.find((task) => task.id === target.id);
        await page.locator(`[data-task-column="${currentTarget.columnId}"] [data-task-card="${target.id}"]`).waitFor();
        const beforeRetryBytes = await readFile(file, "utf8");
        await retry.click();
        await page.locator('p[role="status"]').filter({ hasText: "Task status and position saved" }).waitFor();
        assert.equal(requests.length, 2);
        const retried = requests[1];
        for (const field of requestFields) assert.deepEqual(retried[field], original[field], `${mode}/${trigger}: ${field} stays exact`);
        assert.deepEqual(retried, original);
        assert.equal(await retry.count(), 0); assert.equal(await alert.count(), 0);
        const confirmed = await taskOperation({ action: "list" }, options);
        if (mode === "lost-response") {
          assert.deepEqual(confirmed, authoritative);
          assert.equal(await readFile(file, "utf8"), beforeRetryBytes, "receipt confirmation must not write or move twice");
        } else {
          assert.equal(confirmed.orderRevision, authoritative.orderRevision + 1);
          assert.equal(confirmed.tasks.find((task) => task.id === target.id).revision, target.revision + 1);
        }
        assert.equal(agentRequests, 0); assert.deepEqual(errors, []);
        Object.assign(record, { pass: true, original, retried, unchangedFields: requestFields, beforeError, failedGetCount, agentRequests, errors });
        console.log(`PASS ${mode}/${trigger}: authority reload preserves error/retry; every request field unchanged; exact retry confirmed once`);
      } catch (error) {
        Object.assign(record, { pass: false, error: String(error), requests, failedGetCount, agentRequests, errors });
        await page.screenshot({ path: path.join(evidence, `${mode}-${trigger}-failure.png`), fullPage: true });
        console.error(`FAIL ${mode}/${trigger}: ${error}`);
      } finally { results.push(record); await context.close(); }
    }
  }
  await writeFile(path.join(evidence, "results.json"), JSON.stringify({ results }, null, 2));
  assert.equal(results.filter((result) => !result.pass).length, 0, "all six failure/reload combinations must pass");
  console.log(`PASS ${results.length}/6 failure+reload regressions; evidence=${evidence}`);
} finally { await browser.close(); }
