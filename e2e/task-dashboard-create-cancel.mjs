import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createJiti } from "jiti";

// Reuse source dev. Every API is intercepted; never read/write the dev agent directory.
const base = process.env.E2E_BASE_URL || "http://127.0.0.1:30142";
const evidence = process.env.E2E_ARTIFACT_DIR || await mkdtemp(path.join(os.tmpdir(), "pi-web-task-cancel-browser-"));
await mkdir(evidence, { recursive: true });
const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-web-task-cancel-browser-data-"));
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { taskOperation } = await jiti.import("../lib/task-operations.ts");
const options = { agentDir };
const saved = (await taskOperation({ action: "create", id: randomUUID(), title: "Saved fixture task", description: "Saved explanation", completionCriteria: "Saved requirements", cwd: null }, options)).task;
const file = path.join(agentDir, "tasks", "board.json");
const savedBytes = await readFile(file, "utf8");
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const language of [
    { locale: "en", newTask: "New task", cancel: "Cancel", title: "Title", description: "Description", criteria: "Completion requirements" },
    { locale: "zh-CN", newTask: "新建任务", cancel: "取消", title: "标题", description: "说明", criteria: "完成要求" },
    { locale: "zh-TW", newTask: "新增任務", cancel: "取消", title: "標題", description: "說明", criteria: "完成要求" },
  ]) {
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    await context.addInitScript((locale) => {
      if (location.protocol === "http:" || location.protocol === "https:") localStorage.setItem("pi-locale", locale);
    }, language.locale);
    const errors = [];
    let taskWrites = 0, agentRequests = 0, activityReads = 0;
    await context.route("**/api/**", async (route) => {
      const request = route.request(), url = new URL(request.url());
      // Ticket 04 permits only the existing read-only running snapshot, never Agent startup/commands.
      if (url.pathname === "/api/agent/running" && request.method() === "GET") {
        activityReads++;
        return route.fulfill({ json: { runningSessionIds: [], sessionActivity: {}, sessionListVersion: 1 } });
      }
      if (url.pathname.startsWith("/api/agent/")) agentRequests++;
      if (url.pathname === "/api/tasks") {
        if (request.method() !== "GET") taskWrites++;
        const result = await taskOperation(request.method() === "GET" ? { action: "list" } : request.postDataJSON(), options);
        return route.fulfill({ json: result });
      }
      return route.fulfill({ json: {} });
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      await page.goto(`${base}/tasks`);
      await page.locator(`[data-task-card="${saved.id}"]`).waitFor();
      await page.getByRole("button", { name: language.newTask, exact: true }).click();
      const form = page.locator("main form");
      await form.getByLabel(language.title, { exact: true }).fill(`Cancelled ${language.locale}`);
      await form.getByLabel(language.description, { exact: true }).fill("Do not save this explanation");
      await form.getByLabel(language.criteria, { exact: true }).fill("Do not save these requirements");
      const cancel = form.getByRole("button", { name: language.cancel, exact: true });
      await cancel.waitFor({ timeout: 5000 });
      assert.equal(await cancel.textContent(), language.cancel);
      assert.equal((await form.innerText()).includes("common.cancel"), false);
      await page.screenshot({ path: path.join(evidence, `${language.locale}-button.png`), fullPage: true });
      await cancel.click();
      await form.waitFor({ state: "hidden" });
      assert.equal(await readFile(file, "utf8"), savedBytes);
      assert.deepEqual((await taskOperation({ action: "list" }, options)).tasks, [saved]);
      await page.reload(); await page.locator(`[data-task-card="${saved.id}"]`).waitFor();
      assert.equal(await page.locator("[data-task-card]").count(), 1);
      assert.equal(taskWrites, 0); assert.equal(agentRequests, 0); assert.deepEqual(errors, []);
      assert.ok(activityReads > 0, "dashboard recalibrates via read-only fixture snapshot");
      results.push({ locale: language.locale, pass: true, cancelText: language.cancel, taskWrites, agentRequests, activityReads, errors });
      console.log(`PASS ${language.locale}: actual translated Cancel button; populated create cancellation preserves store bytes/task/revision/time; reload has no new task; zero task writes/Agent commands, read-only running snapshots only`);
    } catch (error) {
      await page.screenshot({ path: path.join(evidence, `${language.locale}-failure.png`), fullPage: true });
      results.push({ locale: language.locale, pass: false, error: String(error), taskWrites, agentRequests, activityReads, errors });
    } finally { await context.close(); }
  }
  await writeFile(path.join(evidence, "results.json"), JSON.stringify({ results, agentDir }, null, 2));
  assert.ok(results.every((result) => result.pass), JSON.stringify(results));
  console.log(`PASS 3/3 languages; evidence=${evidence}; isolatedAgentDir=${agentDir}`);
} finally { await browser.close(); }
