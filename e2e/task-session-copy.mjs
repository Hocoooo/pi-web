// Real native SDK copies + task store behind full API fixtures. No provider, no child prompt.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
const base = process.env.E2E_BASE_URL || "http://127.0.0.1:30142";
const evidence = process.env.E2E_ARTIFACT_DIR || await mkdtemp(join(tmpdir(), "copy-browser-")); await mkdir(evidence, { recursive: true });
const agentDir = await mkdtemp(join(tmpdir(), "copy-data-"));
assert.notEqual(spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: agentDir }).status, 0);
const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
const cwd = join(agentDir, "chat-workspace"); await mkdir(cwd);
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { taskOperation } = await jiti.import("../lib/task-operations.ts");
const { AgentSessionWrapper } = await jiti.import("../lib/rpc-manager.ts");
const { listAllSessions } = await jiti.import("../lib/session-reader.ts");
const { GET: sessionGet } = await jiti.import("../app/api/sessions/[id]/route.ts");
const { GET: contextGet } = await jiti.import("../app/api/sessions/[id]/context/route.ts");
const manager = SessionManager.create(cwd);
manager.appendMessage({ role: "user", content: "First synthetic prompt", timestamp: Date.now() });
manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Synthetic finished response for quoting." }], api: "fixture", provider: "fixture", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
manager.appendMessage({ role: "user", content: "Second synthetic prompt", timestamp: Date.now() });
manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Second synthetic completed response." }], api: "fixture", provider: "fixture", model: "fixture", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
manager.appendSessionInfo("Source task chat");
const sourceId = manager.getSessionId(), sourceBytes = await readFile(manager.getSessionFile());
const task = (await taskOperation({ action: "createFromSession", id: randomUUID(), title: "Copy task", description: "", completionCriteria: "", sourceSessionId: sourceId }, { agentDir })).task;
const wrappers = [];
function sourceWrapper() { const w = new AgentSessionWrapper({ sessionId: sourceId, sessionFile: manager.getSessionFile(), sessionManager: manager,
  isStreaming: false, isCompacting: false, isBashRunning: false, agent: { state: {} }, extensionRunner: { emit: async () => {} }, dispose() {},
}); wrappers.push(w); return w; }
let w = sourceWrapper(), loseResponse = false, responseBody, failSDKOnce = false;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
await context.addInitScript(() => { localStorage.setItem("pi-locale", "en"); localStorage.setItem("pi-quote-selection-enabled", "true"); });
const calls = [], errors = [], cases = [], copyBodies = [];
await context.route("**/api/**", async (route) => {
  const req = route.request(), url = new URL(req.url()), body = req.postDataJSON(); calls.push({ path: url.pathname, method: req.method(), body });
  if (url.pathname === "/api/tasks") {
    try { return route.fulfill({ json: await taskOperation(req.method() === "GET" ? { action: "list" } : body, { agentDir }) }); }
    catch (e) { return route.fulfill({ status: 503, json: { error: e.message, code: e.code } }); }
  }
  if (url.pathname === "/api/sessions") return route.fulfill({ json: { sessions: await listAllSessions({ force: true }), sessionListVersion: calls.length, runningSessionIds: [] } });
  const match = url.pathname.match(/^\/api\/sessions\/([^/]+)(\/context)?$/);
  if (match) { const res = await (match[2] ? contextGet : sessionGet)(new Request(req.url()), { params: Promise.resolve({ id: match[1] }) }); return route.fulfill({ status: res.status, json: await res.json() }); }
  if (req.method() === "POST" && ["fork", "fork_branch", "clone"].includes(body?.type)) {
    assert.equal(url.pathname, `/api/agent/${sourceId}`); copyBodies.push(body);
    if (!w.isAlive()) w = sourceWrapper();
    const original = SessionManager.prototype.createBranchedSession;
    if (failSDKOnce) { failSDKOnce = false; SessionManager.prototype.createBranchedSession = function () { throw new Error("Fixture SDK outcome cannot be confirmed"); }; }
    try {
      const result = await w.send(body);
      if (responseBody !== undefined) { const text = responseBody; responseBody = undefined; return route.fulfill({ status: 200, contentType: "application/json", body: text }); }
      if (loseResponse) { loseResponse = false; return route.fulfill({ status: 503, json: { error: "Fixture lost copy success response" } }); }
      return route.fulfill({ json: { success: true, data: result } });
    } catch (e) { return route.fulfill({ status: 500, json: { error: e.message, code: e.code, newSessionId: e.newSessionId } }); }
    finally { SessionManager.prototype.createBranchedSession = original; }
  }
  let data = {};
  if (url.pathname === "/api/default-cwd" || url.pathname === "/api/cwd/validate") data = { cwd, projectRoot: cwd, projectKey: "pi-web:chat", sessionKind: "chat" };
  else if (url.pathname === "/api/agent/running") data = { runningSessionIds: [], sessionActivity: {}, sessionListVersion: calls.length };
  else if (url.pathname === "/api/models") data = { models: {}, modelList: [] };
  else if (url.pathname === "/api/worktrees") data = { isGit: false, worktrees: [] };
  else if (url.pathname.startsWith("/api/agent/")) {
    if (req.method() === "POST") {
      assert.ok(["get_tools", "get_commands", "get_state", "get_session_stats"].includes(body?.type), `Unexpected runtime request ${JSON.stringify(body)}`);
      data = { success: true, data: body?.type === "get_state" ? { isStreaming: false, queuedMessages: { steering: [], followUp: [] } } : [] };
    } else data = { running: false };
  } else if (url.pathname.startsWith("/api/files")) data = { entries: [] };
  return route.fulfill({ json: data });
});
let page = await context.newPage(); page.on("pageerror", (e) => errors.push(e.message));
async function openSource() { await page.goto(`${base}/?session=${sourceId}`, { waitUntil: "networkidle" }); await page.locator("textarea").first().waitFor(); }
async function showTask(count) {
  await page.getByRole("link", { name: "Task dashboard", exact: true }).click();
  const card = page.locator(`[data-task-card="${task.id}"]`); await card.waitFor();
  assert.ok((await card.locator("[data-task-activity]").innerText()).includes(`Chats: ${count}`));
  await card.locator("summary").click(); await card.getByRole("button", { name: `Chats (${count})`, exact: true }).click();
  const links = card.getByRole("list", { name: "Linked chats", exact: true }).getByRole("link");
  await links.first().waitFor(); assert.equal(await links.count(), count);
  return card;
}
try {
  await openSource();
  // Real user-message fork, lost committed response, retry keeps the exact UUID and child.
  const fork = page.getByRole("button", { name: "New session", exact: true }).last();
  await page.getByText("Second synthetic prompt", { exact: true }).hover(); loseResponse = true; await fork.click();
  await page.getByText("Fixture lost copy success response", { exact: false }).first().waitFor();
  assert.ok(page.url().includes(sourceId)); assert.equal((await taskOperation({ action: "list" }, { agentDir })).tasks[0].sessionIds.length, 2);
  await page.getByText("Second synthetic prompt", { exact: true }).hover(); await fork.click();
  await page.waitForURL((u) => u.searchParams.get("session") !== sourceId && !!u.searchParams.get("session")); await page.locator("textarea").first().waitFor();
  assert.equal(copyBodies[0].operationId, copyBodies[1].operationId); assert.equal((await SessionManager.listAll()).length, 2);
  await showTask(2); cases.push("message fork lost response / exact retry / one native child / jump + persisted task count/list");

  let count = 2;
  for (const malformed of ["", "{", '{"success":true}', '{"success":true,"data":{"cancelled":false,"newSessionId":"../invalid"}}', '{"data":{"cancelled":false,"newSessionId":"child"}}']) {
    await openSource(); responseBody = malformed;
    await page.getByText("Second synthetic prompt", { exact: true }).hover(); await page.getByRole("button", { name: "New session", exact: true }).last().click();
    await page.getByText("Session copy was not confirmed: the server response was incomplete or invalid.", { exact: false }).first().waitFor();
    assert.ok(page.url().includes(sourceId));
    assert.equal((await taskOperation({ action: "list" }, { agentDir })).tasks[0].sessionIds.length, ++count);
    const originalId = copyBodies.at(-1).operationId;
    await page.reload(); await page.locator("textarea").first().waitFor();
    await page.getByText("Second synthetic prompt", { exact: true }).hover(); await page.getByRole("button", { name: "New session", exact: true }).last().click();
    await page.waitForURL((u) => u.searchParams.get("session") !== sourceId && !!u.searchParams.get("session")); await page.locator("textarea").first().waitFor();
    assert.equal(copyBodies.at(-1).operationId, originalId); assert.equal((await SessionManager.listAll()).length, count);
    await showTask(count); cases.push(`R1 malformed 200 ${JSON.stringify(malformed)} / visible error / reload exact UUID / one child`);
  }

  await openSource(); const composer = page.locator("textarea").first(); await composer.fill("/clone "); await composer.press("Enter");
  await page.waitForURL((u) => u.searchParams.get("session") !== sourceId && !!u.searchParams.get("session")); await page.locator("textarea").first().waitFor();
  assert.equal(copyBodies.at(-1).type, "clone"); await showTask(++count); cases.push("actual /clone builtin / jump + refreshed task count/list");

  await openSource();
  await page.locator('[data-message-role="assistant"]').first().evaluate((element) => {
    const p = element.querySelector("p") ?? element; const range = document.createRange(); range.selectNodeContents(p);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); p.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
  });
  await page.getByRole("button", { name: "Ask in new chat", exact: true }).click();
  const quoteComposer = page.locator("textarea").last(); await quoteComposer.waitFor(); await quoteComposer.fill("Fixture quoted question"); await quoteComposer.press("Enter");
  await page.waitForURL((u) => u.searchParams.get("session") !== sourceId && !!u.searchParams.get("session")); await page.locator("textarea").first().waitFor();
  assert.equal(copyBodies.at(-1).type, "fork_branch"); assert.ok((await page.locator("textarea").first().inputValue()).includes("Fixture quoted question"));
  await showTask(++count); cases.push("actual quoted assistant branch-copy / prepared unsent question / jump + task list/count without prompt");
  await openSource(); failSDKOnce = true;
  await page.getByText("Second synthetic prompt", { exact: true }).hover(); await page.getByRole("button", { name: "New session", exact: true }).last().click();
  await page.getByText("Fixture SDK outcome cannot be confirmed", { exact: false }).first().waitFor();
  const oldAttempt = copyBodies.at(-1).operationId;
  await page.getByText("Second synthetic prompt", { exact: true }).hover(); await page.getByRole("button", { name: "New session", exact: true }).last().click();
  const recovery = page.getByText("The previous copy outcome is unknown", { exact: false }).first(); await recovery.waitFor();
  assert.match(await recovery.innerText(), /new empty tab/); assert.match(await recovery.innerText(), /duplicate or unlinked child/);
  assert.equal(copyBodies.at(-1).operationId, oldAttempt); await showTask(count);
  // User checked lists, then explicitly opened a genuinely empty tab and invoked a separate copy.
  const oldPage = page; page = await context.newPage(); page.on("pageerror", (e) => errors.push(e.message));
  await openSource(); await page.getByText("Second synthetic prompt", { exact: true }).hover(); await page.getByRole("button", { name: "New session", exact: true }).last().click();
  await page.waitForURL((u) => u.searchParams.get("session") !== sourceId && !!u.searchParams.get("session")); await page.locator("textarea").first().waitFor();
  assert.notEqual(copyBodies.at(-1).operationId, oldAttempt);
  const receipts = JSON.parse(await readFile(join(agentDir, "tasks", "board.json"))).sessionCopies;
  assert.equal(receipts.find((r) => r.operationId === oldAttempt).status, "prepared");
  await oldPage.close(); await showTask(++count); cases.push("R2 visible inspection + new empty tab instructions / explicit separate attempt / original prepared receipt retained");
  await page.reload(); const card = page.locator(`[data-task-card="${task.id}"]`); await card.waitFor(); assert.ok((await card.locator("[data-task-activity]").innerText()).includes(`Chats: ${count}`));
  assert.deepEqual(await readFile(manager.getSessionFile()), sourceBytes); assert.deepEqual(errors, []);
  assert.deepEqual(calls.filter((c) => c.method === "POST" && ["prompt", "steer", "follow_up", "ensure_session"].includes(c.body?.type)), []);
  await page.screenshot({ path: join(evidence, "copy-task.png"), fullPage: true });
  await writeFile(join(evidence, "results.json"), JSON.stringify({ cases, calls, errors }, null, 2)); console.log(`PASS ${cases.length} scenarios; evidence=${evidence}`);
} catch (e) { await page.screenshot({ path: join(evidence, "failure.png"), fullPage: true }); await writeFile(join(evidence, "failure.json"), JSON.stringify({ error: String(e), cases, calls, errors }, null, 2)); throw e; }
finally { await browser.close(); for (const wrapper of wrappers) wrapper.destroy(); await rm(agentDir, { recursive: true, force: true }); if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; }
