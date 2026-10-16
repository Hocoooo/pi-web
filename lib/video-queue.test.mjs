// Actual SDK queues + native Google final fetch; no paid network or global settings.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { createJiti } from "jiti";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
const jiti = createJiti(import.meta.url);
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { VIDEO_MODEL_ID, VIDEO_GOOGLE_BASE_URL, MAX_VIDEO_FILE_BYTES } = await jiti.import("./video-attachments.ts");
const mp4 = readFileSync(new URL("./fixtures/video-attachments/red.mp4", import.meta.url));
const avi = readFileSync(new URL("./fixtures/video-attachments/blue.avi", import.meta.url));
const png = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9xkAAAAASUVORK5CYII=" };
const frame = (text, finish = false) => `data: ${JSON.stringify({ candidates: [{ content: { parts: Array.isArray(text) ? text : [{ text }] }, ...(finish ? { finishReason: "STOP" } : {}) }], ...(finish ? { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 } } : {}) })}\n\n`;
const videoParts = req => req.body.contents.flatMap((c, index) => c.parts.filter(p => p.inlineData?.mimeType.startsWith("video/")).map(p => ({ index, text: c.parts.find(p => p.text)?.text, ...p.inlineData })));
async function fixture(t, extensions = [], tools = []) {
  const dir = mkdtempSync(join(tmpdir(), "pi-video-queue-")), cwd = join(dir, "workspace"); mkdirSync(cwd);
  const roots = globalThis.__piAllowedRootsCache, fetch = globalThis.fetch;
  globalThis.__piAllowedRootsCache = { roots: new Set([cwd]), expiresAt: Infinity };
  const services = await createAgentSessionServices({ cwd, agentDir: join(dir, "agent"),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, providerRetry: { maxRetries: 0 }, cacheWarming: "off" }),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, extensionFactories: extensions } });
  services.modelRuntime.registerProvider("tapsvc", { api: "google-generative-ai", baseUrl: VIDEO_GOOGLE_BASE_URL, apiKey: "isolated-queued-video-key", models: [{ id: VIDEO_MODEL_ID, name: "Gemini", reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 1024 }] });
  const sm = SessionManager.create(cwd, join(dir, "sessions"));
  const { session } = await createAgentSessionFromServices({ services, model: services.modelRuntime.getModel("tapsvc", VIDEO_MODEL_ID), tools, sessionManager: sm });
  const wrapper = new AgentSessionWrapper(session, { headless: true }); wrapper.start(); wrapper.beginExtensionBinding();
  const requests = [], events = [], started = Promise.withResolvers(), encoder = new TextEncoder(); let finish;
  wrapper.onEvent(e => events.push(e));
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(request.url, `${VIDEO_GOOGLE_BASE_URL}/models/${VIDEO_MODEL_ID}:streamGenerateContent?alt=sse`, "no unexpected network");
    requests.push({ body: JSON.parse(await request.text()), headers: request.headers });
    if (requests.length > 1) return new Response(frame("Final queued answer", true), { headers: { "content-type": "text/event-stream" } });
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode(frame("Working on the previous question")));
      request.signal.addEventListener("abort", () => controller.error(new DOMException("Stopped", "AbortError")), { once: true });
      finish = (parts = "Done") => { controller.enqueue(encoder.encode(frame(parts, true))); controller.close(); };
      started.resolve();
    } }), { headers: { "content-type": "text/event-stream" } });
  };
  t.after(async () => { await wrapper.shutdown(); globalThis.fetch = fetch; globalThis.__piAllowedRootsCache = roots; rmSync(dir, { recursive: true, force: true }); });
  const video = (name = "queued.avi", bytes = avi) => { const path = join(cwd, name); writeFileSync(path, bytes); return { version: 1, path, mimeType: name.endsWith(".avi") ? "video/avi" : "video/mp4" }; };
  const idle = () => session.waitForIdle();
  async function start() { await wrapper.send({ type: "prompt", message: "Previous question", video: video("previous.mp4", mp4) }); await started.promise; }
  return { session, sm, wrapper, requests, events, video, idle, start, started: started.promise, finish: parts => finish(parts), owners: () => sm.getEntries().filter(e => e.message?.piWebVideo) };
}

