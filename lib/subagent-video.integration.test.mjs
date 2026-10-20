import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url);
const { createSubagentController } = await jiti.import("./subagent-runtime.ts");
const { AgentSessionWrapper, startRpcSession } = await jiti.import("./rpc-manager.ts");
const { readSubagentSessionResources, SUBAGENT_META_TYPE } = await jiti.import("./subagents.ts");
const { VIDEO_MODEL_ID } = await jiti.import("./video-attachments.ts");
const mp4 = await readFile(new URL("./fixtures/video-attachments/red.mp4", import.meta.url));
const avi = await readFile(new URL("./fixtures/video-attachments/blue.avi", import.meta.url));
const settings = { compaction: { enabled: false }, retry: { enabled: false }, providerRetry: { maxRetries: 0 }, cacheWarming: "off" };
const response = (parts = [{ text: "Completed video review." }]) => new Response(`data: ${JSON.stringify({
  candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
})}\n\n`, { headers: { "content-type": "text/event-stream" } });
const videoParts = request => request.body.contents.flatMap(content => content.parts ?? []).flatMap(part => part.inlineData?.mimeType?.startsWith("video/") ? [part.inlineData] : []);

async function fixture(t, profileLines, { extension, skills = false, defaultTools } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-subagent-video-"));
  const cwd = join(dir, "workspace"), agentDir = join(dir, "agent");
  const previousDir = process.env.PI_CODING_AGENT_DIR, oldFetch = globalThis.fetch;
  const oldRoots = globalThis.__piAllowedRootsCache, originalCreate = ModelRuntime.create;
  const wrappers = new Map();
  let parent;
  t.after(async () => {
    for (const wrapper of wrappers.values()) if (wrapper.isAlive()) await wrapper.shutdown();
    parent?.dispose();
    ModelRuntime.create = originalCreate;
    globalThis.fetch = oldFetch;
    globalThis.__piAllowedRootsCache = oldRoots;
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    await rm(dir, { recursive: true, force: true });
  });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  globalThis.__piAllowedRootsCache = { roots: new Set([cwd]), expiresAt: Infinity };
  await mkdir(join(agentDir, "agents"), { recursive: true });
  await mkdir(cwd);
  const fixtureSettings = { ...settings, ...(defaultTools ? { defaultTools } : {}) };
  await writeFile(join(agentDir, "settings.json"), JSON.stringify(fixtureSettings));
  await writeFile(join(agentDir, "agents", "video.md"), ["---", ...profileLines, "---", "VIDEO_PROFILE"].join("\n"));
  if (extension) {
    await mkdir(join(agentDir, "extensions"));
    await writeFile(join(agentDir, "extensions", "legacy-video.ts"), extension);
  }
  if (skills) {
    await mkdir(join(agentDir, "skills", "focus"), { recursive: true });
    await writeFile(join(agentDir, "skills", "focus", "SKILL.md"), "---\nname: focus\ndescription: Fixture video skill\n---\nVIDEO_SKILL_BODY\n");
  }
  const paths = [join(cwd, "clip.mp4"), join(cwd, "clip.avi")];
  await writeFile(paths[0], mp4);
  await writeFile(paths[1], avi);
  const requests = [];
  let respond = () => response();
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    assert.equal(new URL(req.url).origin, "https://llm-proxy.tapsvc.com", "No non-fixture endpoint may be contacted");
    requests.push({ url: req.url, headers: req.headers, body: await req.json() });
    return respond(requests.length);
  };
  ModelRuntime.create = async (options = {}) => {
    const runtime = await originalCreate.call(ModelRuntime, { ...options, authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    runtime.registerProvider("tapsvc", {
      api: "google-generative-ai", baseUrl: "https://llm-proxy.tapsvc.com/v1beta", apiKey: "isolated-subagent-video-key",
      models: [{ id: VIDEO_MODEL_ID, name: "Fixture Gemini", reasoning: true, input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 1024 }],
    });
    return runtime;
  };
  const modelRuntime = await ModelRuntime.create();
  const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime, settingsManager: SettingsManager.inMemory(settings),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true } });
  ({ session: parent } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.create(cwd, join(dir, "sessions")), model: modelRuntime.getModel("tapsvc", VIDEO_MODEL_ID) }));
  const parentHost = { inner: parent, cwd, sessionFile: parent.sessionFile, isAlive: () => true, isRunning: () => false };
  let child, reopenCount = 0;
  const controller = createSubagentController({
    getSession: id => id === parent.sessionId ? parentHost : wrappers.get(id),
    registerSession(inner, options) {
      child = new AgentSessionWrapper(inner, { ...options, headless: true, isSubagent: true, automaticTitles: false, suppressCompletionNotifications: true });
      child.start(); child.beginExtensionBinding(); wrappers.set(inner.sessionId, child);
    },
    reopenSession: async (id, file) => {
      reopenCount++;
      child = (await startRpcSession(id, file, undefined, { headless: true })).session;
      await child.waitUntilReady(); wrappers.set(id, child); return child;
    },
    resolveSessionPath: async id => wrappers.get(id)?.sessionFile ?? null,
    invalidateSessionList() {}, isBuiltInSubagentsEnabled: () => true,
  });
  const request = { parentContext: parent, parentToolCallId: "fixture-call", profile: "video", task: "Inspect the requested local videos.", description: "Video fixture", thinking: "low" };
  const start = async (overrides = {}) => {
    const run = await controller.extensionRuntime.start({ ...request, ...overrides });
    const result = await run.completion;
    assert.equal(result.status, "completed", result.error);
    return result;
  };
  const resume = async () => {
    const run = await controller.extensionRuntime.resume({ parentContext: parent, parentToolCallId: "fixture-resume", sessionId: child.inner.sessionId, task: "Compare again.", description: "Video follow-up" });
    const result = await run.completion;
    assert.equal(result.status, "completed", result.error);
    return result;
  };
  return { cwd, agentDir, paths, requests, start, resume, get child() { return child; }, get reopenCount() { return reopenCount; },
    respond(fn) { respond = fn; }, resources() { return readSubagentSessionResources(child.inner.sessionManager.getEntries()); } };
}

