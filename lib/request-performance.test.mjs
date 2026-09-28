import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { SessionManager, SettingsManager, createAgentSessionServices, createAgentSessionFromServices } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createRequestPerformanceTracker } = await jiti.import("./request-performance.ts");
const { buildSessionContext } = await jiti.import("./session-reader.ts");
const { toClientAgentEvent } = await jiti.import("./agent-event-wire.ts");
const { streamReducer, INITIAL_STREAMING_STATE } = await jiti.import("./streaming-message.ts");
const model = { api: "test", provider: "test", id: "test" };
function assistant(stopReason = "stop") {
  return {
    role: "assistant", api: "test", provider: "test", model: "test", timestamp: 1,
    content: [{ type: "text", text: "hello" }], stopReason,
    usage: { input: 10, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 60,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}
function fixture() {
  let clock = 1000;
  const tracker = createRequestPerformanceTracker(() => clock);
  const upstream = createAssistantMessageEventStream();
  const partial = assistant("pending");
  const context = { messages: [] };
  const controller = new AbortController();
  const options = { signal: controller.signal, temperature: 0.3 };
  const stream = tracker.wrap((receivedModel, receivedContext, receivedOptions) => {
    assert.equal(receivedModel, model);
    assert.equal(receivedContext, context);
    assert.equal(receivedOptions, options);
    return upstream;
  })(model, context, options);
  return {
    tracker, stream, partial, upstream, controller,
    async emit(at, event) { clock = at; upstream.push(event); await tick(); },
    setClock(at) { clock = at; },
  };
}

for (const type of ["text_delta", "thinking_delta", "toolcall_delta"]) {
  test(`counts first nonempty ${type}, ignoring start and empty chunks`, async () => {
    const f = fixture();
    await f.emit(1100, { type: "start", partial: f.partial });
    await f.emit(1150, { type, delta: "", contentIndex: 0, partial: f.partial });
    assert.equal(f.partial.piWebPerformance.ttftMs, null);
    await f.emit(1250, { type, delta: " ", contentIndex: 0, partial: f.partial });
    assert.equal(f.partial.piWebPerformance.ttftMs, 250, "whitespace is still output");
    await f.emit(1500, { type, delta: "more", contentIndex: 0, partial: f.partial });
    await f.emit(2250, { type: "done", reason: "stop", message: assistant() });
    const result = await f.stream.result();
    assert.deepEqual(result.piWebPerformance, { version: 1, ttftMs: 250, generationMs: 1000, totalMs: 1250 });
    const events = [];
    for await (const event of f.stream) events.push(event);
    assert.equal(events.at(-1).message, result);
    assert.equal(events.length, 5, "relay retains all events without consuming the UI's copy");
  });
}

test("an async provider factory's wait is included, while downstream consumption is not", async () => {
  let clock = 0;
  const tracker = createRequestPerformanceTracker(() => clock);
  const upstream = createAssistantMessageEventStream();
  let release;
  const stream = tracker.wrap(() => new Promise((resolve) => { release = resolve; }))(model, { messages: [] });
  clock = 100;
  release(upstream);
  await tick();
  clock = 200;
  upstream.push({ type: "text_delta", contentIndex: 0, delta: "hi", partial: assistant("pending") });
  await tick();
  clock = 500;
  upstream.push({ type: "done", reason: "stop", message: assistant() });
  await tick();
  clock = 9000;
  assert.deepEqual((await stream.result()).piWebPerformance, { version: 1, ttftMs: 200, generationMs: 300, totalMs: 500 });
});

test("no delta means missing TTFT, never inferred from final content", async () => {
  const f = fixture();
  await f.emit(2000, { type: "done", reason: "stop", message: assistant() });
  assert.deepEqual((await f.stream.result()).piWebPerformance,
    { version: 1, ttftMs: null, generationMs: null, totalMs: 1000 });
});

test("each invocation starts anew after errors, retries and tool execution", async () => {
  let clock = 0;
  const tracker = createRequestPerformanceTracker(() => clock);
  for (const [start, stopReason] of [[0, "error"], [5000, "toolUse"], [20000, "stop"]]) {
    clock = start;
    const upstream = createAssistantMessageEventStream();
    const stream = tracker.wrap(() => upstream)(model, { messages: [] });
    await tick();
    clock = start + 200;
    upstream.push({ type: "text_delta", delta: "x", contentIndex: 0, partial: assistant("pending") });
    await tick();
    clock = start + 700;
    const message = assistant(stopReason);
    upstream.push(stopReason === "error" ? { type: "error", reason: "error", error: message }
      : { type: "done", reason: stopReason, message });
    const result = await stream.result();
    assert.equal(result.stopReason, stopReason);
    assert.deepEqual(result.piWebPerformance, { version: 1, ttftMs: 200, generationMs: 500, totalMs: 700 });
  }
});

test("unexpected rejected providers and iterators settle instead of hanging", async () => {
  const tracker = createRequestPerformanceTracker(() => 1);
  for (const provider of [
    () => { throw new Error("sync failed"); },
    async () => { throw new Error("async failed"); },
    () => ({ async *[Symbol.asyncIterator]() { throw new Error("iterator failed"); } }),
  ]) {
    const result = await tracker.wrap(provider)(model, { messages: [] }).result();
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage, /failed/);
  }
  const controller = new AbortController();
  controller.abort();
  const result = await tracker.wrap(() => { throw new Error("cancelled"); })(model, { messages: [] }, { signal: controller.signal }).result();
  assert.equal(result.stopReason, "aborted");
});

test("end(result) providers settle and message_end replacements can restore timing", async () => {
  const f = fixture();
  await f.emit(1200, { type: "text_delta", delta: "hi", contentIndex: 0, partial: f.partial });
  f.setClock(2200);
  f.upstream.end(assistant());
  const result = await f.stream.result();
  const timing = result.piWebPerformance;
  delete result.piWebPerformance;
  f.tracker.restore(result);
  assert.equal(result.piWebPerformance, timing);
  assert.equal(timing.ttftMs, 200);
});

test("SDK JSONL reopen, UI history and branch cloning preserve the timing field", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-performance-"));
  try {
    const f = fixture();
    await f.emit(1200, { type: "text_delta", delta: "hi", contentIndex: 0, partial: f.partial });
    await f.emit(2200, { type: "done", reason: "stop", message: assistant() });
    const message = await f.stream.result();
    const manager = SessionManager.create(dir, dir);
    manager.appendMessage({ role: "user", content: "hello", timestamp: 0 });
    const id = manager.appendMessage(message);
    const reopened = SessionManager.open(manager.getSessionFile());
    assert.deepEqual(reopened.getEntry(id).message.piWebPerformance, message.piWebPerformance);
    const context = buildSessionContext(reopened.getEntries());
    assert.deepEqual(context.messages.at(-1).piWebPerformance, message.piWebPerformance);
    const clonedPath = reopened.createBranchedSession(id);
    const cloned = SessionManager.open(clonedPath);
    assert.deepEqual(cloned.getEntries().find((entry) => entry.type === "message" && entry.message.role === "assistant").message.piWebPerformance, message.piWebPerformance);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("real SDK wrapper persists measured message_end and returns session performance", { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-performance-sdk-"));
  let wrapper;
  try {
    const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
    const services = await createAgentSessionServices({
      cwd: dir, agentDir: dir,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true },
    });
    const sdkModel = getModel("anthropic", "claude-sonnet-4-5");
    await services.modelRuntime.setRuntimeApiKey(sdkModel.provider, "test-only");
    const { session } = await createAgentSessionFromServices({
      services, model: sdkModel, tools: [], sessionManager: SessionManager.create(dir, dir),
    });
    session.agent.streamFunction = () => {
      const stream = createAssistantMessageEventStream();
      const partial = { ...assistant("pending"), api: sdkModel.api, provider: sdkModel.provider, model: sdkModel.id, content: [] };
      void (async () => {
        await tick();
        stream.push({ type: "start", partial });
        stream.push({ type: "text_start", contentIndex: 0, partial });
        await tick();
        partial.content = [{ type: "text", text: "hello" }];
        stream.push({ type: "text_delta", contentIndex: 0, delta: "hello", partial });
        await tick();
        stream.push({ type: "text_end", contentIndex: 0, content: "hello", partial });
        stream.push({ type: "done", reason: "stop", message: { ...partial, stopReason: "stop" } });
        stream.end();
      })();
      return stream;
    };
    wrapper = new AgentSessionWrapper(session, { headless: true });
    wrapper.start();
    let completed;
    wrapper.onEvent((event) => { if (event.type === "message_end" && event.message.role === "assistant") completed = event.message; });
    await session.prompt("test");
    assert.ok(completed.piWebPerformance.ttftMs >= 0);
    assert.ok(completed.piWebPerformance.generationMs > 0);
    const reopened = SessionManager.open(session.sessionFile);
    assert.deepEqual(reopened.getEntries().find((entry) => entry.type === "message" && entry.message.role === "assistant").message.piWebPerformance, completed.piWebPerformance);
    const stats = await wrapper.send({ type: "get_session_stats" });
    assert.equal(stats.performance.ttftSamples, 1);
    assert.equal(stats.performance.outputTokens, 50);
  } finally {
    await wrapper?.shutdown();
    await rm(dir, { recursive: true, force: true });
  }
});

test("compact SSE deltas and reconnect snapshots carry server timing to the reducer", async () => {
  const f = fixture();
  f.partial.content = [{ type: "text", text: "" }];
  let state = streamReducer(INITIAL_STREAMING_STATE, { type: "snapshot", message: f.partial });
  await f.emit(1250, { type: "text_delta", delta: "hi", contentIndex: 0, partial: f.partial });
  const projected = toClientAgentEvent({ type: "message_update", assistantMessageEvent: {
    type: "text_delta", delta: "hi", contentIndex: 0, partial: f.partial,
  } });
  assert.equal("partial" in projected.assistantMessageEvent, false);
  state = streamReducer(state, { type: "delta", event: projected.assistantMessageEvent });
  assert.equal(state.streamingMessage.piWebPerformance.ttftMs, 250);
  await f.emit(2250, { type: "text_delta", delta: "!", contentIndex: 0, partial: f.partial });
  state = streamReducer(state, { type: "snapshot", message: f.partial });
  assert.equal(state.streamingMessage.piWebPerformance.generationMs, 1000);
  await f.emit(2300, { type: "done", reason: "stop", message: assistant() });
});
