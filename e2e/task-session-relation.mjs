// All HTTP APIs are fixtures; real SDK/store/runtime busy projection, no model/network/history outside temporary data.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
const base = process.env.E2E_BASE_URL || "http://127.0.0.1:30142";
const evidence = process.env.E2E_ARTIFACT_DIR || await mkdtemp(join(tmpdir(), "b10-")); await mkdir(evidence, { recursive: true });
const agentDir = await mkdtemp(join(tmpdir(), "br10-")), cwd = join(agentDir, "chat-workspace"); await mkdir(cwd);
const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { taskOperation } = await jiti.import("../lib/task-operations.ts");
const { AgentSessionWrapper } = await jiti.import("../lib/rpc-manager.ts");
const op = input => taskOperation(input, { agentDir });
const source = SessionManager.create(cwd, join(agentDir, "sessions", "chat"));
source.appendMessage({ role: "user", content: "Synthetic old task text, retained forever", timestamp: Date.now() });
source.appendMessage({ role: "assistant", content: [], stopReason: "stop", api: "fixture", provider: "fixture", model: "fixture", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }); source.appendSessionInfo("Relation chat");
const sourceTask = (await op({ action: "createFromSession", id: randomUUID(), sourceSessionId: source.getSessionId(), title: "Source task A", description: "", completionCriteria: "" })).task;
const targetTask = (await op({ action: "create", id: randomUUID(), title: "Target task B", description: "", completionCriteria: "", cwd: null })).task;
const content = { goal: "Unchosen target context", decisions: "", progress: "", nextSteps: "" };
const targetVersion = (await op({ action: "publish-context", id: targetTask.id, expectedCurrentVersionId: null, operationId: randomUUID(), content })).task.sharedContext.currentVersionId;
const sourceVersion = (await op({ action: "publish-context", id: sourceTask.id, expectedCurrentVersionId: null, operationId: randomUUID(), content: { ...content, goal: "Old pending context" } })).task.sharedContext.currentVersionId;
await op({ action: "accept-context-update", id: sourceTask.id, sessionId: source.getSessionId(), operationId: randomUUID(), expectedRevision: 0, versionId: sourceVersion });
const inner = { sessionManager: source, sessionId: source.getSessionId(), sessionFile: source.getSessionFile(), isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0,
  extensionRunner: { emit: async () => {} }, settingsManager: { getDefaultTools: () => [], getShellPath: () => undefined }, agent: { state: {} }, getActiveToolNames: () => [], getAllTools: () => [], setActiveToolsByName() {}, abort: async () => {}, dispose() {} };
