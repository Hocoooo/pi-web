import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { getNextCueContext, generateNextCue, parseNextCue, parseNextCueModelRequest, UnavailableNextCueModelError } = await createJiti(import.meta.url).import("./next-cue.ts");

const entry = (id, role, text, stopReason = "stop") => ({
  type: "message", id,
  message: { role, content: [{ type: "text", text }], ...(role === "assistant" ? { stopReason } : {}) },
});
function source(branch, generate = async () => ({
  stopReason: "stop", content: [{ type: "text", text: "Run the tests" }],
})) {
  return {
    model: { id: "test-model", provider: "test" },
    isIdle: true,
    sessionManager: { getBranch: () => branch },
    modelRuntime: { completeSimple: generate },
  };
}

test("validates a client-selected model without accepting malformed or oversized input", () => {
  assert.equal(parseNextCueModelRequest({ model: null }), null);
  assert.deepEqual(parseNextCueModelRequest({ model: { provider: "fast", modelId: "small" } }), { provider: "fast", modelId: "small" });
  for (const invalid of [null, {}, { model: "fast" }, { model: { provider: "", modelId: "small" } },
    { model: { provider: "fast", modelId: "x".repeat(201) } }]) {
    assert.throws(() => parseNextCueModelRequest(invalid));
  }
});

test("extracts a bounded active-branch transcript without touching the session", () => {
  const branch = [entry("1", "user", "x".repeat(900)), entry("2", "assistant", "done")];
  const snapshot = structuredClone(branch);
  const context = getNextCueContext(source(branch));
  assert.equal(context.leafId, "2");
  assert.match(context.prompt, /User: x{500}/);
  assert.doesNotMatch(context.prompt, /x{501}/);
  assert.match(context.prompt, /Assistant: done/);
  assert.deepEqual(branch, snapshot);
});

test("skips incomplete, failed or user-trailing branches", () => {
  assert.equal(getNextCueContext(source([entry("1", "user", "go")])), null);
  assert.equal(getNextCueContext(source([entry("1", "user", "go"), entry("2", "assistant", "working", "toolUse")])), null);
  assert.equal(getNextCueContext(source([entry("1", "user", "go"), entry("2", "assistant", "failed", "error")])), null);
  assert.equal(getNextCueContext(source([entry("1", "user", "go"), entry("2", "assistant", "done"), entry("3", "user", "new request")])), null);
});

test("includes the initiating request after many assistant/tool messages", () => {
  const branch = [entry("user", "user", "Fix the login redirect")];
  for (let i = 0; i < 8; i++) branch.push(entry(`assistant-${i}`, "assistant", `Tool step ${i}`));
  const context = getNextCueContext(source(branch));
  assert.equal(context.leafId, "assistant-7");
  assert.match(context.prompt, /User: Fix the login redirect/);
  assert.match(context.prompt, /Assistant: Tool step 7/);
  assert.doesNotMatch(context.prompt, /Tool step 0/);
});

test("an empty failed terminal reply cannot fall back to an earlier completed assistant", () => {
  const branch = [entry("1", "user", "fix"), entry("2", "assistant", "done"), entry("3", "assistant", "", "aborted")];
  assert.equal(getNextCueContext(source(branch)), null);
  branch[2].message.stopReason = "error";
  assert.equal(getNextCueContext(source(branch)), null);
});

test("rejects empty, multiline and overlong model outputs", () => {
  assert.equal(parseNextCue(' “运行测试” '), "运行测试");
  assert.equal(parseNextCue(""), null);
  assert.equal(parseNextCue("first\nsecond"), null);
  assert.equal(parseNextCue("a".repeat(101)), null);
});

test("generates separately from the current session and never submits a message", async () => {
  const branch = [entry("1", "user", "fix it"), entry("2", "assistant", "Fixed it")];
  let observed;
  const session = source(branch, async (model, context, options) => {
    observed = { model, context, options };
    return { stopReason: "stop", content: [{ type: "text", text: "Run the tests" }] };
  });
  assert.deepEqual(await generateNextCue(session), { text: "Run the tests", leafId: "2" });
  assert.equal(observed.context.messages.length, 1);
  assert.equal(observed.options.toolChoice, "none");
  assert.equal(branch.length, 2);
});

test("uses the selected suggestion model without changing the chat model", async () => {
  const branch = [entry("1", "user", "fix"), entry("2", "assistant", "done")];
  let selected;
  const session = source(branch, async (model) => {
    selected = model;
    return { stopReason: "stop", content: [{ type: "text", text: "Run tests" }] };
  });
  const custom = { provider: "fast", id: "cheap" };
  session.modelRuntime.getModel = (provider, id) => provider === custom.provider && id === custom.id ? custom : undefined;
  session.modelRuntime.getAvailableSnapshot = () => [custom];
  assert.deepEqual(await generateNextCue(session, undefined, { provider: "fast", modelId: "cheap" }), { text: "Run tests", leafId: "2" });
  assert.equal(selected, custom);
  assert.equal(session.model.id, "test-model");
  await assert.rejects(generateNextCue(session, undefined, { provider: "missing", modelId: "unknown" }), UnavailableNextCueModelError);
  session.modelRuntime.getAvailableSnapshot = () => [];
  await assert.rejects(generateNextCue(session, undefined, { provider: "fast", modelId: "cheap" }), UnavailableNextCueModelError);
  assert.equal(selected, custom);
});

test("discards a response when another run starts or the branch changes", async () => {
  const branch = [entry("1", "user", "fix"), entry("2", "assistant", "done")];
  const session = source(branch, async () => {
    branch.push(entry("3", "user", "other"));
    return { stopReason: "stop", content: [{ type: "text", text: "Follow up" }] };
  });
  assert.equal(await generateNextCue(session), null);
  assert.equal(await generateNextCue({ ...source(branch), isIdle: false }), null);
});
