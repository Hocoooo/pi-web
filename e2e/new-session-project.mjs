// Isolated API fixtures: does not create or change real sessions.
import assert from "node:assert/strict";
import { chromium } from "playwright";
const browser = await chromium.launch({ headless: true, ...(process.env.E2E_BROWSER_CHANNEL ? { channel: process.env.E2E_BROWSER_CHANNEL } : {}) });
const page = await browser.newPage({ locale: "en-US" });
const sessions = ["alpha", "beta"].map((name) => ({ id: name, name, cwd: `/fixtures/${name}`, projectRoot: `/fixtures/${name}`, projectKey: name, modified: "2026-08-23", created: "2026-08-23", messageCount: 1, firstMessage: name }));
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/api/**", async (route) => {
  const url = new URL(route.request().url());
  let data = {};
  if (url.pathname === "/api/sessions") data = { sessions, runningSessionIds: [] };
  else if (url.pathname === "/api/models") data = { models: [], modelList: [] };
  else if (url.pathname === "/api/agent/running") data = { runningSessionIds: [] };
  else if (url.pathname === "/api/worktrees") { const cwd = url.searchParams.get("cwd"); data = { projectRoot: cwd, projectKey: cwd.split("/").at(-1), isGit: false, worktrees: [] }; }
  else if (url.pathname === "/api/cwd/validate") { const { cwd } = route.request().postDataJSON(); data = { cwd, projectRoot: cwd, projectKey: cwd.split("/").at(-1) }; }
  else if (url.pathname.startsWith("/api/sessions/")) data = { info: sessions.find((s) => url.pathname.includes(s.id)), context: { messages: [], entryIds: [] }, tree: [] };
  await route.fulfill({ json: data });
});
try {
  await page.goto(process.env.E2E_BASE_URL || "http://127.0.0.1:30141", { waitUntil: "networkidle" });
  await page.locator("textarea").first().waitFor();
  assert.equal(await page.getByRole("combobox", { name: "Session project", exact: true }).count(), 0, "current-project view hides the fresh composer project picker");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("switch", { name: "Show all projects", exact: true }).click();
  await page.keyboard.press("Escape");
  const picker = page.getByRole("combobox", { name: "Session project", exact: true });
  await picker.waitFor({ timeout: 10000 });
  assert.equal(await picker.inputValue(), "/fixtures/alpha");
  const input = page.locator("textarea").first();
  await input.fill("keep this draft");
  await picker.selectOption("/fixtures/beta");
  await page.waitForFunction(() => document.querySelector('[aria-label="Session project"]')?.value === "/fixtures/beta");
  assert.equal(await input.inputValue(), "keep this draft", "changing the project preserves the unsent message");
  assert.equal(new URL(page.url()).searchParams.has("session"), false, "project change must not restore an old session");
  await picker.selectOption("/fixtures/alpha");
  await page.waitForFunction(() => document.querySelector('[aria-label="Session project"]')?.value === "/fixtures/alpha");
  assert.equal(await input.inputValue(), "keep this draft");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("switch", { name: "Show all projects", exact: true }).click();
  await page.keyboard.press("Escape");
  await picker.waitFor({ state: "detached" });
  assert.equal(await input.inputValue(), "keep this draft", "hiding the picker preserves the draft");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("switch", { name: "Show all projects", exact: true }).click();
  await page.keyboard.press("Escape");
  await picker.waitFor();
  assert.equal(await picker.inputValue(), "/fixtures/alpha", "showing the picker preserves the project");
  await page.setViewportSize({ width: 390, height: 844 });
  await picker.waitFor({ state: "visible" });
  const box = await picker.boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 390, "project picker fits on mobile");
  const createRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/agent/new", { timeout: 10000 });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  assert.equal((await createRequest).postDataJSON().cwd, "/fixtures/alpha", "new runtime uses the chosen directory");
  assert.deepEqual(errors, []);
  console.log("PASS: all-project fresh composer shows its project, switches both ways, preserves draft and stays new");
} finally { await browser.close(); }
