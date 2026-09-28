import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import ts from "typescript";
import { isSettingsSlashCommand } from "../lib/model-command.ts";

const source = ts.createSourceFile("useAgentSession.ts", readFileSync(new URL("./useAgentSession.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
function callback(name, context) {
  function find(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) return node.initializer.arguments[0];
    return ts.forEachChild(node, find);
  }
  const node = find(source);
  assert.ok(node, name);
  return new Script(ts.transpileModule(`(${node.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText).runInNewContext(context);
}
function fixture(overrides = {}) {
  const calls = [];
  const context = {
    agentRunningRef: { current: false }, bashRunningRef: { current: false },
    modelSwitchPendingRef: { current: false }, isCompacting: false,
    sessionIdRef: { current: null }, ensuringNewSessionRef: { current: null }, isNew: true,
    newSessionModelOverrideRef: { current: null }, newSessionModel: null,
    thinkingLevelOverrideRef: { current: null }, currentModelOverride: null,
    thinkingLevelPinsRef: { current: {} }, defaultThinkingLevelRef: { current: "low" },
    sessionHookMountedRef: { current: true },
    asConcreteThinkingLevel: (level) => !level || level === "auto" ? null : level,
    displayModel: { provider: "p", modelId: "a" },
    modelThinkingLevels: { "p:a": ["off", "low", "high"] },
    modelList: [{ provider: "p", id: "a" }, { provider: "q", id: "a" }, { provider: "p", id: "unique" }],
    addNotice: (notice) => calls.push(["notice", notice]),
    ensureNewSession: async () => { throw new Error("settings must not create a session"); },
    sendAgentCommand: async (sid, command) => { calls.push(["rpc", sid, command]); return { level: "low", provider: "p", id: "a" }; },
    loadSession: async (...args) => { calls.push(["load", ...args]); return true; },
    setNewSessionThinkingLevel: (level) => calls.push(["startupThinking", level]),
    setNewSessionDefaultThinkingLevel: (level) => calls.push(["defaultThinking", level]),
    setCurrentThinkingOverride: (level) => calls.push(["thinkingOverride", level]),
    setLiveThinkingLevel: (level) => calls.push(["liveThinking", level]),
    setNewSessionModel: (model) => calls.push(["model", model]),
    setPendingModel() {}, setModelSwitching() {}, setCurrentModelOverride() {}, setLiveModel() {},
    ...overrides,
  };
  context.handleModelChange = callback("handleModelChange", context);
  context.handleThinkingLevelChange = callback("handleThinkingLevelChange", context);
  return { context, calls, command: callback("handleBuiltinSlashCommand", context) };
}

test("recognizes settings commands without swallowing other slash commands", () => {
  assert.ok(isSettingsSlashCommand(" /thinking high "));
  assert.ok(!isSettingsSlashCommand("/model-info"));
});

test("bare commands open selectors without creating sessions or making RPC calls", async () => {
  const { command, calls } = fixture();
  assert.equal((await command("/model")).action, "openModelSelector");
  assert.equal((await command("/thinking")).action, "openThinkingSelector");
  assert.equal(calls.length, 0);
});

test("ambiguous or missing models open a filtered selector rather than sending a prompt", async () => {
  const { command, calls } = fixture();
  for (const query of ["a", "unknown/model", "uni", "p/a", "unique"]) {
    const result = await command(`/model ${query}`);
    assert.equal(result.action, "openModelSelector");
    assert.equal(result.query, query);
  }
  assert.equal(calls.length, 0);
});

test("fresh-session settings update pending preferences without RPC", async () => {
  const { command, calls, context } = fixture();
  assert.equal((await context.handleModelChange("p", "a")).error, undefined);
  assert.equal(context.newSessionModelOverrideRef.current.modelId, "a");
  assert.equal((await command("/thinking HIGH")).error, undefined);
  assert.equal(context.thinkingLevelOverrideRef.current, "high");
  await command("/thinking auto");
  assert.equal(context.thinkingLevelOverrideRef.current, null);
  assert.ok(!calls.some(([kind]) => kind === "rpc"));
});

test("unsupported and malformed thinking values are consumed with errors", async () => {
  const { command, calls } = fixture();
  for (const value of ["max", "xhigh", "wrong", "high extra"]) {
    const result = await command(`/thinking ${value}`);
    assert.equal(result.handled, true);
    assert.ok(result.error);
  }
  assert.ok(!calls.some(([kind]) => kind === "rpc" || kind.endsWith("Thinking") || kind === "thinkingOverride"));
});

test("streaming, shell, compaction and pending switches reject settings", async () => {
  for (const override of [{ agentRunningRef: { current: true } }, { bashRunningRef: { current: true } }, { isCompacting: true }, { modelSwitchPendingRef: { current: true } }]) {
    const { command, calls } = fixture(override);
    for (const text of ["/model", "/model p/a", "/thinking", "/thinking high"]) assert.ok((await command(text)).error);
    assert.ok(!calls.some(([kind]) => kind === "rpc"));
  }
});

test("existing-session model and thinking commands reuse RPC and reload canonical state", async () => {
  const { command, calls, context } = fixture({ isNew: false, sessionIdRef: { current: "session" } });
  await context.handleModelChange("p", "a");
  const result = await command("/thinking high");
  assert.equal(result.message, "Thinking level: low");
  assert.equal(calls.filter(([kind]) => kind === "load").length, 2);
  assert.deepEqual(calls.filter(([kind]) => kind === "rpc").map(([, , cmd]) => cmd.type), ["set_model", "set_thinking_level"]);
});

test("RPC failure reports an error without a false success notice", async () => {
  for (const text of ["/thinking high", "/model p/a"]) {
    const { command, calls, context } = fixture({ isNew: false, sessionIdRef: { current: "session" }, sendAgentCommand: async () => { throw new Error("offline"); } });
    const result = text.startsWith("/model") ? await context.handleModelChange("p", "a") : await command(text);
    assert.match(result.error, /offline/);
    assert.ok(!calls.some(([kind, notice]) => kind === "notice" && notice.type === "success"));
    assert.equal(context.modelSwitchPendingRef.current, false);
  }
});

test("combined selection saves model and thinking startup preferences without creating a session", async () => {
  const { context, calls } = fixture();
  const result = await context.handleModelChange("p", "a", "high");
  assert.equal(result.error, undefined);
  assert.equal(context.newSessionModelOverrideRef.current.modelId, "a");
  assert.equal(context.thinkingLevelOverrideRef.current, "high");
  assert.ok(!calls.some(([kind]) => kind === "rpc"));
});

test("combined selection uses one RPC with the target level, not stale current-model levels", async () => {
  const { context, calls } = fixture({ isNew: false, sessionIdRef: { current: "session" }, modelThinkingLevels: { "q:a": ["off", "high"] } });
  const result = await context.handleModelChange("q", "a", "high");
  assert.equal(result.error, undefined);
  const commands = calls.filter(([kind]) => kind === "rpc");
  assert.equal(commands.length, 1);
  assert.equal(commands[0][2].thinkingLevel, "high");
  assert.equal(commands[0][2].provider, "q");
  assert.equal(commands[0][2].type, "set_model");
  assert.deepEqual(calls.filter(([kind]) => kind === "load").at(-1), ["load", "session", false, true]);
});

test("combined selection updates the live reasoning display from the server", async () => {
  const { context, calls } = fixture({
    isNew: false, sessionIdRef: { current: "session" },
    sendAgentCommand: async () => ({ provider: "p", id: "a", thinkingLevel: "high" }),
  });
  assert.equal((await context.handleModelChange("p", "a", "high")).error, undefined);
  assert.ok(calls.some(([kind, level]) => kind === "liveThinking" && level === "high"));
});

test("fresh model selection retains upstream thinking pins until explicitly overridden", async () => {
  const { context, calls } = fixture({ thinkingLevelPinsRef: { current: { "p/a": "high" } } });
  await context.handleModelChange("p", "a");
  assert.ok(calls.some(([kind, level]) => kind === "defaultThinking" && level === "high"));
  calls.length = 0;
  await context.handleModelChange("p", "a", "low");
  assert.ok(calls.some(([kind, level]) => kind === "startupThinking" && level === "low"));
  assert.ok(!calls.some(([kind]) => kind === "defaultThinking"));
});

test("failed startup settings restore the prior reasoning override", async () => {
  for (const changeModel of [true, false]) {
    const { context, calls } = fixture({
      sessionIdRef: { current: "session" }, thinkingLevelOverrideRef: { current: "low" },
      sendAgentCommand: async () => { throw new Error("offline"); },
    });
    const result = changeModel
      ? await context.handleModelChange("p", "a", "high")
      : await context.handleThinkingLevelChange("high");
    assert.match(result.error, /offline/);
    assert.equal(context.thinkingLevelOverrideRef.current, "low");
    assert.deepEqual(calls.filter(([kind]) => kind === "startupThinking").at(-1), ["startupThinking", "low"]);
  }
});

test("combined selection rejects unavailable target levels before updating local state", async () => {
  const { context, calls } = fixture();
  assert.ok((await context.handleModelChange("p", "a", "max")).error);
  assert.equal(context.newSessionModelOverrideRef.current, null);
  assert.equal(calls.length, 0);
});

test("auto on an existing session does not send a reasoning effort to the SDK", async () => {
  const { command, calls, context } = fixture({ isNew: false, sessionIdRef: { current: "session" } });
  const result = await command("/thinking auto");
  assert.equal(result.error, undefined);
  assert.equal(context.thinkingLevelOverrideRef.current, null);
  assert.ok(calls.some(([kind, level]) => kind === "thinkingOverride" && level === null));
  assert.ok(!calls.some(([kind]) => kind === "liveThinking"));
  assert.ok(!calls.some(([kind]) => kind === "rpc"));
});
