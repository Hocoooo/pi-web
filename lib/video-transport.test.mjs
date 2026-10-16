import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, truncateSync, unlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { buildSessionContext, resolveSessionPath } = await jiti.import("./session-reader.ts");
const { CHAT_ONLY_RESOURCE_LOADER_OPTIONS } = await jiti.import("./chat-only.ts");
const { createExactSystemPromptExtension } = await jiti.import("./exact-system-prompt.ts");
const { MAX_VIDEO_FILE_BYTES, MAX_VIDEO_REQUEST_BYTES, VIDEO_REQUEST_ENVELOPE_BYTES,
  VIDEO_GOOGLE_BASE_URL, VIDEO_MODEL_ID, parseVideoReference, validateVideoCommand } = await jiti.import("./video-attachments.ts");
const mp4 = readFileSync(fileURLToPath(new URL("./fixtures/video-attachments/red.mp4", import.meta.url)));
const avi = readFileSync(fileURLToPath(new URL("./fixtures/video-attachments/blue.avi", import.meta.url)));
const response = (parts = [{ text: "Captured answer" }]) => new Response(`data: ${JSON.stringify({
  candidates: [{ content: { parts }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 },
})}\n\n`, { headers: { "content-type": "text/event-stream" } });
const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

async function fixture(t, { extensions = [], tools = [], sessionFile, directory, modelApi = "anthropic-messages", provider = "tapsvc", settings = {}, chatOnly = false, convert, delegate } = {}) {
  const dir = directory ?? mkdtempSync(join(tmpdir(), "pi-video-wire-"));
  const cwd = join(dir, "workspace");
  mkdirSync(cwd, { recursive: true });
  const oldRoots = globalThis.__piAllowedRootsCache;
  // Do not scan the developer's real session catalogue for file roots.
  globalThis.__piAllowedRootsCache = { roots: new Set([cwd]), expiresAt: Infinity };
  const services = await createAgentSessionServices({ cwd, agentDir: join(dir, "agent"),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, providerRetry: { maxRetries: 0 }, cacheWarming: "off", ...settings }),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true,
      ...(chatOnly ? CHAT_ONLY_RESOURCE_LOADER_OPTIONS : {}),
      extensionFactories: chatOnly ? [createExactSystemPromptExtension(() => "Exact test chat prompt")] : extensions },
  });
  services.modelRuntime.registerProvider(provider, { api: modelApi, baseUrl: "https://llm-proxy.tapsvc.com", apiKey: "isolated-video-key",
    models: [{ id: VIDEO_MODEL_ID, name: "Isolated TapSVC", reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 1024 }],
  });
  const model = services.modelRuntime.getModel(provider, VIDEO_MODEL_ID);
  const sm = sessionFile ? SessionManager.open(sessionFile) : SessionManager.create(cwd, join(dir, "sessions"));
  const { session } = await createAgentSessionFromServices({ services, model, thinkingLevel: "high", tools, sessionManager: sm });
  if (convert) {
    const original = session.agent.convertToLlm;
    session.agent.convertToLlm = async messages => convert(await original(messages));
  }
  if (delegate) session.agent.streamFunction = delegate;
  const wrapper = new AgentSessionWrapper(session, { headless: true, chatOnly });
  const requests = [];
  const events = [];
  let respond = () => response();
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    const raw = await req.text();
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(raw), bytes: Buffer.byteLength(raw) });
    return respond(requests.length, req);
  };
  const originalAuth = session.modelRuntime.getAuth.bind(session.modelRuntime);
  let authCalls = 0;
  session.modelRuntime.getAuth = (...args) => { authCalls++; return originalAuth(...args); };
  wrapper.onEvent(e => events.push(e));
  wrapper.start();
  wrapper.beginExtensionBinding();
  t.after(async () => {
    await wrapper.shutdown();
    globalThis.fetch = oldFetch;
    globalThis.__piAllowedRootsCache = oldRoots;
    if (!directory) rmSync(dir, { recursive: true, force: true });
  });
  function video(name = "clip.mp4", bytes = mp4) {
    const path = join(cwd, name);
    writeFileSync(path, bytes);
    return { version: 1, path, mimeType: name.endsWith(".avi") ? "video/avi" : "video/mp4" };
  }
  async function send(command) {
    const completed = Promise.withResolvers();
    const off = wrapper.onEvent(e => { if (e.type === "prompt_done") completed.resolve(); });
    try {
      await wrapper.send({ type: "prompt", message: "What is in the video?", ...command });
      await completed.promise;
      return session.messages.findLast(m => m.role === "assistant");
    } finally { off(); }
  }
  return { dir, cwd, session, sm, wrapper, requests, events, video, send,
    authCalls: () => authCalls, respond: fn => { respond = fn; } };
}

function videoParts(request) {
  return request.body.contents.flatMap((c, index) => (c.parts ?? []).filter(p => p.inlineData?.mimeType.startsWith("video/")).map(p => ({ index, role: c.role, ...p.inlineData })));
}

test("shared reference contract rejects unsupported command entrances without inferring text paths", () => {
  const ref = { version: 1, path: "/example/clip.mp4", mimeType: "video/mp4" };
  assert.deepEqual(parseVideoReference(ref), ref);
  for (const value of [null, [ref], { ...ref, version: 2 }, { ...ref, mimeType: "image/png" }]) assert.throws(() => parseVideoReference(value));
  for (const command of [{ type: "bash" }, { type: "ensure_session" },
    { type: "prompt", streamingBehavior: "invalid" }, { type: "prompt", message: "/new" }, { type: "prompt", message: " !ls" }, { type: "prompt", message: "" }]) {
    assert.throws(() => validateVideoCommand({ message: "question", ...command, video: ref }), /only on an ordinary/);
  }
  for (const command of [{ type: "steer" }, { type: "follow_up" }, { type: "prompt", streamingBehavior: "steer" }, { type: "prompt", streamingBehavior: "followUp" }]) {
    validateVideoCommand({ ...command, message: "Question", video: ref });
  }
  validateVideoCommand({ type: "prompt", message: "/example/clip.mp4" });
});

for (const [name, bytes, mimeType] of [["clip.mp4", mp4, "video/mp4"], ["clip.avi", avi, "video/avi"]]) {
  test(`${name}: real SDK prompt persists native user reference and native Google final wire contains original bytes`, { timeout: 15000 }, async t => {
    const f = await fixture(t);
    const ref = f.video(name, bytes);
    const before = f.sm.appendMessage({ role: "user", content: "Earlier unrelated question", timestamp: 1 });
    f.sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "Earlier answer" }], api: "anthropic-messages", provider: "tapsvc", model: VIDEO_MODEL_ID, usage: zeroUsage, stopReason: "stop", timestamp: 2 });
    const answer = await f.send({ video: ref });
    assert.equal(answer.stopReason, "stop", answer.errorMessage);
    assert.equal(answer.usage.input, 10);
    assert.equal(answer.usage.output, 2);
    assert.equal(f.requests.length, 1);
    const request = f.requests[0];
    assert.equal(request.url, `${VIDEO_GOOGLE_BASE_URL}/models/${VIDEO_MODEL_ID}:streamGenerateContent?alt=sse`);
    assert.equal(request.headers.get("authorization"), "Bearer isolated-video-key");
    assert.equal(request.headers.get("content-type"), "application/json");
    assert.equal(request.body.generationConfig.thinkingConfig.thinkingLevel, "HIGH");
    assert(f.authCalls() > 0, "native adapter must not bypass SDK auth");
    const parts = videoParts(request);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].mimeType, mimeType);
    assert.equal(parts[0].role, "user");
    assert.equal(parts[0].index, 2, "not the unrelated first user or system");
    assert.equal(request.body.contents[2].parts[0].text, "What is in the video?");
    assert.deepEqual(Buffer.from(parts[0].data, "base64"), bytes);
    assert(request.bytes < MAX_VIDEO_REQUEST_BYTES);
    assert.equal(f.session.model.api, "anthropic-messages", "do not rewrite the selected model/global config");
    assert.equal(f.session.model.provider, "tapsvc", "use the actual configured provider ID without renaming it");
    assert.equal(f.session.model.id, VIDEO_MODEL_ID);
    const lines = readFileSync(f.sm.getSessionFile(), "utf8").trim().split("\n").map(JSON.parse);
    const owner = lines.find(e => e.message?.piWebVideo);
    assert.equal(owner.type, "message");
    assert.equal(owner.message.role, "user");
    assert.deepEqual({ ...owner.message.piWebVideo, id: undefined }, { ...ref, id: undefined });
    assert.match(owner.message.piWebVideo.id, /^[0-9a-f-]{36}$/);
    assert.notEqual(owner.id, before);
    assert(!JSON.stringify(lines).includes(parts[0].data), "session JSONL stores a reference, not video Base64");
    assert.deepEqual(f.events.find(e => e.type === "message_end" && e.message?.piWebVideo).message.piWebVideo, owner.message.piWebVideo);
    assert.deepEqual(SessionManager.open(f.sm.getSessionFile()).buildSessionContext().messages.find(m => m.piWebVideo).piWebVideo, owner.message.piWebVideo);
    assert.deepEqual(buildSessionContext(lines.slice(1), f.sm.getLeafId()).messages.find(m => m.piWebVideo).piWebVideo, owner.message.piWebVideo);
    assert.equal(f.session.getLastAssistantText(), "Captured answer");
  });
}