for (const mode of ["steer", "followUp"]) {
  for (const direct of [false, true]) test(`${mode}/${direct ? "direct" : "prompt"}: queued video stays with its native user, never the streaming question`, { timeout: 15000 }, async t => {
    const f = await fixture(t); await f.start();
    const video = f.video(), message = "Same question";
    await f.wrapper.send({ type: direct ? mode === "steer" ? "steer" : "follow_up" : "prompt", ...(direct ? {} : { streamingBehavior: mode }), message, images: [png], video });
    const state = await f.wrapper.send({ type: "get_state" }), kind = mode === "steer" ? "steering" : "followUp";
    assert.equal(state.queuedMessages.inputs[kind].length, 1);
    assert.deepEqual(state.queuedMessages.inputs[kind][0], { text: message, images: [png], video: { ...video, id: state.queuedMessages.inputs[kind][0].video.id } });
    assert.equal(f.session.pendingMessageCount, 1); assert.equal(f.owners().length, 1);
    assert.equal(f.requests.length, 1); assert.equal(videoParts(f.requests[0]).length, 1);
    f.finish(); await f.idle();
    assert.equal(f.requests.length, 2); assert.equal(f.owners().length, 2);
    assert.notEqual(f.owners()[0].message.piWebVideo.id, f.owners()[1].message.piWebVideo.id);
    const parts = videoParts(f.requests[1]); assert.deepEqual(parts.map(p => [p.text, p.mimeType]), [["Previous question", "video/mp4"], [message, "video/avi"]]);
    assert.deepEqual(Buffer.from(parts[1].data, "base64"), avi);
    const owner = f.requests[1].body.contents[parts[1].index]; assert(owner.parts.some(p => p.inlineData?.data === png.data));
    assert.equal((await f.wrapper.send({ type: "get_state" })).queuedMessages.inputs[kind].length, 0);
    assert.deepEqual(SessionManager.open(f.sm.getSessionFile()).getEntries().filter(e => e.message?.piWebVideo), f.owners());
  });

  test(`${mode}: Stop retains unconsumed SDK input without sending; explicit next question consumes it once`, { timeout: 15000 }, async t => {
    const f = await fixture(t); await f.start(); const video = f.video();
    await f.wrapper.send({ type: "prompt", message: "Retained video question", streamingBehavior: mode, video });
    await f.wrapper.send({ type: "abort" }); await f.idle();
    assert.equal(f.requests.length, 1); assert.equal(f.owners().length, 1); assert.equal(f.session.pendingMessageCount, 1);
    await new Promise(r => setTimeout(r, 20)); assert.equal(f.requests.length, 1, "Stop never implicitly resends");
    await f.wrapper.send({ type: "prompt", message: "Explicitly continue" }); await f.idle();
    assert.equal(f.owners().length, 2); assert.equal(f.session.pendingMessageCount, 0);
    assert.equal(f.owners()[1].message.content[0].text, "Retained video question");
    assert(videoParts(f.requests.at(-1)).some(p => p.text === "Retained video question" && p.mimeType === "video/avi"));
    assert(!videoParts(f.requests.at(-1)).some(p => p.text === "Explicitly continue" && p.mimeType === "video/avi"));
  });

  for (const failure of ["missing", "model", "single-file size", "cumulative media", "full request", "context drops owner"]) test(`${mode}: consumption revalidates ${failure}; zero reduced-media/text fallback and explicit repair works`, { timeout: 20000 }, async t => {
    let drop = false;
    const f = await fixture(t, failure === "context drops owner" ? [pi => pi.on("context", e => drop ? { messages: e.messages.filter(m => !m.piWebVideo || m.piWebVideo.mimeType !== "video/avi") } : undefined)] : []);
    await f.start(); const video = f.video();
    await f.wrapper.send({ type: "prompt", message: failure === "full request" ? "文".repeat(1024 * 1024) : "Check queued video", streamingBehavior: mode, video });
    const previous = f.owners()[0].message.piWebVideo;
    if (failure === "missing") unlinkSync(video.path);
    if (failure === "model") f.session.agent.state.model.provider = "other";
    if (failure === "single-file size") { const bytes = Buffer.alloc(MAX_VIDEO_FILE_BYTES + 1); avi.copy(bytes); writeFileSync(video.path, bytes); }
    if (failure === "cumulative media" || failure === "full request") {
      const size = failure === "cumulative media" ? 13 : 11;
      for (const [ref, header] of [[previous, mp4], [video, avi]]) { const bytes = Buffer.alloc(size * 1024 * 1024); header.copy(bytes); writeFileSync(ref.path, bytes); }
    }
    if (failure === "context drops owner") drop = true;
    f.finish(); await f.idle();
    assert.equal(f.requests.length, 1, "only the previous complete request left the process");
    assert.equal(f.session.messages.findLast(m => m.role === "assistant").stopReason, "error");
    assert.equal(f.owners().length, 2, "accepted input retains the owning native reference on failure");
    assert.equal(f.session.pendingMessageCount, 0);
    writeFileSync(video.path, avi); writeFileSync(previous.path, mp4); f.session.agent.state.model.provider = "tapsvc"; drop = false;
    await f.wrapper.send({ type: "prompt", message: "Explicit repair retry" }); await f.idle();
    assert.equal(f.requests.length, 2); assert.equal(f.owners().length, 2, "retry never appends a second copy of the accepted video");
    assert.deepEqual(videoParts(f.requests.at(-1)).map(p => p.mimeType), ["video/mp4", "video/avi"]);
  });
}

