// Existing dev server, isolated browser/API fixtures; never writes real sessions.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.E2E_BASE_URL || "http://127.0.0.1:30141";
const root = "E:\\fixtures\\benchmark";
const nested = `${root}\\benchmark-runs\\case-01`;
const sessions = [
  { id: "benchmark-run", cwd: nested, name: "Benchmark run" },
  { id: "previous-session", cwd: root, name: "Previous session" },
].map((s) => ({ ...s, projectRoot: s.cwd, projectKey: s.cwd.toLowerCase(),
  path: `${s.cwd}\\session.jsonl`, created: "2026-01-01T00:00:00Z",
  modified: "2026-01-01T00:00:00Z", messageCount: 1, firstMessage: s.name }));
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ locale: "en-US", viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/api/**", async (route) => {
  const url = new URL(route.request().url());
  let data = {};
  if (url.pathname === "/api/sessions") data = { sessions, sessionListVersion: 1, runningSessionIds: [] };
  else if (url.pathname === "/api/agent/running") data = { runningSessionIds: [], sessionListVersion: 1 };
  else if (url.pathname === "/api/models") data = { models: [], modelList: [] };
  else if (url.pathname === "/api/home") data = { home: "E:\\fixtures" };
  else if (url.pathname === "/api/worktrees") {
    const cwd = url.searchParams.get("cwd");
    // As on the real server: subdirectories retain their own project identity,
    // but Git still lists the containing repository's worktrees.
    data = { projectRoot: cwd, projectKey: cwd.toLowerCase(), isGit: true,
      isTopLevel: cwd === root, currentWorktreePath: cwd === root ? root : null,
      worktrees: [{ path: root, branch: "main", isMain: true }] };
    // Keep the old worktree cache observable while the selected cwd changes.
    if (cwd === root) await new Promise((resolve) => setTimeout(resolve, 300));
  } else if (url.pathname.startsWith("/api/sessions/")) {
    const info = sessions.find((s) => url.pathname.includes(s.id));
    data = { info, context: { messages: [], entryIds: [], hasMore: false }, tree: [] };
  } else if (url.pathname.startsWith("/api/files")) data = { entries: [] };
  await route.fulfill({ json: data });
});
try {
  await page.goto(`${base}/?session=benchmark-run`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const toggle = page.getByRole("switch", { name: "Show all projects", exact: true });
  if (await toggle.getAttribute("aria-checked") === "false") await toggle.click();
  await page.keyboard.press("Escape");
  for (let cycle = 0; cycle < 3; cycle++) {
    await page.getByText("Previous session", { exact: true }).click();
    await page.waitForTimeout(1000);
    assert.equal(new URL(page.url()).searchParams.get("session"), "previous-session",
      "selecting a repo session from a benchmark subdirectory must retain its session URL");
    if (cycle < 2) {
      await page.getByText("Benchmark run", { exact: true }).click();
      await page.waitForTimeout(500);
      assert.equal(new URL(page.url()).searchParams.get("session"), "benchmark-run");
    }
  }
  await page.reload({ waitUntil: "networkidle" });
  assert.equal(new URL(page.url()).searchParams.get("session"), "previous-session");
  assert.deepEqual(errors, []);
  console.log("PASS: benchmark subdirectory → repository session navigation and reload");
} finally {
  await browser.close();
}