test("the former TapSVC spelling is not an alias for the actual tapsvc target", async t => {
  const f = await fixture(t, { provider: "TapSVC" });
  await assert.rejects(f.send({ video: f.video() }), /Video requires tapsvc/);
  assert.equal(f.requests.length, 0);
  assert.equal(f.session.messages.some(m => m.piWebVideo), false);
});

test("reopen uses persisted owner, not last user; reads the current bytes at the reference", { timeout: 15000 }, async t => {
  const first = await fixture(t);
  const ref = first.video();
  await first.send({ video: ref });
  const file = first.sm.getSessionFile();
  await first.wrapper.shutdown();
  const f = await fixture(t, { directory: first.dir, sessionFile: file });
  const changed = Buffer.concat([mp4, Buffer.from("current file bytes")]);
  writeFileSync(ref.path, changed);
  const answer = await f.send({ message: "Follow-up without a new attachment" });
  assert.equal(answer.stopReason, "stop", answer.errorMessage);
  const parts = videoParts(f.requests[0]);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].index, 0);
  assert.deepEqual(Buffer.from(parts[0].data, "base64"), changed);
  assert(!f.requests[0].body.contents.at(-1).parts.some(p => p.inlineData));
});

// Ticket 08: the current concrete combination, not a Gemini display name.
for (const sourceApi of ["anthropic-messages", "google-generative-ai"]) {
  for (const mismatch of ["provider", "model", "origin", "protocol"]) {
    test(`${sourceApi}: ${mismatch} mismatch refuses new and effective-context video before acceptance; switching back continues`, { timeout: 15000 }, async t => {
      const f = await fixture(t, { modelApi: sourceApi });
      const ref = f.video();
      const runtime = f.session.modelRuntime;
      const target = { ...f.session.model };
      const bad = { ...target, name: target.name,
        ...(mismatch === "provider" ? { provider: "other-google" } : {}),
        ...(mismatch === "model" ? { id: "google/other-gemini" } : {}),
        ...(mismatch === "origin" ? { baseUrl: "https://not-tapsvc.invalid" } : {}),
        ...(mismatch === "protocol" ? { api: "openai-completions" } : {}),
      };
      const register = model => runtime.registerProvider(model.provider, { api: model.api, baseUrl: model.baseUrl, apiKey: "isolated-video-key", models: [model] });
      const select = model => f.wrapper.send({ type: "set_model", provider: model.provider, modelId: model.id, thinkingLevel: "high" });
      register(bad);
      await select(bad);
      await assert.rejects(f.send({ video: ref }), /Video requires tapsvc/);
      assert.equal(f.requests.length, 0);
      assert.equal(f.sm.getEntries().some(e => e.message?.role === "user"), false);
      register(target); await select(target);
      assert.equal((await f.send({ video: ref })).stopReason, "stop");
      const owner = structuredClone(f.sm.getEntries().find(e => e.message?.piWebVideo));
      register(bad); await select(bad);
      const before = f.sm.getEntries().filter(e => e.message?.role === "user");
      await assert.rejects(f.send({ message: "Keep this follow-up and its image", images: [{ type: "image", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9xkAAAAASUVORK5CYII=", mimeType: "image/png" }] }), /Video requires tapsvc/);
      assert.equal(f.requests.length, 1, "zero text-only/reduced-media fetch after switching");
      assert.deepEqual(f.sm.getEntries().filter(e => e.message?.role === "user"), before, "rejected input is not accepted/persisted");
      assert.equal(f.session.model.provider, bad.provider);
      assert.equal(f.session.model.id, bad.id, "no automatic model switch");
      register(target); await select(target);
      assert.equal((await f.send({ message: "Explicit continuation after switching back" })).stopReason, "stop");
      assert.equal(f.requests.length, 2);
      assert.deepEqual(Buffer.from(videoParts(f.requests[1])[0].data, "base64"), mp4);
      assert.deepEqual(f.sm.getEntries().filter(e => e.message?.piWebVideo), [owner]);
    });
  }
}

test("a raw historical video does not block an unsupported model when its native owner is outside effective context", { timeout: 15000 }, async t => {
  const f = await fixture(t, { modelApi: "google-generative-ai" });
  await f.send({ video: f.video() });
  const owner = f.sm.getEntries().find(e => e.message?.piWebVideo);
  await f.wrapper.send({ type: "navigate_tree", targetId: owner.id }); // SDK lands before the user.
  assert(f.sm.getEntries().some(e => e.message?.piWebVideo));
  assert(!f.sm.buildSessionProjection().messages.some(m => m.piWebVideo));
  f.session.modelRuntime.registerProvider("other-google", { api: "google-generative-ai", baseUrl: "https://not-tapsvc.invalid", apiKey: "isolated-other-key", models: [{ ...f.session.model, baseUrl: "https://not-tapsvc.invalid" }] });
  await f.wrapper.send({ type: "set_model", provider: "other-google", modelId: VIDEO_MODEL_ID });
  assert.equal((await f.send({ message: "Ordinary text before the video" })).stopReason, "stop");
  assert.equal(f.requests.length, 2);
  assert.equal(videoParts(f.requests[1]).length, 0);
  assert.equal(f.session.model.provider, "other-google");
  assert.match(f.requests[1].url, /^https:\/\/not-tapsvc\.invalid\//);
});

test("effective-context follow-up still checks the actual model after a successful admission check", { timeout: 15000 }, async t => {
  let change = false;
  const f = await fixture(t, { extensions: [pi => pi.on("before_agent_start", () => {
    if (change) f.session.agent.state.model.provider = "other-google";
  })] });
  await f.send({ video: f.video() });
  change = true;
  const answer = await f.send({ message: "An extension changes the request model after admission" });
  assert.equal(answer.stopReason, "error"); assert.match(answer.errorMessage, /Video requires tapsvc/);
  assert.equal(f.requests.length, 1, "no text-only fallback after the accepted model changes");
  assert.equal(f.sm.getEntries().filter(e => e.message?.piWebVideo).length, 1);
});

// Ticket 04: drive durable reopen/continuation through real SDK sessions. Only
// the final Google fetch is intercepted; no video Base64 or owner map is seeded.
for (const [name, bytes] of [["reopen.mp4", mp4], ["reopen.avi", avi]]) {
  test(`${name}: repeated ordinary follow-ups survive runtime disposal and disk reopen`, { timeout: 15000 }, async t => {
    const first = await fixture(t);
    const ref = first.video(name, bytes);
    assert.equal((await first.send({ video: ref })).stopReason, "stop");
    const file = first.sm.getSessionFile();
    const owner = first.sm.getEntries().find(e => e.message?.piWebVideo);
    const originalRef = structuredClone(owner.message.piWebVideo);
    let current = first;
    for (let round = 0; round < 3; round++) {
      if (round !== 1) {
        await current.wrapper.shutdown();
        assert.equal(current.wrapper.isAlive(), false);
        const previous = current;
        current = await fixture(t, { directory: first.dir, sessionFile: file });
        assert.notEqual(current.sm, previous.sm);
        assert.notEqual(current.session, previous.session);
      }
      const message = `Follow-up ${round}: @missing.avi and /not-authorized/missing.mp4 are only text`;
      const before = current.requests.length;
      const answer = await current.send({ message });
      assert.equal(answer.stopReason, "stop", answer.errorMessage);
      assert.equal(current.requests.length, before + 1);
      const request = current.requests.at(-1), parts = videoParts(request);
      assert.equal(parts.length, 1);
      assert.equal(parts[0].index, 0);
      assert.equal(parts[0].role, "user");
      assert.equal(parts[0].mimeType, ref.mimeType);
      assert.deepEqual(Buffer.from(parts[0].data, "base64"), bytes);
      assert.deepEqual(request.body.contents.at(-1).parts, [{ text: message }]);
      const saved = SessionManager.open(file).getEntries().filter(e => e.message?.piWebVideo);
      assert.equal(saved.length, 1, "ordinary follow-ups never duplicate native references");
      assert.equal(saved[0].id, owner.id);
      assert.deepEqual(saved[0].message.piWebVideo, originalRef);
    }
  });
}

async function twoOwners(t, options) {
  const first = await fixture(t, options);
  const refs = [first.video("first.mp4", mp4), first.video("second.avi", avi)];
  // Identical questions deliberately rule out text matching as owner identity.
  for (const video of refs) assert.equal((await first.send({ message: "Describe this clip", video })).stopReason, "stop");
  const saved = first.sm.getEntries().filter(e => e.message?.piWebVideo);
  assert.equal(saved.length, 2);
  assert.notEqual(saved[0].message.piWebVideo.id, saved[1].message.piWebVideo.id);
  await first.wrapper.shutdown();
  const f = await fixture(t, { ...options, directory: first.dir, sessionFile: first.sm.getSessionFile() });
  assert.deepEqual(f.sm.getEntries().filter(e => e.message?.piWebVideo), saved);
  return { ...f, refs, saved };
}

function assertTwoOwners(request, bytes = [mp4, avi]) {
  const parts = videoParts(request);
  assert.deepEqual(parts.map(p => [p.index, p.role, p.mimeType]), [[0, "user", "video/mp4"], [2, "user", "video/avi"]]);
  parts.forEach((part, i) => assert.deepEqual(Buffer.from(part.data, "base64"), bytes[i]));
  for (const index of [0, 2]) assert.equal(request.body.contents[index].parts[0].text, "Describe this clip");
  assert(!request.body.contents.at(-1).parts.some(p => p.inlineData?.mimeType.startsWith("video/")), "never append old videos to the newest question/tool result");
}

test("reopened MP4 and AVI keep distinct owners across repeated unbound text-path questions", { timeout: 15000 }, async t => {
  const f = await twoOwners(t);
  for (let n = 0; n < 2; n++) {
    const message = `Compare both clips ${n}; /not-authorized/unbound.mp4 and @missing.avi are text only`;
    const answer = await f.send({ message });
    assert.equal(answer.stopReason, "stop", answer.errorMessage);
    assertTwoOwners(f.requests[n]);
    assert.deepEqual(f.requests[n].body.contents.at(-1).parts, [{ text: message }]);
  }
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.sm.getEntries().filter(e => e.message?.piWebVideo), f.saved);
});

test("reopened two-owner follow-up rereads current bytes for every same-run tool continuation", { timeout: 15000 }, async t => {
  let refs, executions = 0;
  const changed = Buffer.concat([mp4, Buffer.from("updated by isolated tool")]);
  const options = { extensions: [pi => pi.registerTool({ name: "fixture_check", label: "Check", description: "Test-only", parameters: Type.Object({}), execute: async () => {
    executions++;
    writeFileSync(refs[0].path, changed);
    return { content: [{ type: "text", text: "checked; /not-authorized/missing.mp4 is not an attachment" }] };
  } })], tools: ["fixture_check"] };
  const f = await twoOwners(t, options);
  refs = f.refs;
  f.respond(n => n < 3 ? response([{ functionCall: { name: "fixture_check", args: {} } }]) : response());
  const answer = await f.send({ message: "Check both videos with the tool twice" });
  assert.equal(answer.stopReason, "stop", answer.errorMessage);
  assert.equal(executions, 2);
  assert.equal(f.requests.length, 3, "one explicit prompt, two native tool continuations");
  f.requests.forEach((request, i) => {
    assertTwoOwners(request, [i === 0 ? mp4 : changed, avi]);
    assert.equal(request.body.contents.flatMap(c => c.parts).filter(p => p.functionResponse).length, i);
  });
  assert.deepEqual(f.sm.getEntries().filter(e => e.message?.piWebVideo), f.saved);
});

for (const kind of ["cumulative media", "complete request"]) {
  test(`reopened ${kind} overflow fails whole request and preserves both native owners`, { timeout: 20000 }, async t => {
    const first = await fixture(t);
    const large = Buffer.alloc((kind === "cumulative media" ? 13 : 11) * 1024 * 1024);
    mp4.copy(large);
    const refs = [first.video("large-one.mp4", large), first.video("large-two.mp4", large)];
    assert.equal((await first.send({ video: refs[0] })).stopReason, "stop");
    const second = await first.send({ video: refs[1] });
    assert.equal(second.stopReason, kind === "cumulative media" ? "error" : "stop");
    if (kind === "cumulative media") assert.match(second.errorMessage, /32 MiB/);
    const saved = first.sm.getEntries().filter(e => e.message?.piWebVideo);
    assert.equal(saved.length, 2);
    await first.wrapper.shutdown();
    let delegates = 0;
    const f = await fixture(t, { directory: first.dir, sessionFile: first.sm.getSessionFile(), delegate: () => { delegates++; throw new Error("Text-only fallback"); } });
    const answer = await f.send({ message: kind === "complete request" ? "文".repeat(1024 * 1024) : "Compare both persisted videos" });
    assert.equal(answer.stopReason, "error", answer.errorMessage);
    assert.match(answer.errorMessage, /32 MiB/);
    assert.equal(f.requests.length, 0, "no reduced-media or text-only fetch may escape");
    assert.equal(delegates, 0);
    assert.deepEqual(f.sm.getEntries().filter(e => e.message?.piWebVideo), saved);
    // The failing question/owners stay in history. Reducing the current file,
    // not deleting an owner or auto-retrying, permits the next explicit prompt.
    writeFileSync(refs[1].path, mp4);
    const fixed = await f.send({ message: "Try the current files now" });
    assert.equal(fixed.stopReason, "stop", fixed.errorMessage);
    assert.equal(f.requests.length, 1);
    const parts = videoParts(f.requests[0]);
    assert.deepEqual(parts.map(p => p.index), [0, 2]);
    assert.deepEqual(Buffer.from(parts[0].data, "base64"), large);
    assert.deepEqual(Buffer.from(parts[1].data, "base64"), mp4);
    assert(f.requests[0].bytes < MAX_VIDEO_REQUEST_BYTES);
    assert.equal(delegates, 0);
  });
}

for (const kind of ["missing", "unreadable"]) {
  test(`reopened follow-up refuses the ${kind} older video instead of sending only the newer one`, { timeout: 15000, skip: kind === "unreadable" && (process.platform === "win32" || process.getuid?.() === 0) }, async t => {
    let delegates = 0;
    const f = await twoOwners(t, { delegate: () => { delegates++; throw new Error("Text-only fallback"); } });
    if (kind === "missing") unlinkSync(f.refs[0].path);
    else chmodSync(f.refs[0].path, 0);
    try {
      const answer = await f.send({ message: "Compare both clips without reattaching" });
      assert.equal(answer.stopReason, "error", answer.errorMessage);
      assert.match(answer.errorMessage, kind === "missing" ? /missing or outside/ : /EACCES|permission denied/i);
      assert.equal(f.requests.length, 0);
      assert.equal(delegates, 0);
      assert.deepEqual(f.sm.getEntries().filter(e => e.message?.piWebVideo), f.saved);
    } finally {
      if (kind === "missing") writeFileSync(f.refs[0].path, mp4);
      else chmodSync(f.refs[0].path, 0o600);
    }
    const fixed = await f.send({ message: "Explicitly retry with both current files" });
    assert.equal(fixed.stopReason, "stop", fixed.errorMessage);
    assert.equal(f.requests.length, 1);
    assertTwoOwners(f.requests[0]);
  });
}

for (const kind of ["missing file", "tool output overflow"]) {
  test(`reopened same-run ${kind} stops before a stripped continuation can leave`, { timeout: 20000 }, async t => {
    let refs, executions = 0, delegates = 0;
    const options = { extensions: [pi => pi.registerTool({ name: "fixture_check", label: "Check", description: "Test-only", parameters: Type.Object({}), execute: async () => {
      executions++;
      if (kind === "missing file") unlinkSync(refs[0].path);
      return { content: [{ type: "text", text: kind === "tool output overflow" ? "x".repeat(MAX_VIDEO_REQUEST_BYTES) : "file removed" }] };
    } })], tools: ["fixture_check"], delegate: () => { delegates++; throw new Error("Text-only fallback"); } };
    const f = await twoOwners(t, options);
    refs = f.refs;
    f.respond(() => response([{ functionCall: { name: "fixture_check", args: {} } }]));
    const answer = await f.send({ message: "Check both videos" });
    assert.equal(answer.stopReason, "error", answer.errorMessage);
    assert.match(answer.errorMessage, kind === "missing file" ? /missing or outside/ : /32 MiB/);
    assert.equal(executions, 1);
    assert.equal(f.requests.length, 1, "initial complete request only; no degraded second fetch");
    assertTwoOwners(f.requests[0]);
    assert.equal(delegates, 0);
    assert.deepEqual(f.sm.getEntries().filter(e => e.message?.piWebVideo), f.saved);
  });
}

// Ticket 06: native tree navigation/copy, never a second media/branch store.
async function branchFixture(t, options = {}) {
  const f = await fixture(t, { modelApi: "google-generative-ai", ...options });
  const prior = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(f.dir, "agent");
  t.after(() => { if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior; });
  await f.send({ message: "Before either video" });
  const base = f.sm.getLeafId();
  const refs = [f.video("branch-a.mp4", mp4), f.video("branch-b.avi", avi)];
  await f.send({ message: "Describe this clip", video: refs[0] });
  const a = f.sm.getLeafId();
  await f.wrapper.send({ type: "navigate_tree", targetId: base });
  assert.equal(f.sm.getLeafId(), base);
  await f.send({ message: "Describe this clip", video: refs[1] });
  const b = f.sm.getLeafId();
  const saved = f.sm.getEntries().filter(e => e.message?.piWebVideo);
  assert.equal(saved.length, 2);
  assert.notEqual(saved[0].message.piWebVideo.id, saved[1].message.piWebVideo.id);
  return { ...f, refs, base, a, b, saved };
}

function assertBranchWire(request, expected) {
  assert.equal(request.url, `${expected.length ? VIDEO_GOOGLE_BASE_URL : "https://llm-proxy.tapsvc.com"}/models/${VIDEO_MODEL_ID}:streamGenerateContent?alt=sse`);
  if (expected.length) assert.equal(request.headers.get("authorization"), "Bearer isolated-video-key");
  const parts = videoParts(request);
  assert.equal(parts.length, expected.length, "no sibling, removed or last-selected video may be injected");
  parts.forEach((part, i) => {
    assert.equal(part.role, "user");
    assert.equal(part.mimeType, expected[i].mimeType);
    assert.deepEqual(Buffer.from(part.data, "base64"), expected[i].bytes);
    assert.equal(request.body.contents[part.index].parts[0].text, expected[i].question ?? "Describe this clip");
  });
  assert(!request.body.contents.at(-1).parts.some(p => p.inlineData?.mimeType.startsWith("video/")), "ordinary follow-up is not the video owner");
}

// Ticket 09: one representative cross-feature path, not a permutation matrix.
test("integrated branch clone, model switch and Stop retain one queued video owner through cold reopen", { timeout: 25000 }, async t => {
  const first = await branchFixture(t);
  await first.wrapper.send({ type: "navigate_tree", targetId: first.a });
  const sourceBytes = readFileSync(first.sm.getSessionFile());
  const result = await first.wrapper.send({ type: "clone", leafId: first.a });
  const file = await resolveSessionPath(result.newSessionId);
  await first.wrapper.shutdown();
  unlinkSync(first.refs[1].path); // Missing sibling media must never be read by the child.
  const f = await fixture(t, { directory: first.dir, sessionFile: file, modelApi: "google-generative-ai" });
  assert.deepEqual(f.sm.getEntries().filter(e => e.message?.piWebVideo), [first.saved[0]]);
  const target = { ...f.session.model }, runtime = f.session.modelRuntime;
  runtime.registerProvider("other-google", { api: target.api, baseUrl: target.baseUrl, apiKey: "isolated-other-key", models: [{ ...target, provider: "other-google" }] });
  const select = provider => f.wrapper.send({ type: "set_model", provider, modelId: target.id, thinkingLevel: "high" });
  const png = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9xkAAAAASUVORK5CYII=" };
  await select("other-google");
  const usersBefore = f.sm.getEntries().filter(e => e.message?.role === "user").length;
  await assert.rejects(f.send({ message: "Unsupported child follow-up", images: [png] }), /Video requires tapsvc/);
  assert.equal(f.requests.length, 0);
  assert.equal(f.sm.getEntries().filter(e => e.message?.role === "user").length, usersBefore);
  await select("tapsvc");

  const started = Promise.withResolvers(), stopped = Promise.withResolvers();
  const off = f.wrapper.onEvent(e => { if (e.type === "prompt_done") stopped.resolve(); });
  f.respond((n, request) => n === 1 ? new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "Holding child answer" }] } }] })}\n\n`));
    request.signal.addEventListener("abort", () => controller.error(new DOMException("Stopped", "AbortError")), { once: true });
    started.resolve();
  } }), { headers: { "content-type": "text/event-stream" } }) : response());
  await f.wrapper.send({ type: "prompt", message: "Hold cloned branch" }); await started.promise;
  const video = f.video("queued-child.avi", avi);
  await f.wrapper.send({ type: "prompt", message: "Describe this clip", video, images: [png], streamingBehavior: "followUp" });
  const queued = (await f.wrapper.send({ type: "get_state" })).queuedMessages.inputs.followUp[0];
  assert.deepEqual(queued.images, [png]); assert.equal(queued.video.path, video.path);
  assert.notEqual(queued.video.id, first.saved[1].message.piWebVideo.id, "same text/format is not the sibling owner");
  assert.equal(f.requests.length, 1); assert.equal(f.sm.getEntries().filter(e => e.message?.piWebVideo).length, 1);
  await f.wrapper.send({ type: "abort" }); await stopped.promise; off(); await f.session.waitForIdle();
  assert.equal(f.session.pendingMessageCount, 1); assert.equal(f.requests.length, 1, "Stop does not resend or consume the queued video");

  await select("other-google");
  await assert.rejects(f.send({ message: "Rejected while queue retained" }), /Video requires tapsvc/);
  assert.equal(f.requests.length, 1); assert.equal(f.session.pendingMessageCount, 1);
  assert.deepEqual((await f.wrapper.send({ type: "get_state" })).queuedMessages.inputs.followUp, [queued]);
  await select("tapsvc");
  assert.equal((await f.send({ message: "Explicitly continue cloned branch" })).stopReason, "stop");
  assert.equal(f.session.pendingMessageCount, 0);
  assert.deepEqual(f.requests.map(r => videoParts(r).map(p => p.mimeType)), [["video/mp4"], ["video/mp4"], ["video/mp4", "video/avi"]]);
  const saved = f.sm.getEntries().filter(e => e.message?.piWebVideo);
  assert.deepEqual(saved[0], first.saved[0]); assert.equal(saved.length, 2);
  assert.deepEqual(saved[1].message.piWebVideo, queued.video);
  assert.deepEqual(saved[1].message.content.filter(p => p.type === "image"), [png]);
  const final = f.requests.at(-1), parts = videoParts(final);
  assert.deepEqual(parts.map(p => final.body.contents[p.index].parts[0].text), ["Describe this clip", "Describe this clip"]);
  assert.deepEqual(parts.map(p => Buffer.from(p.data, "base64")), [mp4, avi]);
  assert.equal(final.body.contents[parts[1].index].parts.filter(p => p.inlineData?.mimeType === "image/png").length, 1);
  assert.equal(final.body.contents[parts[1].index].parts.find(p => p.inlineData?.mimeType === "image/png").inlineData.data, png.data);
  assert.deepEqual(readFileSync(first.sm.getSessionFile()), sourceBytes, "child queue/model operations do not mutate the source branch");

  await f.wrapper.shutdown();
  const cold = await fixture(t, { directory: first.dir, sessionFile: file, modelApi: "google-generative-ai" });
  assert.equal((await cold.send({ message: "Cold child follow-up" })).stopReason, "stop");
  assert.deepEqual(cold.sm.getEntries().filter(e => e.message?.piWebVideo), saved);
  assertBranchWire(cold.requests[0], [{ mimeType: "video/mp4", bytes: mp4 }, { mimeType: "video/avi", bytes: avi }]);
  assert.equal(cold.session.pendingMessageCount, 0);
});

test("native sibling navigation and cold reopen send only the inherited user's current video", { timeout: 20000 }, async t => {
  const first = await branchFixture(t);
  assert.deepEqual(videoParts(first.requests.at(-1)).map(p => p.mimeType), ["video/avi"]);
  const file = first.sm.getSessionFile();
  let f = first;
  for (const [leaf, index, bytes] of [[first.a, 0, mp4], [first.b, 1, avi]]) {
    await f.wrapper.send({ type: "navigate_tree", targetId: leaf });
    const history = buildSessionContext(f.sm.getEntries(), f.sm.getLeafId());
    assert.deepEqual(history.messages.filter(m => m.piWebVideo).map(m => [m.piWebVideo, m.piWebVideoInContext]), [[first.saved[index].message.piWebVideo, true]]);
    unlinkSync(first.refs[1 - index].path); // A non-inherited missing video must not even be read.
    const changed = Buffer.concat([bytes, Buffer.from(`current branch ${index}`)]);
    writeFileSync(first.refs[index].path, changed);
    assert.equal((await f.send({ message: "Continue this branch" })).stopReason, "stop");
    assertBranchWire(f.requests.at(-1), [{ mimeType: first.refs[index].mimeType, bytes: changed }]);
    await f.wrapper.shutdown();
    f = await fixture(t, { directory: first.dir, sessionFile: file, modelApi: "google-generative-ai" });
    assert.equal((await f.send({ message: "Cold branch follow-up" })).stopReason, "stop");
    assertBranchWire(f.requests.at(-1), [{ mimeType: first.refs[index].mimeType, bytes: changed }]);
    writeFileSync(first.refs[1 - index].path, index === 0 ? avi : mp4);
  }
  assert.deepEqual(f.sm.getEntries().filter(e => e.message?.piWebVideo), first.saved, "navigation never rewrites either raw owner");
  // SDK user targets navigate BEFORE that user, unlike assistant targets.
  await f.wrapper.send({ type: "navigate_tree", targetId: first.saved[0].id });
  assert.equal(f.sm.getLeafId(), first.saved[0].parentId);
  assert.equal((await f.send({ message: "New branch before the video; @branch-a.mp4 is text" })).stopReason, "stop");
  assertBranchWire(f.requests.at(-1), []);
});

test("navigation-only cold reopen uses the SDK's persisted branch, with matching UI and media", { timeout: 15000 }, async t => {
  const first = await branchFixture(t);
  await first.wrapper.send({ type: "navigate_tree", targetId: first.a });
  assert.deepEqual(buildSessionContext(first.sm.getEntries(), first.sm.getLeafId()).messages.filter(m => m.piWebVideo).map(m => m.piWebVideo), [first.saved[0].message.piWebVideo]);
  const file = first.sm.getSessionFile();
  await first.wrapper.shutdown();
  // SDK navigation alone changes an in-memory leaf; no independent durable
  // selection is invented by video attachments. Disk still ends on branch B.
  const f = await fixture(t, { directory: first.dir, sessionFile: file, modelApi: "google-generative-ai" });
  assert.equal(f.sm.getLeafId(), first.b);
  assert.deepEqual(buildSessionContext(f.sm.getEntries(), f.sm.getLeafId()).messages.filter(m => m.piWebVideo).map(m => m.piWebVideo), [first.saved[1].message.piWebVideo]);
  unlinkSync(first.refs[0].path);
  assert.equal((await f.send({ message: "Continue the actually reopened branch" })).stopReason, "stop");
  assertBranchWire(f.requests.at(-1), [{ mimeType: "video/avi", bytes: avi }]);
});

for (const kind of ["fork", "fork_branch", "clone"]) {
  for (const branch of [0, 1]) {
    test(`${kind} branch ${branch}: native copy/reopen retains only actual owners, not files or sibling media`, { timeout: 20000 }, async t => {
      const first = await branchFixture(t);
      const leaf = branch === 0 ? first.a : first.b;
      // fork excludes its user target; the later plain question lets us fork
      // after the chosen video without attaching a new video to that question.
      await first.wrapper.send({ type: "navigate_tree", targetId: leaf });
      await first.send({ message: "Fork after this video" });
      const after = first.sm.getEntries().findLast(e => e.message?.role === "user");
      const sourceBytes = readFileSync(first.sm.getSessionFile());
      const result = await first.wrapper.send({ type: kind, ...(kind === "fork" ? { entryId: after.id } : kind === "clone" ? { leafId: leaf } : { entryId: leaf }) });
      assert.equal(result.cancelled, false);
      assert.notEqual(result.newSessionId, first.session.sessionId);
      const file = await resolveSessionPath(result.newSessionId);
      const copied = SessionManager.open(file);
      assert.equal(copied.getHeader().parentSession, first.sm.getSessionFile());
      assert.equal(copied.getCwd(), first.cwd);
      const inherited = copied.getEntries().filter(e => e.message?.piWebVideo);
      assert.deepEqual(inherited, [first.saved[branch]], "current SDK preserves entry IDs and nested metadata; no reconstruction by row/text");
      assert.deepEqual(readFileSync(first.sm.getSessionFile()), sourceBytes);
      await first.wrapper.shutdown();
      const bytes = Buffer.concat([branch === 0 ? mp4 : avi, Buffer.from("changed after copy")]);
      writeFileSync(first.refs[branch].path, bytes);
      unlinkSync(first.refs[1 - branch].path);
      let f = await fixture(t, { directory: first.dir, sessionFile: file, modelApi: "google-generative-ai" });
      assert.equal((await f.send({ message: "Copied conversation follow-up" })).stopReason, "stop");
      assertBranchWire(f.requests.at(-1), [{ mimeType: first.refs[branch].mimeType, bytes }]);
      await f.wrapper.shutdown();
      f = await fixture(t, { directory: first.dir, sessionFile: file, modelApi: "google-generative-ai" });
      assert.equal((await f.send({ message: "Reopen the copy again" })).stopReason, "stop");
      assertBranchWire(f.requests.at(-1), [{ mimeType: first.refs[branch].mimeType, bytes }]);
      assert.deepEqual(f.sm.getEntries().filter(e => e.message?.piWebVideo), inherited);
      // The same authorized lexical path now points outside every allowed root.
      // A copy must not acquire a file-read exception from historical metadata.
      const outside = join(first.dir, "outside.mp4"); writeFileSync(outside, mp4);
      unlinkSync(first.refs[branch].path); symlinkSync(outside, first.refs[branch].path);
      const before = f.requests.length;
      const answer = await f.send({ message: "Check the copied reference after a link change" });
      assert.equal(answer.stopReason, "error");
      assert.match(answer.errorMessage, /missing or outside/);
      assert.equal(f.requests.length, before, "no stripped-media or text-only fallback fetch");
      unlinkSync(first.refs[branch].path); writeFileSync(first.refs[branch].path, bytes);
      assert.equal((await f.send({ message: "Explicit follow-up after file repair" })).stopReason, "stop");
      assertBranchWire(f.requests.at(-1), [{ mimeType: first.refs[branch].mimeType, bytes }]);
    });
  }
}

for (const branch of [0, 1]) {
  test(`fork before branch ${branch} video excludes that user and every sibling video`, { timeout: 15000 }, async t => {
    const first = await branchFixture(t);
    const result = await first.wrapper.send({ type: "fork", entryId: first.saved[branch].id });
    const file = await resolveSessionPath(result.newSessionId);
    assert.equal(SessionManager.open(file).getEntries().some(e => e.message?.piWebVideo), false);
    await first.wrapper.shutdown();
    unlinkSync(first.refs[0].path); unlinkSync(first.refs[1].path);
    const f = await fixture(t, { directory: first.dir, sessionFile: file, modelApi: "google-generative-ai" });
    assert.equal((await f.send({ message: "A new branch before either video" })).stopReason, "stop");
    assertBranchWire(f.requests.at(-1), []);
  });
}

test("shared ancestor video and branch-local owners stay separate through clone/reopen", { timeout: 20000 }, async t => {
  const first = await fixture(t, { modelApi: "google-generative-ai" });
  const prior = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(first.dir, "agent");
  t.after(() => { if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior; });
  const refs = [first.video("shared.mp4", mp4), first.video("a.avi", avi), first.video("b.mp4", Buffer.concat([mp4, Buffer.from("other sibling")]))];
  await first.send({ message: "Shared video", video: refs[0] });
  const base = first.sm.getLeafId();
  await first.send({ message: "Describe this clip", video: refs[1] });
  const a = first.sm.getLeafId();
  await first.wrapper.send({ type: "navigate_tree", targetId: base });
  await first.send({ message: "Describe this clip", video: refs[2] });
  const b = first.sm.getLeafId();
  const saved = first.sm.getEntries().filter(e => e.message?.piWebVideo);
  const expected = [{ mimeType: "video/mp4", bytes: mp4, question: "Shared video" }];
  for (const [leaf, i, bytes] of [[a, 1, avi], [b, 2, readFileSync(refs[2].path)]]) {
    await first.wrapper.send({ type: "navigate_tree", targetId: leaf });
    assert.equal((await first.send({ message: "Compare shared and branch-local clips" })).stopReason, "stop");
    assertBranchWire(first.requests.at(-1), [...expected, { mimeType: refs[i].mimeType, bytes }]);
  }
  // Clone the non-current branch explicitly, not whatever media was sent last.
  const result = await first.wrapper.send({ type: "clone", leafId: a });
  const file = await resolveSessionPath(result.newSessionId);
  await first.wrapper.shutdown(); unlinkSync(refs[2].path);
  const f = await fixture(t, { directory: first.dir, sessionFile: file, modelApi: "google-generative-ai" });
  assert.deepEqual(f.sm.getEntries().filter(e => e.message?.piWebVideo), saved.slice(0, 2));
  assert.equal((await f.send({ message: "Cold non-current branch clone" })).stopReason, "stop");
  assertBranchWire(f.requests.at(-1), [...expected, { mimeType: "video/avi", bytes: avi }]);
});

test("fork before the first video persists an empty inherited conversation and sends no video after reopen", { timeout: 15000 }, async t => {
  const first = await fixture(t, { modelApi: "google-generative-ai" });
  const prior = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(first.dir, "agent");
  t.after(() => { if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior; });
  const ref = first.video();
  await first.send({ video: ref });
  const owner = first.sm.getEntries().find(e => e.message?.piWebVideo);
  const result = await first.wrapper.send({ type: "fork", entryId: owner.id });
  const file = await resolveSessionPath(result.newSessionId), copied = SessionManager.open(file);
  assert.equal(copied.getEntries().some(e => e.message?.role === "user"), false);
  assert.equal(copied.getHeader().parentSession, first.sm.getSessionFile());
  await first.wrapper.shutdown(); unlinkSync(ref.path);
  const f = await fixture(t, { directory: first.dir, sessionFile: file, modelApi: "google-generative-ai" });
  assert.equal((await f.send({ message: "First question in before-video fork" })).stopReason, "stop");
  assertBranchWire(f.requests.at(-1), []);
});

test("fork_branch includes a targeted video user while navigate_tree and fork exclude it", { timeout: 15000 }, async t => {
  const first = await branchFixture(t);
  const result = await first.wrapper.send({ type: "fork_branch", entryId: first.saved[0].id });
  const file = await resolveSessionPath(result.newSessionId);
  assert.deepEqual(SessionManager.open(file).getEntries().filter(e => e.message?.piWebVideo), [first.saved[0]]);
  await first.wrapper.shutdown(); unlinkSync(first.refs[1].path);
  const f = await fixture(t, { directory: first.dir, sessionFile: file, modelApi: "google-generative-ai" });
  assert.equal((await f.send({ message: "Continue inclusive branch copy" })).stopReason, "stop");
  assertBranchWire(f.requests.at(-1), [{ mimeType: "video/mp4", bytes: mp4 }]);
});

test("copy after actual compaction keeps raw references but sends only SDK-effective owners", { timeout: 20000 }, async t => {
  const first = await fixture(t, { modelApi: "google-generative-ai", settings: { compaction: { enabled: false, reserveTokens: 10000, keepRecentTokens: 300 } } });
  const prior = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(first.dir, "agent");
  t.after(() => { if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior; });
  const refs = [first.video("old.mp4", mp4), first.video("kept.avi", avi)];
  await first.send({ message: "Old clip", video: refs[0] });
  const question = `Kept clip ${"k".repeat(1600)}`;
  await first.send({ message: question, video: refs[1] });
  await first.wrapper.send({ type: "compact" });
  const saved = first.sm.getEntries().filter(e => e.message?.piWebVideo);
  assert.equal(first.sm.getEntries().filter(e => e.type === "compaction").length, 1);
  assert.deepEqual(first.sm.buildSessionContext().messages.filter(m => m.piWebVideo).map(m => m.piWebVideo), [saved[1].message.piWebVideo]);
  const result = await first.wrapper.send({ type: "clone", leafId: first.sm.getLeafId() });
  const file = await resolveSessionPath(result.newSessionId);
  await first.wrapper.shutdown();
  unlinkSync(refs[0].path);
  const f = await fixture(t, { directory: first.dir, sessionFile: file, modelApi: "google-generative-ai" });
  const history = buildSessionContext(f.sm.getEntries(), f.sm.getLeafId());
  assert.deepEqual(history.messages.filter(m => m.piWebVideo).map(m => m.piWebVideoInContext), [false, true]);
  assert.equal((await f.send({ message: "Cold copied compacted conversation" })).stopReason, "stop");
  assertBranchWire(f.requests.at(-1), [{ mimeType: "video/avi", bytes: avi, question }]);
  assert.deepEqual(f.sm.getEntries().filter(e => e.message?.piWebVideo), saved);
});

// Ticket 05: actual default SDK compaction, including its summarization request.
// No appendCompaction shortcut or hook-provided cut/summary: manual and threshold
// auto paths choose their own boundary, then the native adapter constructs fetch.
for (const mode of ["manual", "automatic"]) {
  test(`${mode} compaction sends only retained owners, never summary paths, and explicit reattachment restores input after reopen`, { timeout: 20000 }, async t => {
    const settings = { compaction: { enabled: mode === "automatic", reserveTokens: 10000, keepRecentTokens: 300 } };
    const first = await fixture(t, { modelApi: "google-generative-ai", settings });
    const refs = [first.video("removed.mp4", mp4), first.video("retained.avi", avi)];
    const summary = `Text description only: ${refs[0].path}, @removed.mp4, ${refs[1].path}, /not-authorized/missing.avi`;
    const summaryResponse = (high = false) => new Response(`data: ${JSON.stringify({
      candidates: [{ content: { parts: [{ text: summary }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: high ? 995000 : 10, candidatesTokenCount: 2, totalTokenCount: high ? 995002 : 12 },
    })}\n\n`, { headers: { "content-type": "text/event-stream" } });
    await first.send({ message: "Old clip", video: refs[0] });
    // The newest user span exceeds the keep budget, so SDK retains this user,
    // not all attachments and not none. Inflated *returned* usage triggers the
    // real automatic post-run threshold check, not the manual compact command.
    let answerSent = false;
    first.respond(() => { const high = mode === "automatic" && !answerSent; answerSent = true; return summaryResponse(high); });
    const keptQuestion = `Recent clip ${"r".repeat(1600)}`;
    assert.equal((await first.send({ message: keptQuestion, video: refs[1] })).stopReason, "stop");
    assert.deepEqual(videoParts(first.requests[1]).map(p => p.mimeType), ["video/mp4", "video/avi"], "before compaction both videos reach final fetch");
    const owners = first.sm.getEntries().filter(e => e.message?.piWebVideo);
    if (mode === "manual") await first.wrapper.send({ type: "compact" });
    const compacted = first.sm.getEntries().filter(e => e.type === "compaction");
    assert.equal(compacted.length, 1, JSON.stringify({ usage: first.session.messages.at(-1)?.usage, events: first.events.filter(e => e.type.startsWith("compaction")), settings: first.session.settingsManager.getCompactionSettings(first.session.model) }));
    assert.equal(compacted[0].firstKeptEntryId, owners[1].id, "real SDK cut retains exactly the newer owner");
    assert(compacted[0].summary.includes(refs[0].path));
    assert(first.events.some(e => e.type === "compaction_end" && e.reason === (mode === "manual" ? "manual" : "threshold") && e.result && !e.aborted));
    assert.equal(videoParts(first.requests[2]).length, 0, "SDK summarization is serialized text, not original media");
    assert.deepEqual(first.sm.buildSessionContext().messages.filter(m => m.piWebVideo).map(m => m.piWebVideo), [owners[1].message.piWebVideo]);
    const history = buildSessionContext(first.sm.getEntries(), first.sm.getLeafId());
    assert.deepEqual(history.messages.filter(m => m.piWebVideo).map(m => m.piWebVideoInContext), [false, true]);
    assert.equal(owners[0].message.piWebVideoInContext, undefined, "UI annotation never mutates native metadata");
    // Removed files cannot be read merely because their paths remain in summary.
    unlinkSync(refs[0].path);
    await first.send({ message: "Follow up after compaction" });
    assert.deepEqual(videoParts(first.requests.at(-1)).map(p => [p.role, p.mimeType]), [["user", "video/avi"]]);
    assert.deepEqual(Buffer.from(videoParts(first.requests.at(-1))[0].data, "base64"), avi);
    assert.equal(first.requests.at(-1).body.contents[videoParts(first.requests.at(-1))[0].index].parts[0].text, keptQuestion);
    const file = first.sm.getSessionFile();
    await first.wrapper.shutdown();
    const f = await fixture(t, { directory: first.dir, sessionFile: file, modelApi: "google-generative-ai", settings });
    assert.deepEqual(buildSessionContext(f.sm.getEntries(), f.sm.getLeafId()).messages.filter(m => m.piWebVideo).map(m => m.piWebVideoInContext), [false, true]);
    await f.send({ message: "Cold reopened follow-up" });
    assert.deepEqual(videoParts(f.requests.at(-1)).map(p => p.mimeType), ["video/avi"]);
    // A second real compaction cuts after both owners. A plain question remains
    // plain even though summary text still names both paths (one now missing).
    answerSent = false;
    f.respond(() => { const high = mode === "automatic" && !answerSent; answerSent = true; return summaryResponse(high); });
    await f.send({ message: `Text only ${"n".repeat(1600)}` });
    if (mode === "manual") await f.wrapper.send({ type: "compact" });
    assert.equal(f.sm.getEntries().filter(e => e.type === "compaction").length, 2);
    assert.equal(f.sm.buildSessionContext().messages.some(m => m.piWebVideo), false);
    await f.send({ message: `Only text: ${refs[0].path} and ${refs[1].path}` });
    assert.equal(videoParts(f.requests.at(-1)).length, 0, "no original video input is inferred from summary or question paths");
    assert.deepEqual(buildSessionContext(f.sm.getEntries(), f.sm.getLeafId()).messages.filter(m => m.piWebVideo).map(m => m.piWebVideoInContext), [false, false]);
    writeFileSync(refs[0].path, mp4);
    f.respond(() => response());
    const answer = await f.send({ message: "Reattached old clip", video: refs[0] });
    assert.equal(answer.stopReason, "stop", answer.errorMessage);
    const parts = videoParts(f.requests.at(-1));
    assert.equal(parts.length, 1);
    assert.equal(parts[0].mimeType, "video/mp4");
    assert.deepEqual(Buffer.from(parts[0].data, "base64"), mp4);
    assert.equal(f.requests.at(-1).body.contents[parts[0].index].parts[0].text, "Reattached old clip");
    const saved = f.sm.getEntries().filter(e => e.message?.piWebVideo);
    assert.equal(saved.length, 3);
    assert.notEqual(saved[0].message.piWebVideo.id, saved[2].message.piWebVideo.id);
    await f.wrapper.shutdown();
    const reopened = await fixture(t, { directory: first.dir, sessionFile: file, modelApi: "google-generative-ai", settings });
    assert.deepEqual(buildSessionContext(reopened.sm.getEntries(), reopened.sm.getLeafId()).messages.filter(m => m.piWebVideo).map(m => m.piWebVideoInContext), [false, false, true]);
    await reopened.send({ message: "Reopened after reattachment" });
    assert.deepEqual(videoParts(reopened.requests.at(-1)).map(p => p.mimeType), ["video/mp4"]);
    assert.deepEqual(Buffer.from(videoParts(reopened.requests.at(-1))[0].data, "base64"), mp4);
    assert.equal(readFileSync(file, "utf8").includes("piWebVideoInContext"), false);
  });
}

test("automatic between-tool compaction may exclude the submitting video owner without reactivating summary paths", { timeout: 15000 }, async t => {
  let executions = 0;
  const f = await fixture(t, { modelApi: "google-generative-ai",
    settings: { compaction: { enabled: true, reserveTokens: 10000, keepRecentTokens: 100 } },
    extensions: [pi => pi.registerTool({ name: "fixture_check", label: "Check", description: "Test-only", parameters: Type.Object({}), execute: async () => {
      executions++; return { content: [{ type: "text", text: "Tool evidence ".repeat(200) }] };
    } })], tools: ["fixture_check"],
  });
  const ref = f.video();
  f.respond(n => n === 1 ? new Response(`data: ${JSON.stringify({
    candidates: [{ content: { parts: [{ functionCall: { name: "fixture_check", args: {} } }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 995000, candidatesTokenCount: 2, totalTokenCount: 995002 },
  })}\n\n`, { headers: { "content-type": "text/event-stream" } }) : response([{ text: `Text description of ${ref.path}; /not-authorized/missing.avi is not media` }]));
  const answer = await f.send({ video: ref });
  assert.equal(answer.stopReason, "stop", answer.errorMessage);
  assert.equal(executions, 1);
  assert(f.events.some(e => e.type === "compaction_end" && e.reason === "threshold" && e.result && !e.aborted));
  assert.equal(videoParts(f.requests[0]).length, 1, "initial ordinary request carries the submitting owner");
  assert.equal(f.requests.length, 3, "initial media, actual SDK text summarization, then same-run continuation");
  assert.equal(videoParts(f.requests[1]).length, 0);
  assert.equal(videoParts(f.requests[2]).length, 0, "canonical compaction excluded the owner; no active-prompt false rejection or media resurrection");
  assert(f.requests[2].body.contents.some(c => c.parts.some(p => p.functionResponse)), "a real tool continuation, not another prompt");
  assert.equal(f.sm.buildSessionContext().messages.some(m => m.piWebVideo), false);
  assert.deepEqual(buildSessionContext(f.sm.getEntries(), f.sm.getLeafId()).messages.filter(m => m.piWebVideo).map(m => m.piWebVideoInContext), [false]);
});

// R1: compactedOut permits absence, not reuse of the submitting identity.
// Real default SDK tool scheduling/compaction must precede the context mutation.
for (const mutation of ["original tuple", "changed path", "duplicate owner"]) {
  test(`automatic between-tool compaction refuses context resurrection: ${mutation}`, { timeout: 15000 }, async t => {
    let capturedOwner, executions = 0, resurrectionChecks = 0;
    const f = await fixture(t, { modelApi: "google-generative-ai",
      settings: { compaction: { enabled: true, reserveTokens: 10000, keepRecentTokens: 100 } },
      extensions: [pi => {
        pi.registerTool({ name: "fixture_check", label: "Check", description: "Test-only", parameters: Type.Object({}), execute: async () => {
          executions++; return { content: [{ type: "text", text: "Tool evidence ".repeat(200) }] };
        } });
        pi.on("context", event => {
          const owner = event.messages.find(m => m.piWebVideo);
          if (!capturedOwner && owner) capturedOwner = structuredClone(owner);
          if (!f.events.some(e => e.type === "compaction_end" && e.reason === "threshold" && e.result && !e.aborted)) return;
          assert.equal(f.sm.buildSessionProjection().messages.some(m => m.piWebVideo), false, "canonical projection excluded the owner before the extension revives it");
          assert(capturedOwner, "capture the native submitting owner, never seed an invented UUID");
          resurrectionChecks++;
          const revived = structuredClone(capturedOwner);
          if (mutation === "changed path") revived.piWebVideo.path = other.path;
          return { messages: [...event.messages, revived, ...(mutation === "duplicate owner" ? [structuredClone(revived)] : [])] };
        });
      }], tools: ["fixture_check"],
    });
    const ref = f.video("chosen.mp4");
    const other = f.video("other.mp4", Buffer.concat([mp4, Buffer.from("not the user's chosen video")]));
    f.respond(n => n === 1 ? new Response(`data: ${JSON.stringify({
      candidates: [{ content: { parts: [{ functionCall: { name: "fixture_check", args: {} } }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 995000, candidatesTokenCount: 2, totalTokenCount: 995002 },
    })}\n\n`, { headers: { "content-type": "text/event-stream" } }) : response([{ text: `Text description of ${ref.path}` }]));
    const answer = await f.send({ video: ref });
    assert.equal(executions, 1);
    assert.equal(resurrectionChecks, 1, "the mutation ran after actual successful between-tool compaction");
    assert.equal(f.sm.getEntries().filter(e => e.type === "compaction").length, 1);
    assert.equal(f.sm.buildSessionProjection().messages.some(m => m.piWebVideo), false);
    assert.equal(f.requests.length, 2, `only initial media and SDK summary fetch; no media/text-only continuation: ${JSON.stringify(f.requests.map(r => videoParts(r).length))}`);
    assert.deepEqual(f.requests.map(r => videoParts(r).length), [1, 0]);
    assert.deepEqual(Buffer.from(videoParts(f.requests[0])[0].data, "base64"), mp4);
    assert.equal(answer.stopReason, "error", answer.errorMessage);
    assert.match(answer.errorMessage, /compacted video question.*reintroduced/i);
    assert.equal(f.sm.getEntries().find(e => e.message?.piWebVideo).message.piWebVideo.path, ref.path, "extension copies do not mutate native history");
    assert.deepEqual(buildSessionContext(f.sm.getEntries(), f.sm.getLeafId()).messages.filter(m => m.piWebVideo).map(m => m.piWebVideoInContext), [false]);
  });
}

for (const mode of ["manual", "automatic"]) {
  test(`${mode} failed compaction preserves effective video instead of clearing on compaction_start`, { timeout: 15000 }, async t => {
    const f = await fixture(t, { modelApi: "google-generative-ai", settings: { compaction: { enabled: mode === "automatic", reserveTokens: 10000, keepRecentTokens: 0 } } });
    let first = true;
    f.respond(() => {
      if (first) { first = false; return new Response(`data: ${JSON.stringify({
        candidates: [{ content: { parts: [{ text: "Before compaction" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: mode === "automatic" ? 995000 : 10, candidatesTokenCount: 2, totalTokenCount: mode === "automatic" ? 995002 : 12 },
      })}\n\n`, { headers: { "content-type": "text/event-stream" } }); }
      return new Response(JSON.stringify({ error: { message: "Synthetic summary unavailable", code: 400 } }), { status: 400, headers: { "content-type": "application/json" } });
    });
    await f.send({ video: f.video() });
    if (mode === "manual") await assert.rejects(f.wrapper.send({ type: "compact" }), /summarization failed/i);
    assert(f.events.some(e => e.type === "compaction_end" && e.errorMessage));
    assert.equal(f.sm.getEntries().some(e => e.type === "compaction"), false);
    assert.deepEqual(buildSessionContext(f.sm.getEntries(), f.sm.getLeafId()).messages.filter(m => m.piWebVideo).map(m => m.piWebVideoInContext), [true]);
    await f.wrapper.send({ type: "set_auto_compaction", enabled: false });
    f.respond(() => response());
    assert.equal((await f.send({ message: "Follow-up after failed compaction" })).stopReason, "stop");
    assert.equal(videoParts(f.requests.at(-1)).length, 1);
    assert.deepEqual(Buffer.from(videoParts(f.requests.at(-1))[0].data, "base64"), mp4);
  });
}

test("ordinary text paths/images still delegate to the original SDK stream without reading video", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  let originalCalls = 0;
  // Use a second wrapper around this isolated real session, to keep the original
  // provider seam observable without sending an Anthropic request.
  await f.wrapper.shutdown();
  const services = await createAgentSessionServices({ cwd: f.cwd, agentDir: join(f.dir, "plain-agent"), settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }), resourceLoaderOptions: { noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true } });
  const { getModel } = await import("@earendil-works/pi-ai/compat");
  const model = getModel("anthropic", "claude-sonnet-4-5");
  await services.modelRuntime.setRuntimeApiKey(model.provider, "test-only");
  const { session } = await createAgentSessionFromServices({ services, model, tools: [], sessionManager: SessionManager.inMemory(f.cwd) });
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9xkAAAAASUVORK5CYII=";
  session.agent.streamFunction = (_model, context) => {
    originalCalls++;
    assert(!context.messages.some(m => m.piWebVideo));
    assert(context.messages.some(m => Array.isArray(m.content) && m.content.some(c => c.type === "image")));
    const stream = createAssistantMessageEventStream();
    const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [{ type: "text", text: "Plain" }], usage: zeroUsage, stopReason: "stop", timestamp: Date.now() };
    queueMicrotask(() => { stream.push({ type: "done", reason: "stop", message }); stream.end(message); });
    return stream;
  };
  const wrapper = new AgentSessionWrapper(session, { headless: true });
  t.after(() => wrapper.shutdown());
  wrapper.start();
  wrapper.beginExtensionBinding();
  const done = Promise.withResolvers();
  wrapper.onEvent(e => { if (e.type === "prompt_done") done.resolve(); });
  await wrapper.send({ type: "prompt", message: "Read /not-allowed/missing.mp4 as ordinary text", images: [{ type: "image", data: png, mimeType: "image/png" }] });
  await done.promise;
  assert.equal(originalCalls, 1);
  assert.equal(f.requests.length, 0);
});

test("tool continuation retains video on its original user",  { timeout: 15000 }, async t => {
  const f = await fixture(t, { extensions: [(pi) => pi.registerTool({ name: "fixture_check", label: "Check", description: "Test-only", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "checked" }] }) })], tools: ["fixture_check"] });
  const ref = f.video();
  f.respond(n => n === 1 ? response([{ functionCall: { name: "fixture_check", args: {} } }]) : response());
  const answer = await f.send({ video: ref });
  assert.equal(answer.stopReason, "stop", answer.errorMessage);
  assert.equal(f.requests.length, 2);
  for (const request of f.requests) {
    assert.equal(videoParts(request).length, 1);
    assert.equal(videoParts(request)[0].index, 0);
    assert.deepEqual(Buffer.from(videoParts(request)[0].data, "base64"), mp4);
  }
  assert(f.requests[1].body.contents.some(c => c.parts.some(p => p.functionResponse)));
});

for (const kind of ["missing", "outside", "symlink", "parent traversal", "directory", "unreadable", "bad bytes", "bad MIME", "oversized", "unsupported model"]) {
  test(`new video rejects ${kind} before acceptance with zero provider requests`, { timeout: 15000, skip: kind === "unreadable" && (process.platform === "win32" || process.getuid?.() === 0) }, async t => {
    const f = await fixture(t);
    let ref = f.video();
    let command = { type: "prompt", message: "Question", video: ref };
    if (kind === "missing") unlinkSync(ref.path);
    if (kind === "outside") { ref.path = join(f.dir, "outside.mp4"); writeFileSync(ref.path, mp4); }
    if (kind === "symlink") { const external = join(f.dir, "outside.mp4"); writeFileSync(external, mp4); unlinkSync(ref.path); symlinkSync(external, ref.path); }
    if (kind === "parent traversal") ref.path = join(f.cwd, "link") + "/../clip.mp4";
    if (kind === "directory") { unlinkSync(ref.path); mkdirSync(ref.path); }
    if (kind === "unreadable") chmodSync(ref.path, 0);
    if (kind === "bad bytes") writeFileSync(ref.path, "not a video");
    if (kind === "bad MIME") ref.mimeType = "video/avi";
    if (kind === "oversized") truncateSync(ref.path, MAX_VIDEO_FILE_BYTES + 1);
    if (kind === "unsupported model") f.session.modelRuntime.getModel = () => ({ ...f.session.model, provider: "other" });
    await assert.rejects(f.wrapper.send(command));
    assert.equal(f.requests.length, 0);
    assert(!f.sm.getEntries().some(e => e.message?.piWebVideo));
  });
}

for (const kind of ["deleted after preflight", "auth failure", "auth unresolved", "payload strips video then throws", "payload replacement", "payload redirect", "payload oversized", "payload duplicates owner", "converter removes owner", "context drops new question", "model changed by preflight"]) {
  test(`accepted video fails closed at actual Google boundary: ${kind}`, { timeout: 15000 }, async t => {
    let ref;
    const extensions = [(pi) => {
      if (kind === "deleted after preflight") pi.on("before_agent_start", () => unlinkSync(ref.path));
      if (kind === "payload strips video then throws") pi.on("before_provider_request", e => { e.payload.contents[0].parts = [{ text: "Question only" }]; throw new Error("SDK swallows this hook error"); });
      if (kind === "payload replacement") pi.on("before_provider_request", e => ({ ...e.payload, contents: [{ role: "user", parts: [{ text: "Question only" }] }] }));
      if (kind === "payload redirect") pi.on("before_provider_request", e => { e.payload.config.httpOptions = { baseUrl: "https://invalid.example" }; });
      if (kind === "payload oversized") pi.on("before_provider_request", e => { e.payload.config.systemInstruction = "x".repeat(MAX_VIDEO_REQUEST_BYTES); });
      if (kind === "payload duplicates owner") pi.on("before_provider_request", e => { e.payload.contents.push(structuredClone(e.payload.contents[0])); });
      if (kind === "context drops new question") pi.on("context", e => ({ messages: e.messages.filter(m => m.role !== "user") }));
      if (kind === "model changed by preflight") pi.on("before_agent_start", () => { f.session.agent.state.model.provider = "other"; });
    }];
    const f = await fixture(t, { extensions });
    ref = f.video();
    if (kind === "auth failure") f.session.modelRuntime.getAuth = async () => { throw new Error("isolated auth failure"); };
    if (kind === "auth unresolved") f.session.modelRuntime.getAuth = async () => undefined;
    if (kind === "converter removes owner") {
      const conversion = f.session.agent.convertToLlm;
      f.session.agent.convertToLlm = async messages => (await conversion(messages)).map(m => { if (m.role !== "user") return m; const rest = { ...m }; delete rest.piWebVideo; return rest; });
    }
    const answer = await f.send({ video: ref });
    assert.equal(answer.stopReason, "error", answer.errorMessage);
    const expectedErrors = {
      "deleted after preflight": /missing or outside/,
      "auth failure": /isolated auth failure/,
      "auth unresolved": /did not resolve an API key/,
      "payload redirect": /payload hook changed/,
      "payload strips video then throws": /payload hook changed/,
      "payload replacement": /payload hook changed/,
      "payload oversized": /32 MiB/,
      "payload duplicates owner": /payload hook changed/,
      "converter removes owner": /missing from the provider input/,
      "context drops new question": /missing from the provider input/,
      "model changed by preflight": /Video requires/,
    };
    assert.match(answer.errorMessage, expectedErrors[kind]);
    assert.equal(f.requests.length, 0, "must never issue a question-only request");
    assert(f.sm.getEntries().some(e => e.message?.piWebVideo), "accepted failure still persists native user reference");
  });
}

for (const kind of ["context changes path with same UUID", "converter changes path in place", "converter deletes old metadata in place"]) {
  test(`reference tuple remains intact: ${kind}`, { timeout: 15000 }, async t => {
    let otherPath, mutate = kind !== "converter deletes old metadata in place", delegates = 0;
    const change = messages => {
      if (!mutate) return messages;
      const owner = messages.find(m => m.piWebVideo);
      if (owner) {
        if (kind === "converter deletes old metadata in place") delete owner.piWebVideo;
        else owner.piWebVideo.path = otherPath;
      }
      return messages;
    };
    const f = await fixture(t, {
      extensions: kind.startsWith("context") ? [pi => pi.on("context", e => ({ messages: change(e.messages) }))] : [],
      convert: kind.startsWith("converter") ? change : undefined,
      delegate: () => { delegates++; throw new Error("Unexpected text-only delegate"); },
    });
    const ref = f.video();
    otherPath = f.video("other.mp4", Buffer.concat([mp4, Buffer.from("different bytes")])).path;
    if (!mutate) {
      assert.equal((await f.send({ video: ref })).stopReason, "stop");
      mutate = true;
    }
    const before = f.requests.length;
    const answer = await f.send(before ? { message: "Follow up" } : { video: ref });
    assert.equal(answer.stopReason, "error", answer.errorMessage);
    assert.equal(f.requests.length, before, "no final Google fetch after reference mutation");
    assert.equal(delegates, 0, "no fallback to the original SDK stream");
    assert.equal(f.sm.getEntries().find(e => e.message?.piWebVideo).message.piWebVideo.path, ref.path);
  });
}

test("two explicit owners may legitimately reference the same file", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const ref = f.video();
  await f.send({ video: ref });
  const answer = await f.send({ message: "Compare this attached video", video: ref });
  assert.equal(answer.stopReason, "stop", answer.errorMessage);
  assert.equal(f.requests.length, 2);
  const parts = videoParts(f.requests[1]);
  assert.equal(parts.length, 2);
  assert.notEqual(parts[0].index, parts[1].index);
  for (const part of parts) assert.deepEqual(Buffer.from(part.data, "base64"), mp4);
});

test("cumulative Base64 + text/images request limit rejects all, not only the newest video", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const ref = f.video();
  const large = Buffer.alloc(13 * 1024 * 1024);
  mp4.copy(large);
  writeFileSync(ref.path, large);
  await f.send({ video: ref });
  assert.equal(f.requests.length, 1);
  const other = f.video("other.mp4", large);
  const answer = await f.send({ video: other });
  assert.equal(answer.stopReason, "error");
  assert.match(answer.errorMessage, /32 MiB/);
  assert.equal(f.requests.length, 1, "failed cumulative request makes no additional outbound request");
});

test("request limit includes non-video text and preserves reserved wire envelope", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const ref = f.video();
  const answer = await f.send({ video: ref, message: "x".repeat(MAX_VIDEO_REQUEST_BYTES - VIDEO_REQUEST_ENVELOPE_BYTES) });
  assert.equal(answer.stopReason, "error");
  assert.match(answer.errorMessage, /32 MiB/);
  assert.equal(f.requests.length, 0);
});

test("Chat-only exact system policy and an already-Google source model use the same guarded video transport", { timeout: 15000 }, async t => {
  const f = await fixture(t, { chatOnly: true, modelApi: "google-generative-ai" });
  const answer = await f.send({ video: f.video("clip.avi", avi) });
  assert.equal(answer.stopReason, "stop", answer.errorMessage);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].body.systemInstruction.parts[0].text, "Exact test chat prompt");
  assert.equal(videoParts(f.requests[0])[0].mimeType, "video/avi");
  assert.equal(f.session.getActiveToolNames().length, 0);
});

test("an admitted busy video run rejects a second attachment and Stop aborts the native Google stream", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const started = Promise.withResolvers();
  f.respond((_n, req) => new Promise((_resolve, reject) => {
    started.resolve();
    req.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  }));
  const first = f.send({ video: f.video() });
  await started.promise;
  await assert.rejects(f.wrapper.send({ type: "prompt", message: "Second", video: f.video("other.avi", avi) }), /idle session/);
  assert.equal(f.requests.length, 1);
  await f.wrapper.send({ type: "abort" });
  const answer = await first;
  assert.equal(answer.stopReason, "aborted");
  assert.equal(f.wrapper.isRunning(), false);
  assert.equal(f.requests.length, 1);
});

test("a near-limit accepted request stays below the actual serialized Google wire cap", { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const answer = await f.send({ video: f.video(), message: "文".repeat(Math.floor((MAX_VIDEO_REQUEST_BYTES - VIDEO_REQUEST_ENVELOPE_BYTES - 16384) / 3)) });
  assert.equal(answer.stopReason, "stop", answer.errorMessage);
  assert.equal(f.requests.length, 1);
  assert(f.requests[0].bytes < MAX_VIDEO_REQUEST_BYTES);
  assert(f.requests[0].bytes > MAX_VIDEO_REQUEST_BYTES - 128 * 1024);
});

test("HTTP unsupported entrances reject video before session startup or set_tools fast paths", { timeout: 15000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), "pi-video-route-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stub = join(dir, "rpc-stub.ts");
  writeFileSync(stub, `const unexpected = () => { throw new Error('Unexpected session startup/mutation'); }; export const startRpcSession = unexpected; export const getRpcSession = unexpected; export const setRpcSessionTools = unexpected;`);
  const loader = createJiti(import.meta.url, { moduleCache: false, alias: { "@/lib/rpc-manager": stub, "@": process.cwd() } });
  const newRoute = await loader.import("../app/api/agent/new/route.ts");
  const existingRoute = await loader.import("../app/api/agent/[id]/route.ts");
  const ref = { version: 1, path: join(dir, "clip.mp4"), mimeType: "video/mp4" };
  for (const type of ["ensure_session", "set_tools", "bash", "compact", "fork", "navigate_tree"]) {
    for (const route of [newRoute, existingRoute]) {
      const result = await route.POST(new Request("http://localhost/api/agent/test", { method: "POST", body: JSON.stringify({ type, cwd: dir, message: "Question", video: ref }) }), { params: Promise.resolve({ id: "test" }) });
      assert.equal(result.status, 500);
      assert.match((await result.json()).error, /only on an ordinary/);
    }
  }
  for (const type of ["steer", "follow_up"]) {
    const result = await newRoute.POST(new Request("http://localhost/api/agent/new", { method: "POST", body: JSON.stringify({ type, cwd: dir, message: "Question", video: ref }) }));
    assert.equal(result.status, 500);
    assert.match((await result.json()).error, /not a standalone queue command/);
  }
});
