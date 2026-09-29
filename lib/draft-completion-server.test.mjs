import assert from "node:assert/strict";
import test from "node:test";
import { realpath } from "node:fs/promises";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createDraftCompletionHandler, parseDraftCompletionRequest, parseDraftCompletion, draftCompletionHistory } = await jiti.import("./draft-completion-server.ts");
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const cwd = await realpath(process.cwd());
const model = { provider: "test", id: "fast" };
const input = { cwd, sessionId: null, leafId: null, draft: "Please check", model: { provider: "test", modelId: "fast" } };
const req = (body = input, signal) => new Request("http://localhost/api/draft-completion", { method: "POST", body: JSON.stringify(body), signal });
const completion = (text = " the validation", stopReason = "stop") => ({ stopReason, content: [{ type: "text", text }] });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise((r) => setImmediate(r));

function manager(entries = []) {
  return SessionManager.inMemory(cwd, undefined, [{ type: "session", version: 3, id: "session-test", cwd, timestamp: "2026-01-01T00:00:00.000Z" }, ...entries]);
}
function fixture() {
  const calls = [];
  const state = { busy: false, live: undefined, manager: manager(), visible: [model], result: completion(), created: 0, read: 0 };
  const services = {
    settingsManager: { getEnabledModels: () => ["test/*"] },
    modelRuntime: { getError: () => state.runtimeError, completeSimple: async (...args) => { calls.push(args); return typeof state.result === "function" ? state.result(...args) : state.result; } },
  };
  const deps = {
    authorizeCwd: async () => cwd,
    getLiveSession: () => state.live,
    isCwdBusy: () => state.busy,
    readSession: async () => { state.read++; return state.manager; },
    createServices: async () => { state.created++; return services; },
    readEnabledModels: () => ["test/*"],
    resolveScope: async (runtime, patterns) => { assert.equal(runtime, services.modelRuntime); assert.deepEqual(patterns, ["test/*"]); return { visible: state.visible }; },
  };
  return { state, calls, services, deps, handler: createDraftCompletionHandler(deps) };
}

function liveFixture() {
  const f = fixture();
  f.state.live = { inner: { ...f.services, sessionManager: f.state.manager, isIdle: true }, isAlive: () => true, isRunning: () => false, waitUntilReady: async () => undefined };
  return f;
}
const existingInput = { ...input, sessionId: "session-test" };

test("request bounds, explicit selection and null-leaf invariants", () => {
  assert.deepEqual(parseDraftCompletionRequest(input), input);
  assert.doesNotThrow(() => parseDraftCompletionRequest({ ...input, draft: "多行\n草稿\t继续" }));
  for (const invalid of [null, [], {}, { ...input, unexpected: true }, { ...input, cwd: "relative" },
    { ...input, sessionId: undefined }, { ...input, sessionId: "../secret" }, { ...input, leafId: "leaf" },
    { ...input, draft: "abc" }, { ...input, draft: "a".repeat(8001) }, { ...input, draft: "abcd\u0000" },
    { ...input, draft: "abcd\ud800" }, { ...input, model: null }, { ...input, model: { provider: "test" } },
    { ...input, model: { provider: "p".repeat(201), modelId: "fast" } }]) {
    assert.throws(() => parseDraftCompletionRequest(invalid));
  }
});

test("suffix validation preserves initial English whitespace and counts Unicode points", () => {
  assert.equal(parseDraftCompletion(" the validation  ", input.draft), " the validation");
  assert.equal(parseDraftCompletion("的边界条件", "请检查接口"), "的边界条件");
  assert.equal(parseDraftCompletion("𐐀".repeat(100), input.draft), "𐐀".repeat(100));
  for (const bad of ["𐐀".repeat(101), "", "   ", "...", "foo\n", "foo\r", "foo\t", "foo\u0085", "foo\u2028", "foo\u2029", "foo\u200b", "foo\ud800", input.draft, ` ${input.draft} more`, `\"${input.draft} more\"`]) {
    assert.equal(parseDraftCompletion(bad, input.draft), null, JSON.stringify(bad));
  }
});

