// Integration regression: mounted useAgentSession + real RPC/SDK, in-memory settings
// and sessions. Only browser transports and the model provider are test doubles.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { createJiti } from "jiti";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream, InMemoryCredentialStore, InMemoryModelsStore,
} from "@earendil-works/pi-ai";

const { AgentSessionWrapper } = await createJiti(import.meta.url).import("../lib/rpc-manager.ts");
const root = fileURLToPath(new URL("../", import.meta.url));
const { outputFiles } = await build({
  absWorkingDir: root, bundle: true, write: false, platform: "browser", format: "iife",
  jsx: "automatic", define: { "process.env.NODE_ENV": '"development"' },
  stdin: { resolveDir: root, loader: "tsx", contents: `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { useAgentSession } from "./hooks/useAgentSession";
    // SSE is a transport boundary, not a replacement for the hook's handlers.
    window.EventSource = class {
      readyState = 1;
      constructor() {
        queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ type: "connected" }) }));
      }
      close() { this.readyState = 2; }
    };
    function App() {
      window.chat = useAgentSession({
        session: null, newSessionCwd: "/test-project", newSessionDraftKey: "test-draft",
      });
      return <output data-testid="thinking">{window.chat.thinkingLevel}</output>;
    }
    createRoot(document.getElementById("root")).render(<App/>);
  ` },
});

