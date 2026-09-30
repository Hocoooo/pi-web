// Against an already-running checkout: PI_WEB_TEST_URL=http://127.0.0.1:30142
// All session data and mutations are intercepted; no real sessions are changed.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const cwd = "E:/keyboard-fixture";
  const sessions = Array.from({ length: 80 }, (_, i) => ({
    id: `keyboard-${i}`, path: `${cwd}/${i}.jsonl`, cwd, projectRoot: cwd, projectKey: cwd.toLowerCase(),
    name: `Keyboard session ${i}`, firstMessage: `Keyboard session ${i}`, messageCount: 1,
    created: "2026-01-01T00:00:00.000Z", modified: new Date(Date.UTC(2026, 0, 1, 0, 80 - i)).toISOString(),
  }));
  const mutations = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body, status = 200) => route.fulfill({ status, json: body });
    if (request.method() !== "GET") {
      mutations.push({ method: request.method(), path: url.pathname });
      return json({ ok: true });
    }
    if (url.pathname === "/api/sessions") return json({ sessions, sessionListVersion: 1 });
    if (url.pathname.startsWith("/api/sessions/")) {
      const info = sessions.find((session) => session.id === url.pathname.split("/")[3]);
      return json({ info, leafId: null, tree: [], context: { messages: [], entryIds: [] } });
    }
    if (url.pathname === "/api/agent/running") return json({ sessionIds: [] });
    if (url.pathname.startsWith("/api/agent/")) return json({ error: "Not running" }, 404);
    if (url.pathname === "/api/worktrees") return json({ forCwd: cwd, projectRoot: cwd, projectKey: cwd.toLowerCase(), isGit: false, isTopLevel: true, worktrees: [] });
    if (url.pathname === "/api/project-trust") return json({ trusted: true, requiresTrust: false });
    if (url.pathname === "/api/files") return json({ entries: [] });
    return route.continue();
  });
  const base = process.env.PI_WEB_TEST_URL || "http://127.0.0.1:30142";
  await page.goto(`${base}/?session=keyboard-0`);
  await page.getByText("Keyboard session 0", { exact: true }).waitFor();
  const waitForRow = (id) => page.waitForFunction((key) => document.activeElement?.getAttribute("data-sidebar-row") === key, `session:keyboard-${id}`);
  await page.getByRole("button", { name: /^(隐藏侧边栏|隱藏側邊欄|Hide sidebar)$/ }).click();
  await page.keyboard.press("Alt+ArrowLeft");
  await waitForRow(0);
  await page.keyboard.press("ArrowDown");
  await waitForRow(1);
  await page.keyboard.press("End");
  await waitForRow(79);
  await page.keyboard.press("Home");
  await waitForRow(0);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForURL(/session=keyboard-1/);
  await page.keyboard.press("Alt+ArrowRight");
  await page.waitForFunction(() => document.activeElement?.matches("textarea.chat-input-textarea"));
  await page.keyboard.type("draft kept");
  await page.evaluate(() => {
    const dialog = document.createElement("dialog");
    dialog.id = "keyboard-test-modal";
    dialog.innerHTML = '<input id="keyboard-test-modal-input">';
    document.body.append(dialog);
    dialog.showModal();
  });
  await page.keyboard.press("Alt+ArrowRight");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "keyboard-test-modal-input");
  await page.evaluate(() => document.getElementById("keyboard-test-modal").remove());
  await page.keyboard.press("Alt+ArrowLeft");
  await waitForRow(1);
  await page.keyboard.press("Delete");
  await page.waitForFunction(() => document.activeElement?.tagName === "BUTTON" && document.activeElement.closest('[data-sidebar-row="session:keyboard-1"]'));
  assert.equal(mutations.filter((item) => item.method === "DELETE").length, 0, "Delete requires confirmation");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Alt+ArrowRight");
  await page.waitForFunction(() => document.activeElement?.matches("textarea.chat-input-textarea"));
  assert.equal(await page.locator("textarea.chat-input-textarea").first().inputValue(), "draft kept");
  // Verify project headings and preview controls in all-projects mode.
  await page.evaluate(() => localStorage.setItem("pi-web:sidebar-view", JSON.stringify({ mode: "all", collapsedProjects: [] })));
  await page.reload();
  await page.getByText("Keyboard session 1", { exact: true }).waitFor();
  await page.keyboard.press("Alt+ArrowLeft");
  await waitForRow(1);
  await page.keyboard.press("Home");
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-sidebar-row")?.startsWith("project:"));
  await page.keyboard.press("ArrowLeft");
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-expanded") === "false");
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-expanded") === "true");
  await page.keyboard.press("End");
  await page.waitForFunction(() => document.activeElement?.getAttribute("data-sidebar-row")?.startsWith("more:"));
  await page.keyboard.press("ArrowRight");
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-expanded") === "true");
  await page.keyboard.press("ArrowUp");
  await waitForRow(79);
  await page.keyboard.press("Enter");
  await page.waitForURL(/session=keyboard-79/);
  // Reload resets expanded previews. Alt+Left must reveal the selected session.
  await page.reload();
  await page.getByText("Keyboard session 0", { exact: true }).waitFor();
  await page.keyboard.press("Alt+ArrowLeft");
  await waitForRow(79);
  console.log("PASS: panel switching, virtual navigation, activation, draft preservation, delete confirmation, project/preview expansion, selected-session reveal");
} finally {
  await browser.close();
}