test("recent projected history is text-only, branch-aware, bounded and respects context edits", () => {
  const sm = manager();
  sm.appendMessage({ role: "user", content: "old", timestamp: 1 });
  const target = sm.appendMessage({ role: "user", content: "omit-private", timestamp: 1 });
  sm.appendContextEdit(target, null);
  const root = sm.getLeafId();
  sm.appendMessage({ role: "user", content: "other-branch-private", timestamp: 1 });
  sm.branch(root);
  assert.deepEqual(draftCompletionHistory(sm), [{ role: "user", text: "old" }]);
  for (let i = 0; i < 8; i++) {
    sm.appendMessage({ role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: "𐐀".repeat(1500) }, { type: "thinking", thinking: "private" }, { type: "image", data: "private" }, { type: "toolCall", arguments: { private: true } }], timestamp: 1 });
    sm.appendMessage({ role: "toolResult", content: [{ type: "text", text: "tool-private" }], timestamp: 1 });
  }
  const before = JSON.stringify(sm.getEntries());
  const history = draftCompletionHistory(sm);
  assert.equal(history.length, 6);
  for (const item of history) assert.equal(Array.from(item.text).length, item.role === "user" ? 500 : 1000);
  assert.doesNotMatch(JSON.stringify(history), /private|thinking|image|toolCall/);
  assert.equal(JSON.stringify(sm.getEntries()), before);
});

test("new-session completion is an independent tool-free request containing only draft", async () => {
  const f = fixture();
  const response = await f.handler(req());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: " the validation", leafId: null });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(f.state.read, 0);
  const [selected, context, options] = f.calls[0];
  assert.equal(selected, model);
  assert.deepEqual(JSON.parse(context.messages[0].content), { history: [], draft: input.draft });
  assert.deepEqual(context.tools, []);
  assert.equal(options.maxTokens, 100);
  assert.equal(options.maxRetries, 0);
  assert.equal(options.toolChoice, "none");
  assert.equal(options.timeoutMs, 8000);
  assert.ok(options.signal instanceof AbortSignal);
});

test("dormant session reads before and after inference; live wrapper reuses services without mutations", async () => {
  for (const f of [fixture(), liveFixture()]) {
    const before = JSON.stringify(f.state.manager.getEntries());
    const result = await f.handler(req(existingInput));
    assert.equal(result.status, 200);
    assert.equal(JSON.stringify(f.state.manager.getEntries()), before);
    assert.equal(f.state.created, f.state.live ? 0 : 1);
    assert.equal(f.state.read, f.state.live ? 0 : 3);
  }
});

test("unknown, stale, busy and out-of-scope requests fail before inference", async () => {
  const cases = [
    [404, (f) => { f.state.manager = null; }],
    [204, (f) => { f.state.busy = true; }],
    [204, (f) => { f.state.manager.appendModelChange("test", "fast"); }],
    [422, (f) => { f.state.visible = []; }],
    [204, (f) => { f.state.runtimeError = "private-provider-token"; }],
  ];
  for (const [expected, setup] of cases) {
    const f = fixture(); setup(f);
    assert.equal((await f.handler(req(existingInput))).status, expected);
    assert.equal(f.calls.length, 0);
  }
  const f = liveFixture();
  f.state.live.inner.isIdle = false;
  assert.equal((await f.handler(req(existingInput))).status, 204);
  assert.equal(f.calls.length, 0);
});

test("dormant leaf changes during preparation never reach the provider", async () => {
  const f = fixture();
  f.deps.createServices = async () => {
    f.state.manager.appendModelChange("test", "fast");
    return f.services;
  };
  assert.equal((await f.handler(req(existingInput))).status, 204);
  assert.equal(f.calls.length, 0);
});