const browser = await chromium.launch({ headless: true,
  ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
});
const sandbox = await mkdtemp(join(tmpdir(), "pi-web-first-prompt-"));
async function runCase(name, options, arrange) {
  const efforts = [];
  const requestedModels = [];
  const settings = SettingsManager.inMemory({ defaultThinkingLevel: "medium" });
  let creationStarted;
  const creating = new Promise((resolve) => { creationStarted = resolve; });
  let releaseCreation;
  const creationGate = new Promise((resolve) => { releaseCreation = resolve; });
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
    modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
  });
  runtime.registerProvider("test", {
    api: "openai-completions", baseUrl: "http://unused.invalid", apiKey: "test-only",
    models: ["reasoning", "other-reasoning"].map((id) => ({ id, name: id, reasoning: true, input: ["text"],
      contextWindow: 10000, maxTokens: 1000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
    streamSimple(model, _context, options) {
      requestedModels.push(`${model.provider}/${model.id}`);
      efforts.push(options?.reasoning);
      const stream = createAssistantMessageEventStream();
      const message = { role: "assistant", content: [{ type: "text", text: "OK" }],
        api: model.api, provider: model.provider, model: model.id, stopReason: "stop",
        timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
          totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
      return stream;
    },
  });
  const loader = new DefaultResourceLoader({
    cwd: sandbox, agentDir: sandbox, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  let wrapper;
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("http://first-prompt.test/**", async (route) => {
    const url = new URL(route.request().url());
    const body = route.request().postDataJSON();
    let response;
    try {
      if (url.pathname === "/") {
        await route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
        return;
      }
      if (url.pathname === "/api/models") {
        response = { models: { "test:reasoning": "Reasoning" },
          modelList: [{ provider: "test", id: "reasoning", name: "Reasoning" }],
          defaultModel: { provider: "test", modelId: "reasoning" }, defaultThinkingLevel: "medium",
          thinkingLevels: { "test:reasoning": ["off", "low", "medium", "high"] },
          thinkingLevelPins: options.pin ? { "test/reasoning": options.pin } : {} };
      } else if (url.pathname === "/api/agent/new") {
        const { session } = await createAgentSession({
          cwd: sandbox, agentDir: sandbox, settingsManager: settings,
          sessionManager: SessionManager.inMemory(sandbox), resourceLoader: loader,
          modelRuntime: runtime, model: runtime.getModel("test", "reasoning"), tools: [],
          ...((body.thinkingLevel ?? options.pin) ? { thinkingLevel: body.thinkingLevel ?? options.pin } : {}),
        });
        wrapper = new AgentSessionWrapper(session);
        creationStarted();
        if (options.deferCreation) await creationGate;
        response = { sessionId: wrapper.sessionId, model: { provider: "test", modelId: "reasoning" },
          thinkingLevel: session.thinkingLevel };
      } else if (url.pathname.endsWith("/state")) {
        response = { running: true, state: await wrapper.send({ type: "get_state" }) };
      } else if (url.pathname.startsWith("/api/sessions/")) {
        const state = await wrapper.send({ type: "get_state" });
        response = { sessionId: wrapper.sessionId, filePath: "", totalActiveMs: 0,
          tree: [], leafId: null, context: { messages: [], entryIds: [], oldestEntryId: null,
            hasMore: false, model: { provider: "test", modelId: "reasoning" }, thinkingLevel: state.thinkingLevel } };
      } else if (url.pathname.startsWith("/api/agent/") && body) {
        response = { success: true, data: await wrapper.send(body) };
      } else {
        throw new Error(`Unexpected test request: ${url.pathname}`);
      }
      await route.fulfill({ json: response });
    } catch (error) {
      errors.push(error.message);
      await route.fulfill({ status: 500, json: { error: error.message } });
    }
  });
  try {
    await page.goto("http://first-prompt.test/");
    await page.addScriptTag({ content: outputFiles[0].text });
    await page.waitForFunction(() => window.chat?.modelList.length === 1);
    await arrange({ page, creating, releaseCreation,
      getState: () => wrapper.send({ type: "get_state" }), sendCommand: (command) => wrapper.send(command) });
    await page.waitForFunction(() => !window.chat.modelSwitching);
    await page.evaluate(() => window.chat.handleSend("First message"));
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => window.chat.notices.filter((notice) => notice.type === "error")), []);
    assert.deepEqual(requestedModels, ["test/reasoning"], `${name}: first model request target`);
    assert.deepEqual(efforts, [options.expectedEffort ?? "high"], `${name}: first model request effort`);
    assert.equal(settings.getDefaultThinkingLevel(), "medium", "session synchronization must not rewrite global defaults");
    console.log("PASS", name);
  } finally {
    releaseCreation();
    await page.close();
    wrapper?.destroy();
  }
}

try {
  await runCase("pre-created runtime retains selected high on first prompt", {}, async ({ page, getState }) => {
    // Opening slash-command completion pre-creates a dormant runtime.
    await page.evaluate(() => window.chat.loadSlashCommands());
    const selection = await page.evaluate(() => window.chat.handleModelChange("test", "reasoning", "high"));
    assert.equal(selection.error, undefined);
    assert.equal((await getState()).thinkingLevel, "high");
    await page.waitForFunction(() => window.chat.thinkingLevel === "high");
  });
  await runCase("in-flight runtime creation retains a later high selection", { deferCreation: true }, async ({ page, creating, releaseCreation, getState }) => {
    const warming = page.evaluate(() => window.chat.loadSlashCommands());
    await creating;
    const selecting = page.evaluate(() => window.chat.handleModelChange("test", "reasoning", "high"));
    await page.waitForFunction(() => window.chat.thinkingLevel === "high");
    releaseCreation();
    const [selection] = await Promise.all([selecting, warming]);
    assert.equal(selection.error, undefined);
    assert.equal((await getState()).thinkingLevel, "high");
  });
  await runCase("auto retains the target model's startup thinking pin", { pin: "high" }, async ({ page, getState }) => {
    await page.evaluate(() => window.chat.handleModelChange("test", "reasoning"));
    await page.evaluate(() => window.chat.handleThinkingLevelChange("auto"));
    await page.evaluate(() => window.chat.loadSlashCommands());
    assert.equal((await getState()).thinkingLevel, "high");
  });
  await runCase("auto retains the SDK-clamped startup pin", { pin: "xhigh" }, async ({ page, getState }) => {
    await page.evaluate(() => window.chat.handleModelChange("test", "reasoning"));
    await page.evaluate(() => window.chat.loadSlashCommands());
    assert.equal((await getState()).thinkingLevel, "high");
  });
  await runCase("unsynchronized effort is restored before the first prompt", {}, async ({ page, sendCommand }) => {
    await page.evaluate(() => window.chat.loadSlashCommands());
    await page.evaluate(() => window.chat.handleModelChange("test", "reasoning", "high"));
    await sendCommand({ type: "set_thinking_level", level: "medium" });
  });
  await runCase("a dormant composer starts its first runtime with explicit high", {}, async ({ page }) => {
    await page.evaluate(() => window.chat.handleModelChange("test", "reasoning", "high"));
  });
  await runCase("auto without a pin retains the SDK medium default", { expectedEffort: "medium" }, async ({ page, getState }) => {
    await page.evaluate(() => window.chat.handleModelChange("test", "reasoning"));
    await page.evaluate(() => window.chat.handleThinkingLevelChange("auto"));
    await page.evaluate(() => window.chat.loadSlashCommands());
    assert.equal((await getState()).thinkingLevel, "medium");
  });
  await runCase("explicit high overrides a low startup pin", { pin: "low" }, async ({ page }) => {
    await page.evaluate(() => window.chat.loadSlashCommands());
    await page.evaluate(() => window.chat.handleModelChange("test", "reasoning", "high"));
  });
  await runCase("the latest thinking choice wins over the earlier model confirmation", { expectedEffort: "low" }, async ({ page }) => {
    await page.evaluate(() => window.chat.loadSlashCommands());
    await page.evaluate(() => window.chat.handleModelChange("test", "reasoning", "high"));
    const selection = await page.evaluate(() => window.chat.handleThinkingLevelChange("low"));
    assert.equal(selection.error, undefined);
  });
  await runCase("an unsynchronized model is restored together with explicit high", {}, async ({ page, sendCommand }) => {
    await page.evaluate(() => window.chat.loadSlashCommands());
    await page.evaluate(() => window.chat.handleModelChange("test", "reasoning", "high"));
    await sendCommand({ type: "set_model", provider: "test", modelId: "other-reasoning", thinkingLevel: "medium" });
  });
} finally {
  await browser.close();
  await rm(sandbox, { recursive: true, force: true });
}