function assertToolScope(f, allowed) {
  assert.equal(f.child.inner.getActiveToolNames().includes("read_video"), allowed);
  assert.equal(f.child.inner.getAllTools().filter(tool => tool.name === "read_video").length, allowed ? 1 : 0);
  assert.equal(f.resources().tools.includes("read_video"), allowed);
  assert.equal(f.child.inner.getActiveToolNames().includes("Agent"), false);
}

const legacyExtension = `export default function(pi) {
  pi.registerTool({ name: "read_video", label: "Legacy video", description: "LEGACY_VIDEO_TOOL",
    parameters: { type: "object", properties: {} }, execute: async () => ({ content: [{ type: "text", text: "legacy" }] }) });
}`;

test("subagent native video survives spawn, reload, live resume and cold resume with exact prompt and named skills", { timeout: 20000 }, async t => {
  const f = await fixture(t, ["tools: read_video", "load_extensions: false", "load_skills: true", "skills: [focus]", "prompt_mode: replace"], { skills: true });
  f.respond(n => n === 1 ? response([{ functionCall: { name: "read_video", args: { paths: f.paths } } }]) : response());
  await f.start();
  assertToolScope(f, true);
  assert.equal(f.resources().loadExtensions, false);
  assert.equal(f.requests.length, 2);
  assert.equal(videoParts(f.requests[0]).length, 0);
  assert.deepEqual(videoParts(f.requests[1]).map(part => [part.mimeType, Buffer.from(part.data, "base64")]), [["video/mp4", mp4], ["video/avi", avi]]);
  assert.equal(f.requests[1].headers.get("authorization"), "Bearer isolated-subagent-video-key");
  const contents = f.requests[1].body.contents;
  const toolIndex = contents.findIndex(content => content.parts?.some(part => part.functionResponse?.name === "read_video"));
  assert.ok(toolIndex >= 0);
  assert.equal(contents[toolIndex + 1].role, "user");
  assert.equal(contents[toolIndex + 1].parts.filter(part => part.inlineData).length, 2);
  const saved = SessionManager.open(f.child.sessionFile).getEntries().filter(entry => entry.message?.details?.piWebVideos);
  assert.equal(saved.length, 1);
  assert.equal(f.child.inner.sessionManager.getEntries().some(entry => entry.message?.piWebVideos), false);
  const assertPrompt = () => {
    const prompt = JSON.stringify(f.requests.at(-1).body.systemInstruction);
    assert.match(prompt, /VIDEO_PROFILE/);
    assert.match(prompt, /VIDEO_SKILL_BODY/);
    assert.doesNotMatch(prompt, /You are an expert coding assistant/);
  };
  assertPrompt();
  await f.child.send({ type: "reload" });
  await f.resume();
  assertToolScope(f, true); assertPrompt();
  assert.equal(videoParts(f.requests.at(-1)).length, 2);
  const changed = Buffer.concat([mp4, Buffer.from("changed after first run")]);
  await writeFile(f.paths[0], changed);
  await f.child.shutdown();
  await f.resume();
  assert.equal(f.reopenCount, 1);
  assert.equal(f.child.isSubagent, true);
  assertToolScope(f, true); assertPrompt();
  assert.deepEqual(videoParts(f.requests.at(-1)).map(part => Buffer.from(part.data, "base64")), [changed, avi]);
  assert.deepEqual(f.child.inner.sessionManager.getEntries().filter(entry => entry.message?.details?.piWebVideos), saved);
});

test("all three built-in profiles can read video with extensions disabled and cold reopen", { timeout: 20000 }, async t => {
  const f = await fixture(t, ["tools: none"]);
  for (const profile of ["general-purpose", "explore", "plan"]) {
    const firstRequest = f.requests.length + 1;
    f.respond(n => n === firstRequest ? response([{ functionCall: { name: "read_video", args: { paths: [f.paths[0]] } } }]) : response());
    await f.start({ profile });
    assertToolScope(f, true);
    assert.equal(f.resources().loadExtensions, false);
    assert.equal(videoParts(f.requests.at(-1)).length, 1);
    await f.child.shutdown();
    await f.resume(); assertToolScope(f, true);
    assert.equal(videoParts(f.requests.at(-1)).length, 1);
  }
});

