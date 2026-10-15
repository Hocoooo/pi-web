import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { createJiti } from "jiti";

// Reuse a healthy checkout dev server. Every API is intercepted; only temporary
// task data is created, and no real session, agent, provider, or settings are used.
const base = process.env.E2E_BASE_URL || "http://127.0.0.1:30142";
const root = await mkdtemp(path.join(os.tmpdir(), "task-appearance-"));
const agentDir = path.join(root, "agent");
await mkdir(agentDir);
const { taskOperation } = await createJiti(import.meta.url).import("../lib/task-operations.ts");
for (const title of ["Daily appearance fixture", "Archived appearance fixture"]) {
  await taskOperation({ action: "create", id: randomUUID(), title, description: "", completionCriteria: "", cwd: null }, { agentDir });
}
const board = await taskOperation({ action: "list" }, { agentDir });
board.tasks.find(task => task.title.startsWith("Archived")).archived = true;
const browser = await chromium.launch();
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce", hasTouch: width === 390 });
    await context.addInitScript(() => {
      localStorage.setItem("pi-locale", "en");
      if (!localStorage.getItem("pi-theme")) localStorage.setItem("pi-theme", "pine");
    });
    const unexpected = [], errors = [];
    await context.route("**/api/**", async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() !== "GET" && !["/api/default-cwd", "/api/cwd/validate"].includes(url.pathname)) unexpected.push(`${request.method()} ${url.pathname}`);
      const fixtures = {
        "/api/tasks": board,
        "/api/sessions": { sessions: [], runningSessionIds: [] },
        "/api/agent/running": { runningSessionIds: [] },
        "/api/models": { models: [], modelList: [], defaultModel: null },
        "/api/web-auth": { enabled: false },
        "/api/subagents/settings": { enabled: false },
        "/api/home": { home: root },
        "/api/default-cwd": { cwd: root, projectRoot: root, projectKey: "pi-web:chat", sessionKind: "chat" },
        "/api/cwd/validate": { valid: true, cwd: root, projectRoot: root, projectKey: "pi-web:chat", sessionKind: "chat" },
      };
      await route.fulfill({ json: fixtures[url.pathname] ?? {} });
    });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    try {
      for (const theme of ["pine", "light", "dark", "mist", "rose"]) {
        await page.goto(base);
        await page.evaluate(value => localStorage.setItem("pi-theme", value), theme);
        await page.reload();
        await page.waitForFunction(value => document.documentElement.dataset.theme === value, theme);
        if (width === 390) await page.getByRole("button", { name: "Show sidebar", exact: true }).click();
        await page.getByRole("button", { name: "Task dashboard", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "Task dashboard", exact: true });
        const picker = dialog.getByRole("combobox", { name: "Task list", exact: true });
        await picker.click();
        const list = dialog.getByRole("listbox", { name: "Task list", exact: true });
        await list.waitFor({ timeout: 2000 });
        assert.equal(await picker.getAttribute("aria-expanded"), "true");
        const palette = await list.evaluate(node => {
          const style = getComputedStyle(node);
          const rgb = token => {
            const probe = document.createElement("span");
            probe.style.color = `var(${token})`;
            node.append(probe);
            const color = getComputedStyle(probe).color;
            probe.remove();
            return color;
          };
          return { background: style.backgroundColor, color: style.color, border: style.borderTopColor,
            expectedBackground: rgb("--bg-panel"), expectedColor: rgb("--text"), expectedBorder: rgb("--border") };
        });
        assert.equal(palette.background, palette.expectedBackground, `${theme}: popup background follows palette`);
        assert.equal(palette.color, palette.expectedColor, `${theme}: popup text follows palette`);
        assert.equal(palette.border, palette.expectedBorder, `${theme}: popup border follows palette`);
        const bounds = await list.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, "popup fits viewport");
        assert.equal(await list.getByRole("option", { selected: true }).locator("span").first().textContent(), "Daily tasks");
        await list.getByRole("option", { name: "Archived (1)", exact: true }).click();
        await list.waitFor({ state: "detached" });
        await dialog.getByRole("button", { name: "Archived appearance fixture", exact: true }).waitFor();
        assert.equal(await dialog.getByRole("button", { name: "Daily appearance fixture", exact: true }).count(), 0);
        assert.equal(await picker.evaluate(node => node === document.activeElement), true);
        await picker.press("ArrowDown");
        await list.waitFor();
        await picker.press("End");
        await picker.press("Enter");
        assert.equal(await dialog.locator("[data-task-card]").count(), 2, "All tasks still includes archived tasks");
        await picker.press("Space");
        await list.waitFor();
        await picker.dispatchEvent("keydown", { key: "Escape", isComposing: true });
        assert.equal(await list.isVisible(), true, "IME Escape does not dismiss");
        await picker.press("Escape");
        await list.waitFor({ state: "detached" });
        assert.equal(await dialog.isVisible(), true, "Escape closes popup, not dashboard");
        await picker.press("ArrowUp");
        await picker.press("Home");
        await picker.press("Enter");
        await dialog.getByRole("button", { name: "Daily appearance fixture", exact: true }).waitFor();
        assert.equal(await dialog.locator("[data-task-card]").count(), 1);
        await picker.click();
        await picker.press("Tab");
        await list.waitFor({ state: "detached" });
        await picker.click();
        await dialog.getByRole("heading", { name: "Task dashboard", exact: true }).click();
        await list.waitFor({ state: "detached" });
        await picker.click();
        await page.screenshot({ path: path.join(root, `${theme}-${width}.png`) });
        await dialog.getByRole("button", { name: "Close task dashboard", exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
        await page.getByRole("button", { name: "Task dashboard", exact: true }).click();
        assert.equal(await picker.getAttribute("aria-expanded"), "false", "reopening dashboard does not reopen popup");
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "hidden" });
        console.log(`PASS ${theme} ${width}px: themed popup, scopes/count, keyboard, IME, dismissal, focus`);
      }
      assert.deepEqual(unexpected, [], "appearance and scope selection never write task, agent, or settings APIs");
      assert.deepEqual(errors, []);
    } catch (error) {
      await page.screenshot({ path: path.join(root, `failure-${width}.png`) }).catch(() => {});
      throw error;
    } finally { await context.close(); }
  }
} finally {
  await browser.close();
  console.log(`Artifacts: ${root}`);
}
