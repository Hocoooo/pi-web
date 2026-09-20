// Uses an existing dev server and isolated browser/API fixtures; never mutates real sessions.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.E2E_BASE_URL || "http://127.0.0.1:30141";
const isGit = process.env.E2E_SIDEBAR_NON_GIT !== "1";
const browser = await chromium.launch({ headless: true, ...(process.env.E2E_BROWSER_CHANNEL ? { channel: process.env.E2E_BROWSER_CHANNEL } : {}) });
const context = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const sessions = [
  { id: "sidebar-alpha", cwd: "/fixtures/alpha", projectRoot: "/fixtures/alpha", projectKey: "alpha", name: "Alpha session", modified: "2026-08-23T00:00:00Z" },
  { id: "sidebar-beta", cwd: "/fixtures/beta", projectRoot: "/fixtures/beta", projectKey: "beta", name: "Beta session", modified: "2026-08-22T00:00:00Z" },
].map((session) => ({ ...session, created: session.modified, messageCount: 1, firstMessage: session.name, path: `/fixtures/${session.id}.jsonl` }));

await page.route("**/api/**", async (route) => {
  const url = new URL(route.request().url());
  let data = {};
  if (url.pathname === "/api/sessions") data = { sessions, sessionListVersion: 1, runningSessionIds: [], completionNotificationSuppressedSessionIds: [] };
  else if (url.pathname === "/api/models") data = { models: [], modelList: [] };
  else if (url.pathname === "/api/agent/running") data = { runningSessionIds: [], sessionListVersion: 1 };
  else if (url.pathname === "/api/home") data = { home: "/home/test" };
  else if (url.pathname === "/api/worktrees") {
    const cwd = url.searchParams.get("cwd");
    data = { projectRoot: cwd, projectKey: cwd.endsWith("alpha") ? "alpha" : "beta", isGit, isTopLevel: isGit, currentWorktreePath: cwd, worktrees: [{ path: cwd, branch: "sidebar-test-branch", isMain: true }] };
  } else if (url.pathname.startsWith("/api/sessions/")) {
    const info = sessions.find((session) => url.pathname.includes(session.id));
    data = { info, context: { messages: [], entryIds: [], hasMore: false }, tree: [] };
  } else if (url.pathname.startsWith("/api/files")) data = { entries: [] };
  await route.fulfill({ json: data });
});

try {
  await page.goto(base, { waitUntil: "networkidle" });
  const alpha = page.getByText("Alpha session", { exact: true });
  const beta = page.getByText("Beta session", { exact: true });
  await alpha.waitFor();
  assert.equal(await beta.count(), 0, "default view contains only the active project");
  const projectSelector = page.locator('button[title^="/fixtures/"]:not([aria-expanded])');
  const branchSelector = page.getByRole("button").filter({ hasText: isGit ? "sidebar-test-branch" : "Git repo root only" });
  await branchSelector.waitFor();
  assert.equal(await projectSelector.count(), 1, "single-project mode keeps the project selector");
  const settings = page.getByRole("button", { name: "Settings", exact: true });
  await settings.click();
  const toggle = page.getByRole("switch", { name: "Show all projects", exact: true });
  assert.equal(await toggle.getAttribute("aria-checked"), "false");
  await toggle.click();
  await page.keyboard.press("Escape");
  await beta.waitFor();
  assert.equal(await projectSelector.count(), 0, "all-project mode hides the project selector");
  assert.equal(await branchSelector.count(), 0, "all-project mode hides the Git branch selector or its fallback");
  await page.getByRole("button", { name: "Custom path…", exact: true }).click();
  const directoryPicker = page.getByRole("dialog");
  await directoryPicker.waitFor();
  await directoryPicker.getByRole("button", { name: "Cancel", exact: true }).click();
  const project = (name) => page.locator(`button[aria-expanded][title="/fixtures/${name}"]`);
  const originalUrl = page.url();
  await project("beta").click();
  assert.equal(await beta.count(), 0);
  assert.equal(await project("beta").getAttribute("aria-expanded"), "false");
  assert.equal(page.url(), originalUrl, "folding does not navigate");
  await alpha.waitFor();
  await page.reload({ waitUntil: "networkidle" });
  await project("beta").waitFor();
  assert.equal(await project("beta").getAttribute("aria-expanded"), "false", "collapse survives refresh");
  await project("alpha").click();
  assert.equal(await alpha.count(), 0, "the active project can remain manually collapsed");
  await project("beta").click();
  await beta.waitFor();
  await beta.click();
  await page.waitForURL(/sidebar-beta/);
  assert.equal(await project("alpha").getAttribute("aria-expanded"), "false", "selection preserves other groups' state");
  await settings.click();
  assert.equal(await toggle.getAttribute("aria-checked"), "true");
  await toggle.click();
  await page.keyboard.press("Escape");
  await beta.waitFor();
  assert.equal(await project("beta").count(), 0);
  await branchSelector.waitFor();
  assert.equal(await projectSelector.count(), 1, "returning to single-project mode restores the project selector");
  assert.equal(await alpha.count(), 0, "switching back filters to the newly active project");
  await page.reload({ waitUntil: "networkidle" });
  await beta.waitFor();
  assert.equal(await project("beta").count(), 0, "current-project mode also persists");
  assert.deepEqual(errors, []);
  console.log(`PASS (${isGit ? "Git" : "non-Git"}): selector visibility, directory picker access, default mode, live settings toggle, independent folding, persistence, cross-project selection, and return to original view`);
} finally {
  await browser.close();
}