for (const mode of ["steer", "followUp"]) {
  test(`${mode}: video Recall refuses while busy, including the SDK-dequeued extension-await window`, { timeout: 15000 }, async t => {
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    const f = await fixture(t, [pi => pi.on("message_start", async e => {
      if (e.message.role === "user" && e.message.content[0]?.text === "Recall race") { entered.resolve(); await release.promise; }
    })]);
    await f.start();
    await f.wrapper.send({ type: "prompt", message: "Recall race", streamingBehavior: mode, video: f.video(), images: [png] });
    try {
      f.finish(); await entered.promise;
      assert.equal(f.session.pendingMessageCount, 0, "the real SDK has already drained this user");
      assert.equal(f.requests.length, 1, "extension is holding consumption before the next fetch");
      await assert.rejects(f.wrapper.send({ type: "clear_queue", recall: true }), /Stop.*wait|idle/i);
    } finally { release.resolve(); }
    await f.idle();
    assert.equal(f.owners().length, 2); assert.equal(f.requests.length, 2);
    assert.deepEqual((await f.wrapper.send({ type: "clear_queue", recall: true })).inputs, { steering: [], followUp: [] });
    assert.deepEqual(Buffer.from(videoParts(f.requests[1])[1].data, "base64"), avi);
  });

  test(`${mode}: busy text/image-only Recall retains the existing full-clear semantics`, { timeout: 15000 }, async t => {
    const f = await fixture(t); await f.start();
    await f.wrapper.send({ type: "prompt", message: "Plain queued question", streamingBehavior: mode, images: [png] });
    const recalled = await f.wrapper.send({ type: "clear_queue", recall: true });
    const kind = mode === "steer" ? "steering" : "followUp";
    assert.deepEqual(recalled[kind], ["Plain queued question"]);
    assert.deepEqual(recalled.inputs[kind], [{ text: "Plain queued question", images: [png] }]);
    assert.equal(f.session.pendingMessageCount, 0);
    f.finish(); await f.idle(); assert.equal(f.requests.length, 1); assert.equal(f.owners().length, 1);
  });
}

