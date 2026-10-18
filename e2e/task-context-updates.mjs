// Full-API browser fixture backed by temporary SDK, board and actual fake Provider.
// SSE transport simulated; no production SSE or real provider claims.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { chromium } from "playwright";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { contextUpdateFixture, settle, command, agentState, getRpcSession, getRpcSessionActivity, getRunningRpcSessionIds, listAllSessions, startRpcSession, attachFakeProvider } from "../lib/task-context-updates-fixture.mjs";
const base = process.env.E2E_BASE_URL ?? "http://127.0.0.1:30143";
const artifact = process.env.E2E_ARTIFACT_DIR ?? await mkdtemp(join(tmpdir(), "b09-")); await mkdir(artifact, { recursive: true });
const cleanup = [], f = await contextUpdateFixture({ after: fn => cleanup.push(fn) });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1360, height: 980 }, hasTouch: true });
const calls = [], errors = [], forbidden = [], cases = [];
let taskFailure = false;
await context.addInitScript(() => {
  Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
  localStorage.setItem("pi-locale", "en"); localStorage.setItem("pi-tool-preset", "none");
  const sources = new Map();
  window.__emitFixture = (id, event) => { for (const source of sources.get(id) ?? []) if (source.readyState === 1) source.onmessage?.({ data: JSON.stringify(event) }); };
  window.EventSource = class { readyState = 1; constructor(url) { const id = new URL(url, location.href).pathname.split("/")[3]; sources.set(id, [...sources.get(id) ?? [], this]); queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: "connected", isStreaming: false }) })); } close() { this.readyState = 2; } };
});
await context.route("**/*", async route => {
  const url = new URL(route.request().url());
  if (url.origin !== new URL(base).origin) { forbidden.push(url.origin); return route.abort(); }
  return route.continue();
});
await context.route("**/api/**", async route => {
  const request = route.request(), url = new URL(request.url()), body = request.postDataJSON(), path = url.pathname;
  calls.push({ path, method: request.method(), body });
  if (path === "/api/tasks") {
    if (taskFailure && body?.action === "accept-context-update") { taskFailure = false; return route.fulfill({ status: 503, json: { error: "Fixture selection write failed" } }); }
    try { return route.fulfill({ json: await f.op(request.method() === "GET" ? { action: "list" } : body) }); }
    catch (e) { return route.fulfill({ status: e.code === "conflict" ? 409 : e.code === "not-found" ? 404 : 400, json: { error: e.message, code: e.code } }); }
  }
  if (/^\/api\/agent\/[^/]+$/.test(path) && path !== "/api/agent/running") {
    const params = { params: Promise.resolve({ id: path.split("/").at(-1) }) };
    const response = request.method() === "POST" ? await command(new Request(request.url(), { method: "POST", body: JSON.stringify(body) }), params) : await agentState(new Request(request.url()), params);
    return route.fulfill({ status: response.status, contentType: "application/json", body: await response.text() });
  }
  let data;
  if (path === "/api/sessions") data = { sessions: await listAllSessions({ force: true }), runningSessionIds: getRunningRpcSessionIds() };
  else if (path === "/api/agent/running") data = { runningSessionIds: getRunningRpcSessionIds(), sessionActivity: getRpcSessionActivity(), sessionListVersion: 1 };
  else if (path === "/api/models") data = { models: {}, modelList: [] };
  else if (path === "/api/git/status" && url.searchParams.get("cwd") === f.cwd) data = { isGit: false, files: [] };
  else if (path === "/api/worktrees") data = { isGit: false, worktrees: [] };
  else if (path === "/api/default-cwd" || path === "/api/cwd/validate") data = { cwd: f.cwd, projectRoot: f.cwd, projectKey: "pi-web:chat", sessionKind: "chat" };
  else if (path.startsWith("/api/sessions/")) {
    const id = path.split("/")[3], w = getRpcSession(id), info = (await listAllSessions({ force: true })).find(s => s.id === id);
    if (path.endsWith("/state")) data = { running: !!w, state: w ? await w.send({ type: "get_state" }) : null };
    else { const c = w?.inner.sessionManager.buildSessionContext(); data = { sessionId: id, info, tree: [], leafId: w?.inner.sessionManager.getLeafId(), toolNames: [], context: { messages: c?.messages.filter(m => m.role !== "system") ?? [], entryIds: [], hasMore: false } }; }
  } else if (path.startsWith("/api/files/") && url.searchParams.get("type") === "list") data = { entries: [] };
  else if (["/api/tools/settings", "/api/subagents/settings", "/api/app-update", "/api/web-auth", "/api/project-trust", "/api/home", "/api/default-preferences", "/api/open-in-explorer", "/api/skills"].includes(path)) data = {};
  else { forbidden.push(`${request.method()} ${path}`); return route.fulfill({ status: 400, json: { error: "Unknown fixture API" } }); }
  return route.fulfill({ json: data });
});
let page = await context.newPage(); page.on("pageerror", e => errors.push(e.message));
f.w.onEvent(event => { for (const tab of context.pages()) void tab.evaluate(({ id, event }) => window.__emitFixture?.(id, event), { id: f.w.sessionId, event }).catch(() => {}); });
const area = () => page.getByRole("region", { name: "Task shared context", exact: true });
const choose = async v => { await area().getByRole("button", { name: "Choose a shared version", exact: true }).click(); await area().getByRole("combobox").selectOption(v); };
const receive = () => area().getByRole("button", { name: "Receive this version for next send", exact: true }).click();
const send = async text => { await page.locator("textarea").first().fill(text); await page.getByRole("button", { name: "Send", exact: true }).click(); };
async function waitForState(predicate) { for (let i = 0; i < 100; i++) { if (predicate(await f.state())) return; await new Promise(r => setTimeout(r, 50)); } assert.fail("SDK state timeout"); }
try {
  await page.goto(`${base}/?session=${f.w.sessionId}`, { waitUntil: "networkidle" }); await area().waitFor();
  const initial = f.captures.length, v2 = await f.publish("BROWSER VERSION TWO");
  await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await area().getByText(/A confirmed shared update is available/).waitFor();
  assert.equal(f.captures.length, initial); await send("Unaccepted remains old"); await settle(f.w); assert.ok(!JSON.stringify(f.captures.at(-1)).includes(v2));
  cases.push("publication/reminder and ordinary unaccepted send stay old at actual provider");
  await choose(v2); taskFailure = true; await receive(); await area().getByRole("alert").filter({ hasText: "Fixture selection write failed" }).waitFor();
  assert.equal((await f.state()).state.pendingOperationId, null); assert.equal(await area().getByRole("combobox").inputValue(), v2);
  await receive(); await waitForState(s => !!s.state.pendingOperationId); const choice = (await f.state()).state.pendingOperationId;
  const acceptRequests = calls.filter(c => c.body?.action === "accept-context-update"); assert.equal(acceptRequests.at(-1).body.operationId, acceptRequests.at(-2).body.operationId);
  await page.reload({ waitUntil: "networkidle" }); await area().getByRole("status").filter({ hasText: v2 }).waitFor(); assert.equal((await f.state()).state.pendingOperationId, choice);
  cases.push("explicit version/source preview, failed receive retains selection/UUID, retry and refresh persist pending without prompt");
  const v3 = await f.publish("BROWSER VERSION THREE"); await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await area().getByText(/A confirmed shared update is available/).waitFor();
  assert.equal((await f.state()).state.pendingOperationId, choice);
  const bytes = await readFile(f.file, "utf8"), count = f.captures.length;
  await writeFile(f.file, "Fixture denied/corrupt store"); await send("Failed user send retained");
  await page.waitForFunction(() => document.querySelector("textarea")?.value === "Failed user send retained");
  assert.equal(f.captures.length, count); await writeFile(f.file, bytes);
  assert.equal((await f.state()).state.pendingOperationId, choice);
  const originalAuth = f.w.inner.modelRuntime.getAuth.bind(f.w.inner.modelRuntime); f.w.inner.modelRuntime.getAuth = async () => { throw new Error("Browser fixture auth failure"); };
  await send("Auth-failed accepted run is not adoption"); await settle(f.w);
  assert.equal(f.captures.length, count); assert.equal((await f.state()).state.pendingOperationId, choice); assert.equal((await f.state()).state.deliveries.length, 0);
  f.w.inner.modelRuntime.getAuth = originalAuth;
  await page.reload({ waitUntil: "networkidle" }); await area().waitFor(); await send("Explicit retry selected TWO"); await waitForState(s => s.state.deliveries.length === 1); await settle(f.w);
  assert.match(JSON.stringify(f.captures.at(-1)), new RegExp(v2)); assert.ok(!JSON.stringify(f.captures.at(-1)).includes(v3));
  await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await area().locator("summary").first().click(); await area().getByText(/Successful SDK input\/response recorded/).waitFor();
  assert.equal(f.captures.at(-1).system, "Exact context-update fixture system."); assert.deepEqual(f.captures.at(-1).tools, []);
  cases.push("newer publication does not replace pending; storage-rejected send restores draft and auth-failed accepted run has zero provider; explicit retry uses exact chosen version once, Chat-only exact system/tools retained");
  const gate = Promise.withResolvers(), started = Promise.withResolvers(); f.setResponse(async () => { started.resolve(); await gate.promise; return fauxAssistantMessage([fauxText("Busy fixture reply")]); });
  await send("Running browser work"); await started.promise; await f.w.send({ type: "follow_up", message: "Existing browser queue" });
  await choose(v3); await area().getByText(/Only a pending intention is saved/).waitFor(); await receive(); const pending3 = (await f.state()).state.pendingOperationId;
  assert.equal(f.w.inner.pendingMessageCount, 1); const active = f.captures.length;
  await page.reload({ waitUntil: "networkidle" }); await area().getByRole("status").filter({ hasText: v3 }).waitFor();
  gate.resolve(); await settle(f.w); assert.ok(f.captures.length > active); assert.ok(!JSON.stringify(f.captures.at(-1)).includes(v3)); assert.equal((await f.state()).state.pendingOperationId, pending3);
  f.setResponse(async () => fauxAssistantMessage([fauxText("Next user response")])); await send("User after full queue"); await waitForState(s => s.state.pendingOperationId === null); await settle(f.w); assert.match(JSON.stringify(f.captures.at(-1)), new RegExp(v3));
  cases.push("busy receive does not steer/stop/send; refresh and existing followup finish old; next independent Send gets THREE");
  await choose(v2);
  const scopeBytes = await readFile(f.file, "utf8"), scope = JSON.parse(scopeBytes), scopeCount = f.captures.length;
  scope.tasks.find(t => t.id === f.task.id).project = { cwd: f.cwd, projectRoot: "/fixture-other-project", projectKey: "fixture-other-project" };
  await writeFile(f.file, JSON.stringify(scope)); await receive();
  await area().getByRole("alert").filter({ hasText: /outside the task's current project/ }).waitFor();
  assert.equal(await area().getByRole("combobox").inputValue(), v2); assert.equal(f.captures.length, scopeCount);
  await writeFile(f.file, scopeBytes); await area().getByRole("button", { name: "Cancel", exact: true }).click();
  cases.push("scope changed after browser preview is authoritatively refused, preserving selected draft and zero provider work");
  const currentEntry = f.w.inner.sessionManager.getBranch().find(e => e.type === "custom_message" && e.details?.versionId === v3);
  f.w.inner.sessionManager.appendContextEdit(currentEntry.id, null);
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  if (!await area().locator("details").first().evaluate(e => e.open)) await area().locator("summary").first().click();
  await area().getByText(/Excluded or changed by branch, compaction or context edit/).waitFor();
  cases.push("browser explains raw version/send audit versus context-edited native projection without claiming model knowledge");
  const v4 = await f.publish("MOBILE VERSION FOUR"), firstTab = page, secondTab = await context.newPage();
  await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await choose(v4);
  page = secondTab; await page.goto(`${base}/?session=${f.w.sessionId}`, { waitUntil: "networkidle" }); await choose(v3);
  page = firstTab; await receive(); const winner = (await f.state()).state.pendingOperationId;
  page = secondTab; await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await new Promise(r => setTimeout(r, 150)); await receive();
  await area().getByRole("alert").filter({ hasText: /changed in another page/ }).waitFor();
  assert.equal(await area().getByRole("combobox").inputValue(), v3); assert.equal((await f.state()).state.pendingOperationId, winner);
  await secondTab.close(); page = firstTab;
  cases.push("two real tabs retain preview CAS base across focus/read refresh; stale explicit receive conflicts visibly without overwriting winning pending");
  await page.setViewportSize({ width: 390, height: 844 }); await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await choose(v4);
  assert.equal(await area().getByRole("combobox").evaluate(e => getComputedStyle(e).fontSize), "16px"); await receive(); await area().getByRole("status").filter({ hasText: v4 }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await page.screenshot({ path: join(artifact, "mobile.png"), fullPage: true });
  cases.push("390px keyboard/select/explicit receive, source and next version accessible without horizontal overflow");
  const empty = SessionManager.create(f.cwd, join(f.agentDir, "sessions", "empty-fixture"));
  empty.appendCustomEntry("pi-web:tool-selection", { version: 1, tools: [] });
  empty.appendMessage({ role: "user", content: "Existing conversation with no confirmed task version", timestamp: Date.now() });
  empty.appendMessage({ ...fauxAssistantMessage([fauxText("Synthetic completed history")]), provider: "context-fake", model: "one" });
  await f.op({ action: "createFromSession", id: randomUUID(), title: "No confirmed context", description: "", completionCriteria: "", sourceSessionId: empty.getSessionId() });
  const emptyW = (await startRpcSession(empty.getSessionId(), empty.getSessionFile())).session; cleanup.push(() => emptyW.shutdown());
  const emptyFake = await attachFakeProvider(emptyW);
  await page.goto(`${base}/?session=${empty.getSessionId()}`, { waitUntil: "networkidle" }); await area().waitFor();
  assert.equal(await area().getByRole("button", { name: "Choose a shared version", exact: true }).count(), 0);
  assert.equal(await area().getByRole("status").count(), 0); assert.equal(emptyFake.captures.length, 0);
  cases.push("owned existing conversation with no confirmed version does not forge reminder/choice/adoption or call provider");
  assert.deepEqual(errors, []); assert.deepEqual(forbidden, []);
  await writeFile(join(artifact, "PASS.json"), JSON.stringify({ cases, calls, captures: f.captures, state: await f.state(), errors, forbidden }, null, 2));
  console.log(`PASS ${cases.length} browser scenarios; ${f.captures.length} actual fake Provider requests; zero external APIs`);
} catch (e) {
  await page.screenshot({ path: join(artifact, "FAIL.png"), fullPage: true }).catch(() => {});
  await writeFile(join(artifact, "FAIL.json"), JSON.stringify({ error: e.stack, cases, calls, captures: f.captures, errors, forbidden }, null, 2)); throw e;
} finally { await browser.close(); for (const fn of cleanup.reverse()) await fn(); }
