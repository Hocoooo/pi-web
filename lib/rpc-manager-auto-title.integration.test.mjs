import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const { AgentSessionWrapper } = await createJiti(import.meta.url).import("./rpc-manager.ts");
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function fixture(t, { automaticTitles = true, finalReason = "stop", background = false, historical = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "pi-web-auto-title-sdk-"));
  const child = Promise.withResolvers();
  const waiting = Promise.withResolvers();
  const titleGate = Promise.withResolvers();
  const complete = Promise.withResolvers();
  const titled = Promise.withResolvers();
  let parentCalls = 0;
  const titleCalls = [];
  const events = [];
  const services = await createAgentSessionServices({
    cwd: directory, agentDir: directory,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true,
      extensionFactories: [(pi) => {
        pi.registerCommand("handled", { handler: async () => {} });
        pi.on("agent_end", async () => {
          if (!background || parentCalls !== 1) return;
          waiting.resolve();
          await child.promise;
          pi.sendMessage({ customType: "review", content: "Finish delivery", display: false }, { triggerTurn: true });
        });
      }],
    },
  });
  const model = getModel("anthropic", "claude-sonnet-4-5");
  await services.modelRuntime.setRuntimeApiKey(model.provider, "test-only");
  const sessionManager = SessionManager.inMemory(directory);
  if (historical) {
    sessionManager.appendMessage({ role: "user", content: "Historical goal", timestamp: 1 });
    sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Already done" }], stopReason: "stop", timestamp: 2 });
  }
  const { session } = await createAgentSessionFromServices({ services, model, tools: [], sessionManager });
  session.agent.streamFunction = (model, context, options) => {
    const isTitle = context.messages[0]?.role === "system"
      && JSON.stringify(context.messages[0].content).includes("You name chat sessions");
    if (isTitle) titleCalls.push({ model, context, options });
    else parentCalls++;
    const stream = createAssistantMessageEventStream();
    const message = {
      role: "assistant", content: [{ type: "text", text: isTitle ? "Deliver reviewed feature" : `Delivery ${parentCalls}` }],
      api: model.api, provider: model.provider, model: model.id,
      stopReason: isTitle ? "stop" : finalReason, timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    void (async () => {
      if (isTitle) await titleGate.promise;
      stream.push(message.stopReason === "error" || message.stopReason === "aborted"
        ? { type: "error", reason: message.stopReason, error: message }
        : { type: "done", reason: message.stopReason, message });
      stream.end();
    })();
    return stream;
  };
  const notifications = [];
  const wrapper = new AgentSessionWrapper(session, {
    automaticTitles, headless: true, suppressCompletionNotifications: true,
    onAgentRunComplete: (id) => notifications.push(id),
  });
  t.after(async () => {
    child.resolve(); titleGate.resolve();
    await wrapper.shutdown();
    rmSync(directory, { recursive: true, force: true });
  });
  wrapper.start();
  wrapper.onEvent((event) => {
    events.push(event.type);
    if (event.type === "prompt_done") complete.resolve();
    if (event.type === "session_title_updated") titled.resolve(event);
  });
  wrapper.beginExtensionBinding();
  return { wrapper, session, titleCalls, events, child, waiting, titleGate, complete, titled, notifications };
}

test("automatic naming waits for the logical run, remains independent of notifications and does not block prompt_done", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, { background: true });
  await f.wrapper.send({ type: "prompt", message: "Implement and review" });
  await f.waiting.promise;
  assert.equal(f.titleCalls.length, 0);
  assert.equal(f.events.includes("prompt_done"), false);
  f.child.resolve();
  await f.complete.promise;
  await tick();
  assert.equal(f.titleCalls.length, 1);
  assert.equal(f.wrapper.isRunning(), false, "title generation is not main-agent work");
  assert.equal(f.session.sessionManager.getSessionName(), undefined);
  assert.equal(f.session.messages.filter((message) => message.role === "assistant").length, 2);
  assert.equal(f.titleCalls[0].context.tools, undefined);
  assert.equal(f.titleCalls[0].model.id, f.session.model.id);
  f.titleGate.resolve();
  const event = await f.titled.promise;
  assert.equal(event.title, "Deliver reviewed feature");
  assert.equal(event.autoTitleEnabled, true);
  assert.equal(f.notifications.length, 0);
  assert.equal(f.events.filter((type) => type === "prompt_done").length, 1);
  assert.equal(f.session.messages.filter((message) => message.role === "assistant").length, 2);

  const beforeInfo = f.session.sessionManager.getEntries().filter((entry) => entry.type === "session_info").length;
  await f.wrapper.send({ type: "prompt", message: "Now document it" });
  await f.session.waitForIdle();
  await tick();
  assert.equal(f.titleCalls.length, 2);
  assert.equal(f.session.sessionManager.getEntries().filter((entry) => entry.type === "session_info").length, beforeInfo);
  await f.wrapper.send({ type: "set_session_name", name: "Pinned by user" });
  await f.wrapper.send({ type: "prompt", message: "Another follow up" });
  await f.session.waitForIdle();
  await tick();
  assert.equal(f.titleCalls.length, 2);
  assert.equal(f.session.sessionManager.getSessionName(), "Pinned by user");
});

test("a handled extension command does not name an unchanged historical conversation", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, { historical: true });
  await f.wrapper.send({ type: "prompt", message: "/handled" });
  await f.complete.promise;
  await tick();
  assert.equal(f.titleCalls.length, 0);
});

for (const reason of ["error", "aborted", "length"]) {
  test(`SDK run ending in ${reason} does not generate a title`, { timeout: 10_000 }, async (t) => {
    const f = await fixture(t, { finalReason: reason });
    await f.wrapper.send({ type: "prompt", message: "Test unsuccessful completion" });
    await f.complete.promise;
    await tick();
    assert.equal(f.titleCalls.length, 0);
  });
}

test("subagent-style wrappers do not opt in to automatic naming", { timeout: 10_000 }, async (t) => {
  const f = await fixture(t, { automaticTitles: false });
  await f.wrapper.send({ type: "prompt", message: "Run a bounded subtask" });
  await f.complete.promise;
  await tick();
  assert.equal(f.titleCalls.length, 0);
});
