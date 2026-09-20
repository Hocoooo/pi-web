import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
function fixture(t, overrides = {}) {
  const calls = [];
  const inner = {
    sessionId: "settings-test", isStreaming: false, isCompacting: false, isBashRunning: false,
    extensionRunner: {}, sessionManager: { getCwd: () => "/tmp" },
    agent: { state: { thinkingLevel: "off" } },
    modelRuntime: { getModel: () => ({ provider: "p", id: "m" }) },
    setModel: async (model) => { calls.push(model); },
    setThinkingLevel(level) { calls.push(level); this.agent.state.thinkingLevel = level === "xhigh" ? "high" : level; },
    abortBash() {}, dispose() {}, ...overrides,
  };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  return { wrapper, calls };
}

test("settings RPC returns the effective thinking level after SDK adjustment", async (t) => {
  const { wrapper } = fixture(t);
  assert.deepEqual(await wrapper.send({ type: "set_thinking_level", level: "xhigh" }), { level: "high" });
});

test("settings RPC rejects malformed levels and the composer-only auto value", async (t) => {
  const { wrapper, calls } = fixture(t);
  for (const level of ["auto", "invalid", "HIGH", null, 1]) {
    await assert.rejects(wrapper.send({ type: "set_thinking_level", level }), /Invalid thinking level/);
  }
  assert.equal(calls.length, 0);
});

test("settings RPC cannot switch while generation, compaction or shell execution is active", async (t) => {
  for (const key of ["isStreaming", "isCompacting", "isBashRunning"]) {
    const { wrapper, calls } = fixture(t, { [key]: true });
    await assert.rejects(wrapper.send({ type: "set_model", provider: "p", modelId: "m" }), /busy/);
    await assert.rejects(wrapper.send({ type: "set_thinking_level", level: "high" }), /busy/);
    assert.equal(calls.length, 0);
  }
});

test("combined model selection validates the target capability before changing settings", async (t) => {
  const { wrapper, calls } = fixture(t, { modelRuntime: { getModel: () => ({ provider: "p", id: "m", reasoning: false }) } });
  for (const thinkingLevel of ["high", "auto", "bogus", null]) {
    await assert.rejects(wrapper.send({ type: "set_model", provider: "p", modelId: "m", thinkingLevel }), /Unsupported thinking level/);
  }
  assert.equal(calls.length, 0);
  assert.deepEqual(await wrapper.send({ type: "set_model", provider: "p", modelId: "m", thinkingLevel: "off" }), { provider: "p", id: "m", thinkingLevel: "off" });
  assert.equal(calls.length, 2);
});

test("combined model selection applies and returns the chosen reasoning effort", async (t) => {
  const { wrapper, calls } = fixture(t, { modelRuntime: { getModel: () => ({ provider: "p", id: "m", reasoning: true }) } });
  assert.deepEqual(await wrapper.send({ type: "set_model", provider: "p", modelId: "m", thinkingLevel: "high" }), { provider: "p", id: "m", thinkingLevel: "high" });
  assert.equal(calls[1], "high");
});

test("combined model selection skips the TUI thinking picker while applying the chosen level", async (t) => {
  let selected;
  const inner = {
    sessionId: "settings-test", isStreaming: false, isCompacting: false, isBashRunning: false,
    extensionRunner: {}, sessionManager: { getCwd: () => "/tmp" },
    agent: { state: { thinkingLevel: "off" } },
    modelRuntime: { getModel: () => ({ provider: "p", id: "m", reasoning: true }) },
    async setModel() {
      const ui = wrapper.createExtensionUiContext();
      selected = await ui.select("Thinking level for m", ["off", "high"]);
    },
    setThinkingLevel(level) { this.agent.state.thinkingLevel = level; },
    abortBash() {}, dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  await wrapper.send({ type: "set_model", provider: "p", modelId: "m", thinkingLevel: "high" });
  assert.equal(selected, undefined);
  assert.equal(events.some((event) => event.method === "select"), false);
});

test("idle model switching keeps the existing RPC response contract", async (t) => {
  const { wrapper, calls } = fixture(t);
  assert.deepEqual(await wrapper.send({ type: "set_model", provider: "p", modelId: "m" }), { provider: "p", id: "m" });
  assert.equal(calls.length, 1);
});

test("combined model selection does not rebuild the models cache", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const setModelSource = source.slice(source.indexOf('case "set_model"'), source.indexOf('case "fork"'));
  assert.match(setModelSource, /invalidateSessionListCache\(\)/);
  assert.doesNotMatch(setModelSource, /invalidateModelsCache\(\)/);
});