const wrapper = new AgentSessionWrapper(inner); const registry = globalThis.__piSessions ??= new Map(); registry.set(wrapper.sessionId, wrapper); wrapper.onDestroy(() => registry.delete(wrapper.sessionId));
const history = await readFile(source.getSessionFile()), file = join(agentDir, "tasks", "board.json");
const browser = await chromium.launch({ headless: true }), context = await browser.newContext({ viewport: { width: 1360, height: 900 }, hasTouch: true });
await context.addInitScript(() => { localStorage.setItem("pi-locale", "en"); });
const errors = [], calls = [], cases = [];
let fail = false, lose = false;
await context.route("**/api/**", async route => {
  const request = route.request(), url = new URL(request.url()), input = request.method() === "GET" ? { action: "list" } : request.postDataJSON();
  calls.push({ method: request.method(), path: url.pathname, input });
  if (url.pathname === "/api/tasks") {
    if (input.action === "change-session-relation" && fail) { fail = false; return route.fulfill({ status: 503, json: { error: "Fixture storage unavailable", code: "storage-unavailable" } }); }
    try {
      const result = await op(input);
      if (input.action === "change-session-relation" && lose) { lose = false; return route.fulfill({ status: 503, json: { error: "Fixture committed response lost", code: "storage-unavailable" } }); }
      return route.fulfill({ json: result });
    } catch (error) { return route.fulfill({ status: error.code === "conflict" ? 409 : error.code === "not-found" ? 404 : error.code === "invalid-input" ? 400 : 503, json: { error: error.message, code: error.code } }); }
  }
  if (url.pathname === "/api/agent/running") return route.fulfill({ json: { runningSessionIds: [], sessionActivity: {}, sessionListVersion: 1 } }); // deliberately stale idle UI
  errors.push(`Unexpected API ${request.method()} ${url.pathname}`); return route.fulfill({ status: 500, json: { error: "Unexpected API fixture" } });
});
const page = await context.newPage(); page.on("pageerror", e => errors.push(e.message));
const card = (p, id) => p.locator(`[data-task-card="${id}"]`);
const panel = p => p.getByRole("region", { name: "Unlink or reassign chat", exact: true });
async function open(p, id) {
  const c = card(p, id); await c.waitFor();
  if (!await c.locator("details").first().getAttribute("open").then(x => x !== null)) await c.locator("summary").first().click();
  const chats = c.getByRole("button", { name: "Chats (1)", exact: true });
  if (await chats.getAttribute("aria-expanded") !== "true") await chats.click();
  await c.getByRole("button", { name: "Unlink or reassign chat", exact: true }).click(); await panel(p).waitFor();
}
try {
  await page.goto(`${base}/tasks`, { waitUntil: "networkidle" }); await open(page, sourceTask.id);
  assert.ok((await panel(page).innerText()).includes(sourceTask.id)); assert.ok((await panel(page).innerText()).includes("No task (unlink)"));
  assert.ok((await panel(page).innerText()).includes("Old task text remains in native chat history")); assert.ok((await panel(page).innerText()).includes("start a new chat if you need isolation"));
  await panel(page).getByRole("combobox").selectOption(targetTask.id);
  assert.ok((await panel(page).innerText()).includes(targetTask.id)); assert.ok((await panel(page).innerText()).includes(targetVersion)); assert.ok((await panel(page).innerText()).includes("not automatically received"));
  const changes = () => calls.filter(c => c.input?.action === "change-session-relation"); const before = changes().length;
  await panel(page).getByRole("button", { name: "Cancel", exact: true }).click(); assert.equal(changes().length, before); assert.equal((await op({ action: "context-update-state", sessionId: source.getSessionId() })).task.id, sourceTask.id);
  cases.push("source/target UUID and target version / retained-history and new-chat warning / cancel does not mutate");

  await open(page, sourceTask.id); await panel(page).getByRole("combobox").selectOption(targetTask.id);
  inner.pendingMessageCount = 1; await panel(page).getByRole("button", { name: "Confirm relationship change", exact: true }).click();
  await panel(page).getByRole("alert").filter({ hasText: /busy/ }).waitFor(); assert.equal((await op({ action: "context-update-state", sessionId: source.getSessionId() })).task.id, sourceTask.id); inner.pendingMessageCount = 0;
  cases.push("server actual queued work rejects despite stale idle browser / warning and error retained");
  fail = true; await panel(page).getByRole("button", { name: "Retry exact relationship change", exact: true }).click(); await panel(page).getByRole("alert").filter({ hasText: "Fixture storage unavailable" }).waitFor();
  lose = true; await panel(page).getByRole("button", { name: "Retry exact relationship change", exact: true }).click(); await panel(page).getByRole("alert").filter({ hasText: "Fixture committed response lost" }).waitFor();
  const bytes = await readFile(file); const attempts = changes().slice(-3).map(c => c.input); assert.deepEqual(attempts[0], attempts[1]); assert.deepEqual(attempts[1], attempts[2]);
  await page.evaluate(() => window.dispatchEvent(new Event("online"))); await panel(page).waitFor();
  await panel(page).getByRole("button", { name: "Retry exact relationship change", exact: true }).focus(); await page.keyboard.press("Enter");
  await page.getByRole("status").filter({ hasText: "Relationship saved." }).waitFor(); assert.deepEqual(await readFile(file), bytes); assert.deepEqual(changes().at(-1).input, attempts[0]);
  assert.equal((await op({ action: "context-update-state", sessionId: source.getSessionId() })).task.id, targetTask.id); assert.equal((await op({ action: "list" })).tasks.find(t => t.id === sourceTask.id).sessionUpdates[0].pendingOperationId, null);
  assert.deepEqual(await readFile(source.getSessionFile()), history);
  cases.push("storage failure / committed lost-response / online does not rebase / keyboard exact retry confirms without duplicate / count and pending synchronized");

  const second = await context.newPage(); second.on("pageerror", e => errors.push(e.message)); await second.goto(`${base}/tasks`, { waitUntil: "networkidle" });
  await open(page, targetTask.id); await open(second, targetTask.id);
  await panel(page).getByRole("combobox").selectOption(sourceTask.id); await panel(page).getByRole("button", { name: "Confirm relationship change", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Relationship saved." }).waitFor();
  await panel(second).getByRole("button", { name: "Confirm relationship change", exact: true }).click(); await panel(second).getByRole("alert").filter({ hasText: /relationship changed/ }).waitFor();
  await second.evaluate(() => window.dispatchEvent(new Event("focus"))); assert.ok((await panel(second).innerText()).includes(targetTask.id));
  await panel(second).getByRole("button", { name: "Cancel", exact: true }).click(); await second.reload(); await card(second, sourceTask.id).waitFor();
  cases.push("two pages stale source epoch conflict / focus refresh preserves fixed confirmation / explicit cancel and reload resynchronize");

  await page.setViewportSize({ width: 390, height: 844 }); await open(page, sourceTask.id);
  await panel(page).getByRole("combobox").focus(); await page.keyboard.press("Escape"); assert.equal(await panel(page).count(), 0);
  await open(page, sourceTask.id); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(evidence, "relation-mobile-warning.png"), fullPage: true });
  await panel(page).getByRole("button", { name: "Confirm relationship change", exact: true }).tap();
  await page.getByRole("status").filter({ hasText: "Relationship saved." }).waitFor();
  assert.equal((await op({ action: "context-update-state", sessionId: source.getSessionId() })).task, null); assert.deepEqual(await readFile(source.getSessionFile()), history);
  assert.equal((await op({ action: "list" })).tasks.reduce((n, t) => n + t.sessionIds.length, 0), 0);
  cases.push("390px touch unlink / Escape cancellation / native history preserved / zero target context send");
  assert.deepEqual(errors, []); assert.deepEqual(calls.filter(c => c.path.startsWith("/api/agent/") && c.method === "POST"), []);
  await writeFile(join(evidence, "results.json"), JSON.stringify({ cases, calls, errors }, null, 2)); console.log(`PASS ${cases.length} scenarios; evidence=${evidence}`);
} catch (error) { await page.screenshot({ path: join(evidence, "relation-failure.png"), fullPage: true }); await writeFile(join(evidence, "failure.json"), JSON.stringify({ error: String(error), cases, calls, errors }, null, 2)); throw error; }
finally { await browser.close(); await wrapper.shutdown(); await rm(agentDir, { recursive: true, force: true }); if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; }