for (const mode of ["steer", "followUp"]) test(`${mode}: a plain Recall precondition protects a later unseen SDK video/PNG`, { timeout: 15000 }, async t => {
  const f = await fixture(t); await f.start();
  await f.wrapper.send({ type: "prompt", message: "Plain queued question", streamingBehavior: mode });
  await f.wrapper.send({ type: "abort" }); await f.idle();
  const recallInputs = (await f.wrapper.send({ type: "get_state" })).queuedMessages.inputs;
  const video = f.video("later.avi");
  await f.wrapper.send({ type: "steer", message: "Later video question", video, images: [png] });
  await assert.rejects(f.wrapper.send({ type: "clear_queue", recall: true, recallInputs }), /queue.*changed/i);
  assert.equal(f.session.pendingMessageCount, 2); assert.equal(f.owners().length, 1); assert.equal(f.requests.length, 1);
  const current = (await f.wrapper.send({ type: "get_state" })).queuedMessages.inputs;
  const queuedVideo = [...current.steering, ...current.followUp].find(input => input.video);
  assert.equal(queuedVideo.video.path, video.path); assert.deepEqual(queuedVideo.images, [png]);
  const recalled = await f.wrapper.send({ type: "clear_queue", recall: true, recallInputs: current });
  assert.deepEqual(recalled.inputs, current); assert.equal(f.session.pendingMessageCount, 0);
});

test("Recall cannot clear a changed queue using a stale saved input snapshot", { timeout: 15000 }, async t => {
  const f = await fixture(t); await f.start();
  await f.wrapper.send({ type: "prompt", message: "Saved video question", streamingBehavior: "followUp", video: f.video(), images: [png] });
  await f.wrapper.send({ type: "abort" }); await f.idle();
  const recallInputs = (await f.wrapper.send({ type: "get_state" })).queuedMessages.inputs;
  await f.wrapper.send({ type: "steer", message: "Later queued question", images: [png] });
  await assert.rejects(f.wrapper.send({ type: "clear_queue", recall: true, recallInputs }), /queue.*changed/i);
  assert.equal(f.session.pendingMessageCount, 2);
  const current = (await f.wrapper.send({ type: "get_state" })).queuedMessages.inputs;
  assert.deepEqual(current.followUp, recallInputs.followUp); assert.equal(current.steering[0].text, "Later queued question");
  assert.deepEqual((await f.wrapper.send({ type: "clear_queue", recall: true, recallInputs: current })).inputs, current);
  assert.equal(f.session.pendingMessageCount, 0); assert.equal(f.requests.length, 1);
});

test("same-text steer/follow-up and plain inputs use actual SDK message identity; recalled bytes/reference remain together", { timeout: 15000 }, async t => {
  const f = await fixture(t); await f.start(); const video = f.video();
  await f.wrapper.send({ type: "prompt", message: "Same question", streamingBehavior: "followUp", video, images: [png] });
  await f.wrapper.send({ type: "prompt", message: "Same question", streamingBehavior: "steer" });
  let state = await f.wrapper.send({ type: "get_state" });
  assert.equal(state.queuedMessages.inputs.steering[0].video, undefined); assert.equal(state.queuedMessages.inputs.followUp[0].video.path, video.path);
  await f.wrapper.send({ type: "abort" }); await f.idle();
  const recalled = await f.wrapper.send({ type: "clear_queue", recall: true });
  assert.equal(recalled.inputs.followUp[0].video.path, video.path); assert.deepEqual(recalled.inputs.followUp[0].images, [png]);
  assert.equal(f.session.pendingMessageCount, 0); assert.equal(f.requests.length, 1);
  assert.deepEqual((await f.wrapper.send({ type: "clear_queue", recall: true })).inputs, { steering: [], followUp: [] });
  await f.wrapper.send({ type: "prompt", message: recalled.inputs.followUp[0].text, video, images: recalled.inputs.followUp[0].images }); await f.idle();
  assert.equal(f.owners().length, 2); assert.equal(f.requests.length, 2); assert.equal(videoParts(f.requests[1]).length, 2);
});

test("multiple queued video recall refuses before clearing instead of silently merging/losing an attachment", { timeout: 15000 }, async t => {
  const f = await fixture(t); await f.start();
  for (const [streamingBehavior, name] of [["steer", "one.avi"], ["followUp", "two.avi"]]) await f.wrapper.send({ type: "prompt", message: "Video question", streamingBehavior, video: f.video(name) });
  await f.wrapper.send({ type: "abort" }); await f.idle();
  await assert.rejects(f.wrapper.send({ type: "clear_queue", recall: true }), /multiple video/);
  assert.equal(f.session.pendingMessageCount, 2); assert.equal(f.requests.length, 1);
  const cleared = await f.wrapper.send({ type: "clear_queue" }); assert.equal(cleared.inputs.steering.length + cleared.inputs.followUp.length, 2);
  assert.equal(f.session.pendingMessageCount, 0);
});

