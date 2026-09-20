// Reuse an existing local dev server. All desktop launches are intercepted.
// Session fixture changes are response-only; no session files are modified.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.PI_WEB_TEST_URL || "http://localhost:30141";
const browser = await chromium.launch({ headless: true, ...(process.env.PI_WEB_TEST_BROWSER_CHANNEL ? { channel: process.env.PI_WEB_TEST_BROWSER_CHANNEL } : {}) });
try {
  const page = await browser.newPage();
  const list = await (await page.request.get(`${base}/api/sessions`)).json();
  const session = list.sessions.find((s) => /pi-web$/i.test(s.cwd) && !list.runningSessionIds?.includes(s.id));
  assert.ok(session, "Need an existing idle pi-web session for this read-only browser check");
  const filePath = `${session.cwd.replaceAll("\\", "/")}/lib/file-links.ts`;
  await page.route(`**/api/sessions/${session.id}**`, async (route) => {
    if (route.request().method() !== "GET") return route.abort();
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("/state")) return route.fulfill({ json: { running: false } });
    if (pathname !== `/api/sessions/${session.id}`) return route.continue();
    const response = await route.fetch();
    const data = await response.json();
    data.context.messages = [
      { role: "user", content: "Local file link interaction fixture", timestamp: Date.now() },
      { role: "assistant", content: [{ type: "text", text: `[Desktop relative](lib/file-links.ts)\n\n[Desktop absolute](${filePath})\n\n[External website](https://example.com)` }], timestamp: Date.now(), stopReason: "stop", provider: "test", model: "test", usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
    ];
    data.context.entryIds = ["desktop-user", "desktop-assistant"];
    data.context.hasMore = false;
    data.tree = [];
    data.leafId = null;
    await route.fulfill({ json: data });
  });
  // This check must never send prompts or modify runtime state.
  await page.route("**/api/agent/**", (route) => route.request().method() === "GET" ? route.continue() : route.abort());
  const calls = [];
  let fail = false;
  await page.route("**/api/files/desktop", async (route) => {
    calls.push(route.request().postDataJSON());
    await route.fulfill({ status: fail ? 500 : 200, json: fail ? { error: "Test default application unavailable" } : { success: true } });
  });
  await page.goto(`${base}/?session=${encodeURIComponent(session.id)}`);
  const link = page.getByRole("link", { name: "Desktop relative", exact: true });
  await link.waitFor({ timeout: 30_000 });
  await link.click({ button: "right" });
  const menu = page.getByRole("menu");
  await menu.waitFor();
  assert.equal(await menu.getByRole("menuitem").count(), 2);
  await menu.getByRole("menuitem").nth(0).click();
  await menu.waitFor({ state: "hidden" });
  assert.deepEqual(calls.at(-1), { filePath, sessionId: session.id, action: "open" });
  await page.getByRole("link", { name: "Desktop absolute", exact: true }).click({ button: "right" });
  await menu.getByRole("menuitem").nth(1).click();
  await menu.waitFor({ state: "hidden" });
  assert.deepEqual(calls.at(-1), { filePath, sessionId: session.id, action: "reveal" });
  fail = true;
  await link.click({ button: "right" });
  await menu.getByRole("menuitem").nth(0).click();
  await page.getByRole("alert").filter({ hasText: "Test default application unavailable" }).waitFor();
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
  assert.equal(await link.evaluate((el) => el === document.activeElement), true);
  await link.click({ button: "right" });
  await page.keyboard.press("ArrowDown");
  assert.equal(await menu.getByRole("menuitem").nth(1).evaluate((el) => el === document.activeElement), true);
  await page.keyboard.press("Escape");
  await page.getByRole("link", { name: "External website", exact: true }).click({ button: "right" });
  assert.equal(await menu.count(), 0);
  const previewRequest = page.waitForRequest((request) => request.url().includes("/api/files/") && request.url().includes("file-links.ts"));
  await link.click({ modifiers: ["Control"] });
  await previewRequest;
  assert.equal(calls.length, 3, "Ctrl click must not invoke the system launcher");
  console.log("PASS: relative/absolute context menus, both actions, error display, Escape/focus, keyboard navigation, external links, Ctrl-click preview; OS launches mocked.");
} finally {
  await browser.close();
}