test("Windows PowerShell child snapshots preserve the resolved shell on cold resume", { timeout: 15000, skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t, ["tools: none"], { defaultTools: ["read", "powershell"] });
  await f.start({ profile: "general-purpose" });
  const tools = [...f.resources().tools];
  assert.ok(tools.includes("powershell"));
  assert.equal(tools.includes("bash"), false);
  assertToolScope(f, true);
  await f.child.shutdown();
  await writeFile(join(f.agentDir, "settings.json"), JSON.stringify({ ...settings, defaultTools: ["read", "bash"] }));
  await f.resume();
  assert.deepEqual(f.resources().tools, tools);
  assert.ok(f.child.inner.getActiveToolNames().includes("powershell"));
  assert.equal(f.child.inner.getActiveToolNames().includes("bash"), false);
  assertToolScope(f, true);
});

test("missing or invalid child resource snapshots fail closed before loading ordinary tools", { timeout: 15000 }, async t => {
  const f = await fixture(t, ["tools: read_video", "load_extensions: false"]);
  await f.start();
  const file = f.child.sessionFile, id = f.child.inner.sessionId;
  await f.child.shutdown();
  const original = await readFile(file, "utf8");
  const count = f.requests.length;
  for (const invalid of [undefined, null, { version: 99 }, { version: 1, appendSystemPrompt: [], tools: ["Agent"] }]) {
    const entries = original.trimEnd().split("\n").map(line => JSON.parse(line));
    entries.find(entry => entry.customType === SUBAGENT_META_TYPE).data.resourceSnapshot = invalid;
    await writeFile(file, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    await assert.rejects(startRpcSession(id, file, undefined, { headless: true }), /resource snapshot is missing or invalid/);
    assert.equal(f.requests.length, count);
  }
});

for (const [tools, extensions] of [["read", false], ["read", true], ["none", false]]) {
  test(`subagent explicit ${tools} scope stays video-free through reload and cold resume (extensions=${extensions})`, { timeout: 15000 }, async t => {
    const f = await fixture(t, [`tools: ${tools}`, `load_extensions: ${extensions}`], { extension: extensions ? legacyExtension : undefined });
    await f.start(); assertToolScope(f, false);
    await f.child.send({ type: "reload" });
    await f.resume(); assertToolScope(f, false);
    // The saved scope, not an edited profile or newer defaults, owns a reopened session.
    await writeFile(join(f.agentDir, "agents", "video.md"), "---\ntools: all\n---\nWider profile after creation.\n");
    await f.child.shutdown();
    await f.resume(); assertToolScope(f, false);
    assert.equal(f.reopenCount, 1);
    assert.ok(f.requests.every(request => videoParts(request).length === 0));
  });
}

for (const scoped of [true, false]) {
  test(`subagent video selects the scoped provider without losing the host fallback (legacy kept=${scoped})`, { timeout: 15000 }, async t => {
    const f = await fixture(t, ["tools: read_video", "load_extensions: true", `extensions: ${scoped ? "legacy-video" : "[]"}`], { extension: legacyExtension });
    await f.start(); assertToolScope(f, true);
    const assertProvider = () => {
      const tool = f.child.inner.getAllTools().find(tool => tool.name === "read_video");
      assert.equal(tool.description.includes("LEGACY_VIDEO_TOOL"), scoped);
      assert.equal(f.child.inner.resourceLoader.getExtensions().errors.some(error => error.error.includes('Tool "read_video" conflicts')), false);
    };
    assertProvider();
    await f.child.send({ type: "reload" });
    await f.resume(); assertProvider();
    await f.child.shutdown();
    await f.resume(); assertToolScope(f, true); assertProvider();
    if (scoped) {
      await unlink(join(f.agentDir, "extensions", "legacy-video.ts"));
      await f.child.send({ type: "reload" });
      await f.resume();
      assert.equal(f.child.inner.getAllTools().find(tool => tool.name === "read_video").description.includes("LEGACY_VIDEO_TOOL"), false);
    }
  });
}

for (const selector of ["ext:legacy-video/read_video", "ext:*"]) {
  for (const denied of [false, true]) {
    test(`explicit ${selector} can retain legacy video unless denied (denied=${denied})`, { timeout: 15000 }, async t => {
      const f = await fixture(t, [`tools: read, ${selector}`, "load_extensions: true", ...(denied ? ["disallowed_tools: read_video"] : [])], { extension: legacyExtension });
      await f.start(); assertToolScope(f, !denied);
      await f.child.send({ type: "reload" });
      await f.resume(); assertToolScope(f, !denied);
      await f.child.shutdown();
      await f.resume(); assertToolScope(f, !denied);
    });
  }
}