for (const streamingBehavior of ["steer", "followUp"]) test(`${streamingBehavior}: idle race starts an ordinary native owner rather than stranding the video`, { timeout: 15000 }, async t => {
  const f = await fixture(t); const video = f.video();
  await f.wrapper.send({ type: "prompt", message: "Start after the run ended", streamingBehavior, video });
  await f.started; f.finish(); await f.idle(); assert.equal(f.requests.length, 1); assert.equal(f.owners().length, 1);
  assert.equal(videoParts(f.requests[0])[0].text, "Start after the run ended"); assert.equal(f.session.pendingMessageCount, 0);
});


for (const mode of ["steer", "followUp"]) test(`${mode}: actual SDK tool boundary preserves its distinct queue timing and media owners`, { timeout: 15000 }, async t => {
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  const f = await fixture(t, [pi => pi.registerTool({ name: "queue_gate", label: "Gate", description: "Isolated queue test", parameters: Type.Object({}), execute: async () => { started.resolve(); await release.promise; return { content: [{ type: "text", text: "Tool completed" }] }; } })], ["queue_gate"]);
  await f.start(); f.finish([{ functionCall: { name: "queue_gate", args: {} } }]); await started.promise;
  await f.wrapper.send({ type: "prompt", message: "Video after the tool", streamingBehavior: mode, video: f.video() });
  assert.equal(f.requests.length, 1, "a tool in progress does not receive queued media");
  release.resolve(); await f.idle();
  assert.deepEqual(f.requests.map(r => videoParts(r).length), mode === "steer" ? [1, 2] : [1, 1, 2]);
  assert.equal(videoParts(f.requests.at(-1)).at(-1).text, "Video after the tool");
});

test("nested extension input with identical text cannot steal the host video's async binding", { timeout: 15000 }, async t => {
  let injected = false;
  const f = await fixture(t, [pi => pi.on("input", e => {
    if (e.source === "rpc" && e.text === "Identical input" && !injected) { injected = true; pi.sendUserMessage("Identical input", { deliverAs: "followUp" }); }
  })]);
  await f.start(); await f.wrapper.send({ type: "prompt", message: "Identical input", streamingBehavior: "steer", video: f.video() });
  const state = await f.wrapper.send({ type: "get_state" });
  assert.equal(state.queuedMessages.inputs.steering[0].video.mimeType, "video/avi");
  assert.equal(state.queuedMessages.inputs.followUp[0].text, "Identical input"); assert.equal(state.queuedMessages.inputs.followUp[0].video, undefined);
  f.finish(); await f.idle();
  const users = f.sm.getEntries().filter(e => e.message?.role === "user" && e.message.content[0]?.text === "Identical input");
  assert.equal(users.length, 2); assert.equal(users[0].message.piWebVideo.mimeType, "video/avi"); assert.equal(users[1].message.piWebVideo, undefined);
  assert.deepEqual(f.requests.map(r => videoParts(r).length), [1, 2, 2]);
});

test("clearing an unconsumed video removes its SDK input without binding a later same-text question", { timeout: 15000 }, async t => {
  const f = await fixture(t); await f.start();
  await f.wrapper.send({ type: "prompt", message: "Same question", streamingBehavior: "steer", video: f.video() });
  await f.wrapper.send({ type: "clear_queue" });
  await f.wrapper.send({ type: "prompt", message: "Same question", streamingBehavior: "steer" });
  f.finish(); await f.idle(); assert.equal(f.owners().length, 1);
  assert.deepEqual(f.requests.map(r => videoParts(r).length), [1, 1]);
  assert.equal(f.sm.getEntries().filter(e => e.message?.role === "user").at(-1).message.piWebVideo, undefined);
});
