import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
  createAgentSessionServices, createAgentSessionFromServices,
  SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");

// Exercise the real SDK's agent_end -> queued notification -> continuation
// boundary, with deterministic background work and no model/network calls.
test("headless prompt_done waits for background work AND the parent continuation", { timeout: 10_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-web-headless-"));
  const child = Promise.withResolvers();
  const waiting = Promise.withResolvers();
  const completed = Promise.withResolvers();
  let calls = 0;
  let headless;
  const services = await createAgentSessionServices({
    cwd: directory,
    agentDir: directory,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
    resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true,
      extensionFactories: [(pi) => {
        pi.on("agent_end", async (_event, ctx) => {
          if (calls !== 1) return;
          headless = !ctx.hasUI;
          waiting.resolve();
          if (!headless) return;
          await child.promise;
          pi.sendMessage({ customType: "test-review", content: "Review complete; finalize delivery.", display: false }, { triggerTurn: true });
        });
      }],
    },
  });
  const model = getModel("anthropic", "claude-sonnet-4-5");
  await services.modelRuntime.setRuntimeApiKey(model.provider, "test-only");
  const { session } = await createAgentSessionFromServices({
    services, model, tools: [], sessionManager: SessionManager.inMemory(directory),
  });
  session.agent.streamFunction = () => {
    calls += 1;
    const stream = createAssistantMessageEventStream();
    const message = {
      role: "assistant", content: [{ type: "text", text: calls === 1 ? "Review pending" : "Final delivery" }],
      api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    queueMicrotask(() => {
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
    });
    return stream;
  };
  const wrapper = new AgentSessionWrapper(session, { headless: true });
  t.after(async () => {
    child.resolve();
    await wrapper.shutdown();
    rmSync(directory, { recursive: true, force: true });
  });
  const events = [];
  wrapper.start();
  wrapper.onEvent((event) => {
    events.push(event.type);
    if (event.type === "prompt_done") completed.resolve();
  });
  wrapper.beginExtensionBinding();
  await wrapper.send({ type: "prompt", message: "Make an effect and review it" });
  await waiting.promise;
  assert.equal(headless, true);
  assert.equal(events.includes("prompt_done"), false);
  assert.equal(wrapper.isRunning(), true);
  child.resolve();
  await completed.promise;
  assert.equal(calls, 2);
  assert.equal(session.getLastAssistantText(), "Final delivery");
  assert.equal(events.filter((type) => type === "prompt_done").length, 1);
  assert.equal(wrapper.isRunning(), false);
});