test("late leaf changes, busy runs, wrapper replacement and disappearance suppress results", async () => {
  for (const mutate of [
    (f) => f.state.manager.appendModelChange("test", "fast"),
    (f) => { f.state.busy = true; },
    (f) => { f.state.live = undefined; },
    (f) => { f.state.live = { ...f.state.live }; },
    (f) => { f.state.live.inner.isIdle = false; },
  ]) {
    const f = liveFixture();
    f.state.result = () => { mutate(f); return completion(); };
    assert.equal((await f.handler(req(existingInput))).status, 204);
  }
  const f = fixture();
  f.state.result = () => { f.state.manager = null; return completion(); };
  assert.equal((await f.handler(req(existingInput))).status, 204);
});

test("only normal stop text is returned; provider errors and secrets are suppressed", async () => {
  for (const result of [completion(" more", "length"), completion(" more", "error"), completion(" more", "aborted"), completion(" more", "pending"), completion(" more", "deferred"), completion(" more", "toolUse"), { ...completion(), content: [{ type: "toolCall" }, { type: "text", text: " more" }] }, () => { throw new Error("secret-provider-key"); }]) {
    const f = fixture(); f.state.result = result;
    const response = await f.handler(req());
    assert.equal(response.status, 204);
    assert.equal(await response.text(), "");
  }
});

test("request abort and timeout return promptly but retain slots for non-cooperative providers", async () => {
  for (const abort of [false, true]) {
    const f = fixture();
    const started = deferred(); const pending = deferred();
    f.state.result = () => { started.resolve(); return pending.promise; };
    const handler = createDraftCompletionHandler(f.deps, abort ? 5000 : 40);
    const controller = new AbortController();
    const first = handler(req(input, controller.signal));
    await started.promise;
    if (abort) controller.abort();
    assert.equal((await first).status, 204);
    assert.equal(f.calls[0][2].signal.aborted, true);
    assert.equal((await handler(req())).status, 204);
    assert.equal(f.calls.length, 1);
    pending.resolve(completion()); await tick();
    f.state.result = completion();
    assert.equal((await handler(req())).status, 200);
  }
});

test("cancellation during service preparation does not start inference after it finishes", async () => {
  const f = fixture(); const started = deferred(); const pending = deferred();
  f.deps.createServices = async () => { started.resolve(); await pending.promise; return f.services; };
  const handler = createDraftCompletionHandler(f.deps, 40);
  const first = handler(req()); await started.promise;
  assert.equal((await first).status, 204);
  assert.equal((await handler(req())).status, 204);
  pending.resolve(); await tick();
  assert.equal(f.calls.length, 0);
});

test("global ceiling limits four different cwds with no pending queue", async () => {
  const pending = deferred();
  const fixtures = Array.from({ length: 5 }, (_, i) => {
    const f = fixture();
    f.deps.authorizeCwd = async () => `${cwd}/fake-${i}`;
    f.started = deferred();
    f.state.result = () => { f.started.resolve(); return pending.promise; };
    return f;
  });
  const requests = fixtures.slice(0, 4).map((f) => f.handler(req()));
  await Promise.all(fixtures.slice(0, 4).map((f) => f.started.promise));
  assert.equal((await fixtures[4].handler(req())).status, 204);
  assert.equal(fixtures[4].calls.length, 0);
  pending.resolve(completion());
  for (const result of await Promise.all(requests)) assert.equal(result.status, 200);
});

test("same cwd/session concurrency is rejected, not queued", async () => {
  const f = fixture(); const started = deferred(); const pending = deferred();
  f.state.result = () => { started.resolve(); return pending.promise; };
  const first = f.handler(req(existingInput)); await started.promise;
  assert.equal((await f.handler(req(existingInput))).status, 204);
  assert.equal((await f.handler(req({ ...existingInput, sessionId: "different-session" }))).status, 204);
  pending.resolve(completion());
  assert.equal((await first).status, 200);
  assert.equal(f.calls.length, 1);
});
