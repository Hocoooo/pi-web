// Actual browser + isolated real SDK/routes/store + captured synthetic provider.
// Every network API is intercepted. EventSource transport is simulated, not the SDK prompt path.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { createJiti } from "jiti";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
const base = process.env.E2E_BASE_URL || "http://127.0.0.1:30142";
const evidence = process.env.E2E_ARTIFACT_DIR || await mkdtemp(join(tmpdir(), "t08b-")); await mkdir(evidence, { recursive: true });
const agentDir = await mkdtemp(join(tmpdir(), "t08d-")), cwd = join(agentDir, "chat-workspace"); await mkdir(cwd);
const old = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
await writeFile(join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "test-only-no-network" } }));
await writeFile(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-sonnet-4-5" }));
await writeFile(join(cwd, "AGENTS.md"), "Browser exact fixture instructions.");
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { taskOperation } = await jiti.import("../lib/task-operations.ts");
const { getRpcSession, getRunningRpcSessionIds, getRpcSessionActivity } = await jiti.import("../lib/rpc-manager.ts");
const { POST: newSession } = await jiti.import("../app/api/agent/new/route.ts");
const { POST: command, GET: state } = await jiti.import("../app/api/agent/[id]/route.ts");
const { listAllSessions } = await jiti.import("../lib/session-reader.ts");
const op = input => taskOperation(input, { agentDir });
const task = (await op({ action: "create", id: randomUUID(), title: "Start fixture task", description: "Task information", completionCriteria: "User verifies", cwd: null })).task;
const publish = async (goal, current = null) => (await op({ action: "publish-context", id: task.id, operationId: randomUUID(), expectedCurrentVersionId: current,
  content: { goal, decisions: "Approved reference", progress: "", nextSteps: "Next action is user-selected" } })).task.sharedContext.currentVersionId;
const v1 = await publish("Previewed version ONE");
const calls = [], requests = [], wrappers = new Set(), cases = [], errors = [];
let gate = null;
function capture(w) {
  if (wrappers.has(w)) return;
  wrappers.add(w);
  w.onEvent(event => { void page.evaluate(({ sessionId, event }) => window.__fixtureEmit?.(sessionId, event), { sessionId: w.sessionId, event }).catch(() => {}); });
  w.inner.agent.streamFunction = (model, context) => {
    const owner = JSON.parse(readFileSync(join(agentDir, "tasks/board.json"), "utf8")).tasks.find(t => t.sessionIds.includes(w.sessionId));
    requests.push({ sessionId: w.sessionId, model: { provider: model.provider, id: model.id }, context: structuredClone(context),
      taskAtRequest: owner ? { id: owner.id, versionId: owner.sessionContexts.find(c => c.sessionId === w.sessionId)?.snapshot.version?.id ?? null } : null });
    const stream = createAssistantMessageEventStream(), wait = gate;
    void (async () => {
      if (wait) await wait.promise;
      const message = { role: "assistant", content: [{ type: "text", text: "Mock provider reply" }], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push({ type: "done", reason: "stop", message }); stream.end();
    })();
    return stream;
  };
}
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1360, height: 950 }, hasTouch: true });
await context.addInitScript(() => {
  if (location.protocol.startsWith("http")) { localStorage.setItem("pi-locale", "en"); localStorage.setItem("pi-tool-preset", "none"); }
  const sources = new Map();
  window.__fixtureEmit = (sessionId, event) => { for (const source of sources.get(sessionId) ?? []) if (source.readyState === 1) source.onmessage?.({ data: JSON.stringify(event) }); };
  window.EventSource = class {
    readyState = 1;
    constructor(url) {
      const sessionId = new URL(url, location.href).pathname.split("/")[3];
      sources.set(sessionId, [...(sources.get(sessionId) ?? []), this]);
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: "connected", isStreaming: false }) }));
    }
    close() { this.readyState = 2; }
  };
});
await context.route("**/api/**", async route => {
  const request = route.request(), url = new URL(request.url()), body = request.postDataJSON(); calls.push({ path: url.pathname, method: request.method(), body });
  const respond = async response => route.fulfill({ status: response.status, contentType: "application/json", body: await response.text() });
  if (url.pathname === "/api/tasks") {
    try { return route.fulfill({ json: await op(request.method() === "GET" ? { action: "list" } : body) }); }
    catch (e) { return route.fulfill({ status: e.code === "conflict" ? 409 : e.code === "not-found" ? 404 : 400, json: { error: e.message, code: e.code } }); }
  }
  if (url.pathname === "/api/agent/new") {
    const response = await newSession(new Request(request.url(), { method: "POST", body: JSON.stringify(body) }));
    if (response.ok) { const data = await response.clone().json(); capture(getRpcSession(data.sessionId)); }
    return respond(response);
  }
  if (/^\/api\/agent\/[^/]+$/.test(url.pathname) && url.pathname !== "/api/agent/running") {
    const params = { params: Promise.resolve({ id: url.pathname.split("/").at(-1) }) };
    const response = request.method() === "POST" ? await command(new Request(request.url(), { method: "POST", body: JSON.stringify(body) }), params) : await state(new Request(request.url()), params);
    if (response.ok && body?.type === "set_tools") { const result = await response.clone().json(); capture(getRpcSession(result.data.sessionId)); }
    return respond(response);
  }
  let data = {};
  if (url.pathname === "/api/sessions") data = { sessions: await listAllSessions({ force: true }), runningSessionIds: getRunningRpcSessionIds() };
  else if (url.pathname === "/api/agent/running") data = { runningSessionIds: getRunningRpcSessionIds(), sessionActivity: getRpcSessionActivity(), sessionListVersion: 1 };
  else if (url.pathname === "/api/default-cwd") data = { cwd, projectRoot: cwd, projectKey: "pi-web:chat", sessionKind: "chat" };
  else if (url.pathname === "/api/cwd/validate") data = { cwd: body.cwd, projectRoot: body.cwd, projectKey: "pi-web:chat", sessionKind: "chat" };
  else if (url.pathname === "/api/models") data = { models: {}, modelList: [] };
  else if (url.pathname === "/api/worktrees") data = { isGit: false, worktrees: [] };
  else if (url.pathname.startsWith("/api/sessions/")) {
    const id = url.pathname.split("/")[3], w = getRpcSession(id), info = (await listAllSessions({ force: true })).find(s => s.id === id);
    if (url.pathname.endsWith("/state")) data = { running: !!w, state: w ? await w.send({ type: "get_state" }) : null };
    else { const c = w?.inner.sessionManager.buildSessionContext(); data = { sessionId: id, info, tree: [], leafId: w?.inner.sessionManager.getLeafId(), toolNames: [], context: { messages: c?.messages.filter(m => m.role !== "system") ?? [], entryIds: [], hasMore: false } }; }
  } else if (url.pathname.startsWith("/api/files")) data = { entries: [] };
  return route.fulfill({ json: data });
});
const page = await context.newPage(); page.on("pageerror", e => errors.push(e.message));
const card = () => page.locator(`[data-task-card="${task.id}"]`);
async function openStart() {
  await page.getByRole("link", { name: "Task dashboard", exact: true }).click(); await card().waitFor();
  await card().locator("summary").first().click(); await card().getByRole("button", { name: "Start task", exact: true }).click();
}
async function preview() { await card().getByRole("button", { name: "Preview task material", exact: true }).click(); await card().getByRole("button", { name: "Open chat — do not send yet", exact: true }).waitFor(); }
async function chat() { await card().getByRole("button", { name: "Open chat — do not send yet", exact: true }).click(); await page.locator("textarea").first().waitFor(); }
async function waitRequests(n) { for (let i = 0; i < 100 && requests.length < n; i++) await new Promise(r => setTimeout(r, 50)); assert.equal(requests.length, n); }
try {
  await page.goto(`${base}/?chat=1`, { waitUntil: "networkidle" }); await page.locator("textarea").first().waitFor();
  await page.locator("textarea").first().fill("Original independent unsent draft");
  await openStart(); assert.equal(await card().getByLabel("Conversation", { exact: true }).inputValue(), "");
  await preview(); assert.ok((await card().innerText()).includes(v1));
  await card().getByRole("button", { name: "Cancel", exact: true }).last().click(); assert.equal(requests.length, 0);
  cases.push("default new / passive preview / cancel does not create or send");
  await card().getByRole("button", { name: "Start task", exact: true }).click(); await preview(); await chat();
  assert.equal(await page.locator("textarea").first().inputValue(), "Original independent unsent draft"); assert.equal(calls.filter(c => c.path === "/api/agent/new").length, 0);
  cases.push("prepared chat preserves original draft, no ensure/prompt during preparation");
  const v2 = await publish("Changed version TWO", v1);
  await page.locator("textarea").first().fill("Explicit first send"); await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.locator("span").filter({ hasText: /changed after preview/ }).first().waitFor(); assert.equal(requests.length, 0);
  await page.waitForFunction(() => document.querySelector("textarea")?.value === "Explicit first send");
  const preparedId = calls.find(c => c.path === "/api/agent/new").body.taskStart.operationId;
  for (const preset of ["read-only", "chat-only", "configured", "chat-only"]) {
    await page.getByRole("button", { name: "Change tool preset", exact: true }).click();
    const completed = page.waitForResponse(r => /\/api\/agent\/[^/]+$/.test(new URL(r.url()).pathname) && r.request().postDataJSON()?.type === "set_tools");
    await page.getByRole("button", { name: new RegExp(`^${preset}`) }).click();
    const response = await completed; assert.equal(response.status(), 200); const result = await response.json();
    assert.equal(result.data.recreated, true); assert.equal(result.data.sessionId, preparedId);
    assert.equal(requests.length, 0); assert.equal(await page.locator("textarea").first().inputValue(), "Explicit first send");
  }
  cases.push("prepared unflushed identity survives real UI read/chat/configured rebuilds before first provider, retaining draft");
  await page.getByRole("button", { name: "Review current task/version again", exact: true }).click(); await page.getByText(v2, { exact: false }).first().waitFor();
  await page.getByRole("button", { name: "Send", exact: true }).click(); await waitRequests(1);
  assert.deepEqual(requests[0].model, { provider: "anthropic", id: "claude-sonnet-4-5" });
  assert.deepEqual(requests[0].taskAtRequest, { id: task.id, versionId: v2 }, "first actual provider request follows durable association/version selection");
  assert.match(JSON.stringify(requests[0]), /Changed version TWO/); assert.ok(!JSON.stringify(requests[0]).includes("Previewed version ONE"));
  const adopted = (await op({ action: "list" })).tasks[0]; assert.equal(adopted.sessionIds.length, 1); assert.equal(adopted.columnId, "todo");
  assert.equal(calls.filter(c => c.path === "/api/agent/new").length, 1, "retry reused warmed true SDK ID");
  await page.waitForURL(new RegExp(`session=${adopted.sessionIds[0]}`));
  await page.locator("textarea").first().fill("Direct send after re-preview and session promotion");
  await page.getByRole("button", { name: "Send", exact: true }).click(); await waitRequests(2);
  assert.match(JSON.stringify(requests.at(-1)), /Changed version TWO/);
  cases.push("version change rejects before provider / draft restored / review + actual send uses exact previewed version and one session / promotion retains refreshed selection");
  await openStart(); const linkedId = adopted.sessionIds[0];
  await card().getByLabel("Conversation", { exact: true }).selectOption(linkedId); await preview(); await chat();
  assert.equal(new URL(page.url()).searchParams.get("session"), linkedId);
  await page.getByText(/No automatic shared-version upgrade/).waitFor();
  await page.locator("textarea").first().fill("Continue draft retained"); await openStart();
  await card().getByLabel("Conversation", { exact: true }).selectOption(linkedId); await preview(); await chat();
  assert.equal(await page.locator("textarea").first().inputValue(), "Continue draft retained");
  const v3 = await publish("Unaccepted version THREE", v2);
  await page.getByRole("button", { name: "Send", exact: true }).click(); await waitRequests(3);
  assert.ok(!JSON.stringify(requests.at(-1)).includes(v3)); assert.ok(!JSON.stringify(requests.at(-1)).includes("Unaccepted version THREE"));
  cases.push("continue linked original chat, keeps unsent draft/history/adopted version, no auto upgrade");
  await openStart(); await preview(); await chat();
  gate = Promise.withResolvers();
  // Keep a real associated SDK agent busy in the same cwd.
  const first = getRpcSession(linkedId); await first.send({ type: "prompt", message: "Hold synthetic busy turn" }); await waitRequests(4);
  await page.locator("textarea").first().fill("Parallel task work"); await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText(/Another agent is working in this directory/).first().waitFor(); assert.equal(requests.length, 4);
  await page.waitForFunction(() => document.querySelector("textarea")?.value === "Parallel task work");
  await page.getByRole("checkbox", { name: /I understand the same-directory concurrency risk/ }).check();
  await page.getByRole("button", { name: "Send", exact: true }).click(); await waitRequests(5);
  gate.resolve(); gate = null; for (const w of wrappers) await w.inner.waitForIdle();
  assert.equal((await op({ action: "list" })).tasks[0].columnId, "todo");
  cases.push("fresh real same-cwd busy rejection and explicit confirmation allow parallel request, no worktree or state change");
  await page.goto(`${base}/?session=${linkedId}&taskStart=${randomUUID()}`, { waitUntil: "networkidle" });
  await page.getByRole("alert").filter({ hasText: /Preparation is unavailable after reload/ }).waitFor();
  await page.locator("textarea").first().fill("Expired preparation stays unsent");
  const beforeExpired = calls.filter(c => c.path.startsWith("/api/agent/") && c.method === "POST").length;
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("textarea")?.value === "Expired preparation stays unsent");
  assert.equal(requests.length, 5); assert.equal(calls.filter(c => c.path.startsWith("/api/agent/") && c.method === "POST").length, beforeExpired);
  cases.push("expired preparation token rejects ordinary Send without RPC and restores draft");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/tasks`, { waitUntil: "networkidle" }); await card().waitFor(); await card().locator("summary").first().click();
  const mobileStart = card().getByRole("button", { name: "Start task", exact: true }); await mobileStart.focus(); await mobileStart.press("Enter");
  assert.equal(await card().getByLabel("Conversation", { exact: true }).inputValue(), "");
  const mobilePreview = card().getByRole("button", { name: "Preview task material", exact: true }); await mobilePreview.focus(); await mobilePreview.press("Enter");
  await card().getByRole("button", { name: "Open chat — do not send yet", exact: true }).waitFor();
  assert.ok((await card().innerText()).includes(v3)); assert.equal(requests.length, 5);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(evidence, "start-mobile.png"), fullPage: true });
  await card().getByRole("button", { name: "Cancel", exact: true }).last().tap(); assert.equal(requests.length, 5);
  cases.push("390px keyboard preview and touch cancel remain passive with no horizontal overflow");
  assert.deepEqual(errors, []);
  await writeFile(join(evidence, "results.json"), JSON.stringify({ cases, calls, requests, errors }, null, 2)); console.log(`PASS ${cases.length} scenarios; actual captured SDK requests=${requests.length}; evidence=${evidence}`);
} catch (e) { await page.screenshot({ path: join(evidence, "failure.png"), fullPage: true }); await writeFile(join(evidence, "failure.json"), JSON.stringify({ error: String(e), cases, calls, requests, errors }, null, 2)); throw e; }
finally { if (gate) gate.resolve(); await browser.close(); for (const w of wrappers) await w.shutdown(); await rm(agentDir, { recursive: true, force: true }); if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; }
