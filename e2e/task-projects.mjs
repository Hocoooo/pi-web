import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";

// Full Dashboard UI + real task HTTP handlers/store, isolated from the dev server's data.
const root = await mkdtemp(join(tmpdir(), "task-project-ui-"));
const agentDir = join(root, "agent"), known = join(root, "existing-project");
await mkdir(agentDir); await mkdir(known);
process.env.PI_CODING_AGENT_DIR = agentDir;
const native = SessionManager.create(known, join(agentDir, "sessions", "fixture"));
native.appendMessage({ role: "user", content: "A project conversation", timestamp: Date.now() });
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { GET, POST } = await jiti.import("../app/api/tasks/route.ts");
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
await context.addInitScript(() => localStorage.setItem("pi-locale", "en"));
let agentWrites = 0, loseNextSave = false, failProjects = false;
const changeRequests = [];
const errors = [];
await context.route("**/api/**", async route => {
  const request = route.request(), url = new URL(request.url());
  if (url.pathname === "/api/tasks") {
    const input = request.method() === "GET" ? null : request.postDataJSON();
    if (input?.action === "projects" && failProjects) return route.fulfill({ status: 503, json: { error: "Projects temporarily unavailable" } });
    if (input?.action === "change-project") changeRequests.push(input);
    const response = request.method() === "GET" ? await GET() : await POST(new Request(request.url(), { method: "POST", body: request.postData() }));
    if (input?.action === "change-project" && loseNextSave && response.ok) { loseNextSave = false; return route.abort("failed"); }
    return route.fulfill({ status: response.status, contentType: "application/json", body: await response.text() });
  }
  if (url.pathname.startsWith("/api/agent/") && request.method() === "POST") agentWrites++;
  const fixtures = {
    "/api/sessions": { sessions: [], runningSessionIds: [] }, "/api/agent/running": { runningSessionIds: [] },
    "/api/default-cwd": { cwd: join(agentDir, "chat-workspace"), projectKey: "pi-web:chat", sessionKind: "chat" },
    "/api/home": { home: root }, "/api/models": { models: [], modelList: [], defaultModel: null },
    "/api/web-auth": { enabled: false }, "/api/subagents/settings": { enabled: false },
  };
  return route.fulfill({ json: fixtures[url.pathname] ?? {} });
});
const page = await context.newPage();
page.on("pageerror", error => errors.push(error.message));
try {
  await page.goto(process.env.E2E_BASE_URL || "http://127.0.0.1:30142");
  await page.getByRole("button", { name: "Task dashboard", exact: true }).click();
  const dashboard = page.getByRole("dialog", { name: "Task dashboard", exact: true });
  await dashboard.getByRole("button", { name: "New task", exact: true }).click();
  await dashboard.getByLabel("Title", { exact: true }).fill("Pick an existing project");
  const project = dashboard.getByRole("combobox", { name: "Project directory (optional)", exact: true });
  await project.selectOption({ label: `existing-project · ${known}` }, { timeout: 5000 });
  await dashboard.getByRole("button", { name: "Create task", exact: true }).click();
  await dashboard.getByRole("button", { name: "Pick an existing project", exact: true }).waitFor();
  const board = await (await GET()).json();
  assert.equal(board.tasks.find(t => t.title === "Pick an existing project").project.cwd, known);
  const task = board.tasks.find(t => t.title === "Pick an existing project");
  await POST(new Request("http://localhost/api/tasks", { method: "POST", body: JSON.stringify({ action: "link", id: task.id, expectedRevision: task.revision, sessionIds: [native.getSessionId()] }) }));
  await dashboard.getByRole("button", { name: "Refresh", exact: true }).click();
  await dashboard.getByRole("button", { name: "Pick an existing project", exact: true }).click();
  const inspector = dashboard.locator("[data-task-inspector]:visible");
  await inspector.getByRole("button", { name: "Change project", exact: true }).click({ timeout: 5000 });
  await inspector.getByRole("combobox", { name: "Project directory (optional)", exact: true }).selectOption("");
  await inspector.getByRole("button", { name: "Save project", exact: true }).click();
  await inspector.getByText("1 chat will be unlinked. Chats will not be deleted or stopped.", { exact: true }).waitFor();
  await inspector.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal((await (await GET()).json()).tasks.find(t => t.id === task.id).project.cwd, known);
  await inspector.getByRole("button", { name: "Change project", exact: true }).click();
  await inspector.getByRole("combobox", { name: "Project directory (optional)", exact: true }).selectOption("");
  await inspector.getByRole("button", { name: "Save project", exact: true }).click();
  await inspector.getByRole("button", { name: "Change project and unlink", exact: true }).click();
  await inspector.getByRole("button", { name: "Change project", exact: true }).waitFor();
  const changed = (await (await GET()).json()).tasks.find(t => t.id === task.id);
  assert.equal(changed.project, null);
  assert.deepEqual(changed.sessionIds, []);
  failProjects = true;
  await inspector.getByRole("button", { name: "Change project", exact: true }).click();
  await inspector.getByRole("alert").filter({ hasText: "Projects temporarily unavailable" }).waitFor();
  failProjects = false;
  await inspector.getByRole("button", { name: "Refresh", exact: true }).click();
  await inspector.getByRole("combobox", { name: "Project directory (optional)", exact: true }).selectOption(known);
  loseNextSave = true;
  await inspector.getByRole("button", { name: "Save project", exact: true }).click();
  await inspector.getByRole("alert").waitFor();
  assert.equal(await inspector.getByRole("combobox", { name: "Project directory (optional)", exact: true }).inputValue(), known);
  await inspector.getByRole("button", { name: "Save project", exact: true }).click();
  await inspector.getByRole("button", { name: "Change project", exact: true }).waitFor();
  assert.deepEqual(changeRequests.at(-1), changeRequests.at(-2), "lost-response retries retain the exact request");
  assert.equal((await (await GET()).json()).tasks.find(t => t.id === task.id).project.cwd, known);
  assert.equal(agentWrites, 0);
  assert.deepEqual(errors, []);
  console.log("PASS Dashboard project selection, cancel/confirm unlink, listing failure, lost-response retry; no Agent writes");
} catch (error) {
  await page.screenshot({ path: join(root, "failure.png"), fullPage: true });
  console.error(`UI evidence: ${root}`);
  throw error;
} finally {
  await browser.close();
  await rm(agentDir, { recursive: true, force: true });
}
