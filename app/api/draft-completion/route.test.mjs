import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, stat, symlink, truncate } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Real route + backend + SDK session parsing + authorization + scope resolution.
// Only SDK service construction/provider inference is replaced, before import.
test("draft completion route executes validation, trust-safe preparation and read-only session checks", async (t) => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-draft-route-")));
  const cwd = path.join(dir, "project");
  const outside = path.join(dir, "outside");
  const agentDir = path.join(dir, "agent");
  const sessionsDir = path.join(agentDir, "sessions", "project");
  await Promise.all([mkdir(path.join(cwd, ".pi"), { recursive: true }), mkdir(outside), mkdir(sessionsDir, { recursive: true })]);
  await writeFile(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ enabledModels: ["test/*"] }));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const previousRoots = globalThis.__piAllowedRootsCache;
  const previousRegistry = globalThis.__piSessions;
  globalThis.__piAllowedRootsCache = { roots: new Set([cwd]), expiresAt: Date.now() + 60_000 };
  globalThis.__piSessions = new Map();
  const model = { provider: "test", id: "fast", name: "Fast" };
  const other = { provider: "test", id: "other", name: "Other" };
  const state = globalThis.__draftRouteTest = {
    preparations: [], completions: [], patterns: ["test/*"],
    result: { stopReason: "stop", content: [{ type: "text", text: " the edge cases" }] },
    runtime: {
      getError: () => undefined,
      getAvailable: async () => [model, other],
      completeSimple: async (...args) => {
        state.completions.push(args);
        if (state.onComplete) await state.onComplete();
        if (state.fail) throw new Error("private-provider-token");
        return state.result;
      },
    },
  };
  const stub = path.join(dir, "sdk-stub.mjs");
  const sdk = path.resolve("node_modules/@earendil-works/pi-coding-agent/dist/index.js").replaceAll("\\", "/");
  await writeFile(stub, `export * from ${JSON.stringify(sdk)};
    export async function createAgentSessionServices(options) {
      const state = globalThis.__draftRouteTest;
      state.preparations.push({ options, trusted: await options.resourceLoaderReloadOptions?.resolveProjectTrust() });
      if (state.failPreparation) throw new Error('private-provider-token');
      return { modelRuntime: state.runtime, settingsManager: { getEnabledModels: () => state.patterns } };
    }
    export function createAgentSession() { throw new Error('AgentSession construction forbidden'); }
  `);
  t.after(async () => {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    globalThis.__piAllowedRootsCache = previousRoots;
    globalThis.__piSessions = previousRegistry;
    delete globalThis.__draftRouteTest;
    await rm(dir, { recursive: true, force: true });
  });
  const jiti = createJiti(import.meta.url, { moduleCache: false, alias: { "@earendil-works/pi-coding-agent": stub, "@": process.cwd() } });
  const { POST } = await jiti.import("./route.ts");
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const input = { cwd, sessionId: null, leafId: null, draft: "Please check", model: { provider: "test", modelId: "fast" } };
  const request = (body = input, headers = {}, signal) => new Request("http://localhost/api/draft-completion", {
    method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body), signal,
  });
  const header = (id = "session-test", sessionCwd = cwd) => ({ type: "session", version: 3, id, cwd: sessionCwd, timestamp: "2026-01-01T00:00:00.000Z" });
  const file = path.join(sessionsDir, "2026-01-01_session-test.jsonl");
  const entry = { type: "message", id: "leaf-a", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "Earlier request" }, { type: "image", data: "secret-image" }], timestamp: 1 } };
  const save = (entries) => writeFile(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

  await t.test("invalid or oversized DTO returns 400 without service work", async () => {
    for (const body of ["not json", "{}", { ...input, model: null }, { ...input, cwd: "relative" }, { ...input, sessionId: "../private" }, { ...input, draft: "x".repeat(8001) }, JSON.stringify(input) + " ".repeat(65536)]) {
      assert.equal((await POST(request(body))).status, 400);
    }
    assert.equal((await POST(request(input, { "content-length": "65537" }))).status, 400);
    assert.equal(state.preparations.length, 0);
  });
  await t.test("forbidden cwd and symlink escape return 403 before service construction", async () => {
    assert.equal((await POST(request({ ...input, cwd: outside }))).status, 403);
    const link = path.join(cwd, "escape");
    await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    assert.equal((await POST(request({ ...input, cwd: link }))).status, 403);
    assert.equal(state.preparations.length, 0);
  });
  await t.test("new-session 200 has only suffix/null leaf and forwards denied project trust", async () => {
    const response = await POST(request());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: " the edge cases", leafId: null });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(state.preparations[0].trusted, false);
    assert.equal(state.preparations[0].options.cwd, cwd);
    assert.equal(state.preparations[0].options.agentDir, agentDir);
    assert.ok(state.preparations[0].options.modelRuntimeSignal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(state.completions[0][1].messages[0].content), { history: [], draft: input.draft });
    assert.equal(state.completions[0][2].toolChoice, "none");
  });
  await t.test("unknown session 404; wrong project 403; stale/null leaf 204", async () => {
    const count = state.preparations.length;
    assert.equal((await POST(request({ ...input, sessionId: "missing" }))).status, 404);
    await save([header("session-test", outside), entry]);
    assert.equal((await POST(request({ ...input, sessionId: "session-test", leafId: "leaf-a" }))).status, 403);
    await save([header(), entry]);
    for (const leafId of [null, "stale-leaf"]) assert.equal((await POST(request({ ...input, sessionId: "session-test", leafId }))).status, 204);
    assert.equal(state.preparations.length, count);
  });
  await t.test("dormant sessions remain byte-for-byte unchanged and send text-only history", async () => {
    const before = await readFile(file);
    const mtime = (await stat(file)).mtimeMs;
    const response = await POST(request({ ...input, sessionId: "session-test", leafId: "leaf-a" }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { text: " the edge cases", leafId: "leaf-a" });
    assert.deepEqual(JSON.parse(state.completions.at(-1)[1].messages[0].content).history, [{ role: "user", text: "Earlier request" }]);
    assert.deepEqual(await readFile(file), before);
    assert.equal((await stat(file)).mtimeMs, mtime);
    assert.equal(globalThis.__piSessions.size, 0);
    await save([header()]);
    assert.equal((await POST(request({ ...input, sessionId: "session-test" }))).status, 200);
    const legacy = { ...header(), version: 1 };
    await save([legacy, { type: "message", message: { role: "user", content: "legacy", timestamp: 1 } }]);
    const legacyBefore = await readFile(file);
    assert.equal((await POST(request({ ...input, sessionId: "session-test" }))).status, 204);
    assert.deepEqual(await readFile(file), legacyBefore);
    await save([header(), entry]);
  });
  await t.test("oversized dormant transcripts fail closed without parsing or rewriting", async () => {
    const count = state.completions.length;
    await truncate(file, 16 * 1024 * 1024 + 1);
    assert.equal((await POST(request({ ...input, sessionId: "session-test", leafId: "leaf-a" }))).status, 204);
    assert.equal((await stat(file)).size, 16 * 1024 * 1024 + 1);
    assert.equal(state.completions.length, count);
    await save([header(), entry]);
  });
  await t.test("selected unavailable/out-of-scope models are 422, no fallback", async () => {
    const count = state.completions.length;
    assert.equal((await POST(request({ ...input, model: { provider: "test", modelId: "missing" } }))).status, 422);
    state.patterns = ["test/other"];
    const response = await POST(request());
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { error: "Selected model is unavailable" });
    assert.equal(state.completions.length, count);
    state.patterns = ["test/*"];
  });
  await t.test("provider/preparation failures and changed dormant leaf return empty 204", async () => {
    state.fail = true;
    let response = await POST(request());
    assert.equal(response.status, 204); assert.equal(await response.text(), "");
    state.fail = false; state.failPreparation = true;
    response = await POST(request());
    assert.equal(response.status, 204); assert.equal(await response.text(), "");
    state.failPreparation = false;
    state.onComplete = () => save([header(), entry, { ...entry, id: "leaf-b", parentId: "leaf-a" }]);
    assert.equal((await POST(request({ ...input, sessionId: "session-test", leafId: "leaf-a" }))).status, 204);
    state.onComplete = undefined;
  });
  await t.test("busy live wrapper fails closed; idle wrapper reuses existing service", async () => {
    const sm = SessionManager.inMemory(cwd, undefined, [header(), entry]);
    const wrapper = {
      cwd, inner: { sessionManager: sm, modelRuntime: state.runtime, settingsManager: { getEnabledModels: () => state.patterns }, isIdle: true },
      isAlive: () => true, isRunning: () => true, waitUntilReady: async () => undefined,
    };
    globalThis.__piSessions.set("session-test", wrapper);
    const count = state.preparations.length;
    assert.equal((await POST(request({ ...input, sessionId: "session-test", leafId: "leaf-a" }))).status, 204);
    wrapper.isRunning = () => false;
    assert.equal((await POST(request({ ...input, sessionId: "session-test", leafId: "leaf-a" }))).status, 200);
    assert.equal(state.preparations.length, count);
    // The main session still has its old patterns: the optional request must
    // nevertheless honor a newer Models-panel edit without reloading it.
    const settingsPath = path.join(agentDir, "settings.json");
    await writeFile(settingsPath, JSON.stringify({ enabledModels: ["test/other"] }));
    assert.equal((await POST(request({ ...input, sessionId: "session-test", leafId: "leaf-a" }))).status, 422);
    assert.deepEqual(wrapper.inner.settingsManager.getEnabledModels(), ["test/*"]);
    await rm(settingsPath);
    globalThis.__piSessions.clear();
  });
});
