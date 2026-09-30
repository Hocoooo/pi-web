// Real browser, isolated API fixtures; does not send model prompts or mutate operator sessions.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const base = process.env.E2E_BASE_URL || "http://127.0.0.1:30141";
const browser = await chromium.launch({ headless: true, ...(process.env.E2E_BROWSER_CHANNEL ? { channel: process.env.E2E_BROWSER_CHANNEL } : {}) });
const context = await browser.newContext({ locale: "en-US", viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const errors = [];
const calls = [];
page.on("pageerror", (error) => errors.push(error.message));
const cwd = "/fixtures/agent/chat-workspace";
const chatWorkspace = { cwd, projectRoot: cwd, projectKey: "pi-web:chat", sessionKind: "chat" };
const sessions = [
  ...Array.from({ length: 7 }, (_, index) => ({ ...chatWorkspace, id: `chat-${index}`, name: `Chat day ${index + 1}`, modified: `2026-09-${String(index + 1).padStart(2, "0")}T00:00:00Z` })),
  { id: "project-session", cwd: "/fixtures/project", projectRoot: "/fixtures/project", projectKey: "project", sessionKind: "project", name: "Project session", modified: "2026-09-08T00:00:00Z" },
].map((session) => ({ ...session, path: `/fixtures/${session.id}.jsonl`, created: session.modified, messageCount: 2, firstMessage: session.name }));

await page.route("**/api/**", async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  calls.push({ path: url.pathname, cwd: url.searchParams.get("cwd"), body: request.postDataJSON() });
  let data = {};
  if (url.pathname === "/api/default-cwd") data = chatWorkspace;
  else if (url.pathname === "/api/cwd/validate") {
    const requested = request.postDataJSON().cwd;
    data = requested === cwd ? chatWorkspace : { cwd: requested, projectRoot: requested, projectKey: "project" };
  } else if (url.pathname === "/api/sessions") data = { sessions, sessionListVersion: 1, runningSessionIds: [] };
  else if (url.pathname === "/api/agent/running") data = { runningSessionIds: [], sessionListVersion: 1 };
  else if (url.pathname === "/api/models") data = { models: {}, modelList: [] };
  else if (url.pathname === "/api/home") data = { home: "/fixtures" };
  else if (url.pathname === "/api/worktrees") {
    const projectCwd = url.searchParams.get("cwd");
    data = { projectRoot: projectCwd, projectKey: projectCwd === cwd ? "pi-web:chat" : "project", isGit: true, isTopLevel: true, currentWorktreePath: projectCwd, worktrees: [{ path: projectCwd, branch: "fixture-main", isMain: true }] };
  } else if (url.pathname.startsWith("/api/sessions/")) {
    const info = sessions.find((session) => url.pathname.includes(session.id));
    data = { sessionId: info?.id, info, context: { messages: [], entryIds: [], hasMore: false }, tree: [], toolNames: [] };
  } else if (url.pathname.startsWith("/api/agent/")) data = { running: false, success: true, data: [] };
  else if (url.pathname.startsWith("/api/files")) data = { entries: [] };
  await route.fulfill({ json: data });
});

try {
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForURL(/chat=1/);
  await page.locator("textarea").first().waitFor();
  await page.getByText("Chat day 1", { exact: true }).waitFor();
  // Parity: a chat session renders the same chrome as a project session.
  assert.equal(await page.getByText("Project session", { exact: true }).count(), 0, "current mode lists only the selected workspace");
  assert.equal(await page.getByText("Explorer", { exact: true }).count(), 1, "chat shows the file Explorer");
  const picker = page.getByRole("combobox", { name: "Session project", exact: true });
  await picker.waitFor({ timeout: 10000 });
  assert.equal(await picker.locator("option:checked").textContent(), "No project", "chat composer shows the same project picker");
  const toolButton = page.getByRole("button", { name: "Change tool preset", exact: true });
  assert.equal(await toolButton.count(), 1, "chat shows the same tool preset control as a project");
  assert.equal(await toolButton.isDisabled(), false, "chat tool preset is a normal editable control");
  assert.equal(calls.some((call) => call.path === "/api/worktrees" && call.cwd === cwd), true, "chat loads the same worktree state as a project");
  assert.equal(calls.some((call) => call.path === "/api/agent/new"), false, "opening a composer does not create an agent");

  await page.getByText("Chat day 1", { exact: true }).click();
  await page.waitForURL(/session=chat-0/);
  await page.reload({ waitUntil: "networkidle" });
  await page.getByText("Chat day 1", { exact: true }).waitFor();
  assert.equal(page.url().includes("session=chat-0"), true);
  assert.equal(await page.getByText("Explorer", { exact: true }).count(), 1);
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.waitForURL(/chat=1/);
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("textarea").first().waitFor();
  await page.getByText("Chat day 1", { exact: true }).waitFor();

  const settings = page.getByRole("button", { name: "Settings", exact: true });
  await settings.click();
  await page.getByRole("switch", { name: "Show all projects", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.getByText("Project session", { exact: true }).waitFor();
  // Chat is previewed like any project: newest families first, oldest behind "more".
  await page.getByText("Chat day 7", { exact: true }).waitFor();
  // The chat workspace is an ordinary project row: real path, not a "Chats" label.
  assert.equal(await page.locator('button[data-sidebar-row="project:pi-web:chat"]').getAttribute("title"), "Chats");
  await page.getByText("Project session", { exact: true }).click();
  await page.waitForURL(/session=project-session/);
  await page.getByText("Explorer", { exact: true }).waitFor();
  await page.getByRole("button", { name: "New", exact: true }).click();
  const projectPicker = page.getByRole("combobox", { name: "Session project", exact: true });
  await projectPicker.waitFor({ timeout: 10000 });
  await projectPicker.selectOption({ label: "No project" });
  await page.waitForURL(/chat=1/);
  assert.equal(await page.getByText("Explorer", { exact: true }).count(), 1, "returning to chat keeps the same chrome");
  assert.deepEqual(errors, []);
  console.log("PASS: chat keeps cross-date history and renders the same UI as a project session");
} finally {
  await browser.close();
}
