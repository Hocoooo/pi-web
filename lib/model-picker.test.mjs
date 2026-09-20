import assert from "node:assert/strict";
import test from "node:test";
import { filterModelOptions, hasThinkingPickerConfig, initialThinkingLevel, modelKey, nextPickerIndex } from "./model-picker.ts";

const options = [
  { provider: "ollama", modelId: "qwen3:latest", name: "Qwen 3" },
  { provider: "anthropic", modelId: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
  { provider: "openai", modelId: "gpt-5.4", name: "GPT-5.4" },
];

test("filterModelOptions matches name, id and provider-qualified references", () => {
  assert.deepEqual(filterModelOptions(options, "QWEN"), [options[0]]);
  assert.deepEqual(filterModelOptions(options, "claude-sonnet"), [options[1]]);
  assert.deepEqual(filterModelOptions(options, "OpenAI"), [options[2]]);
  assert.deepEqual(filterModelOptions(options, "anthropic/claude"), [options[1]]);
  assert.equal(filterModelOptions(options, "missing").length, 0);
  assert.equal(filterModelOptions(options, "  "), options);
});

test("thinking picker config is present even before levels load", () => {
  assert.equal(hasThinkingPickerConfig(undefined), false);
  assert.equal(hasThinkingPickerConfig({ levels: {}, onConfirm: async () => ({}) }), true);
  assert.equal(hasThinkingPickerConfig({ levels: { "p:a": ["off"] }, onConfirm: async () => ({}) }), true);
});

test("initialThinkingLevel prefers the current value, then high, then the first level", () => {
  assert.equal(initialThinkingLevel(["off", "low", "high"], "low"), "low");
  assert.equal(initialThinkingLevel(["off", "low", "high"], "max"), "high");
  assert.equal(initialThinkingLevel(["off", "low"], "high"), "off");
  assert.equal(initialThinkingLevel([], "high"), "");
});

test("nextPickerIndex wraps and honors Home/End", () => {
  assert.equal(nextPickerIndex(0, 3, "ArrowDown"), 1);
  assert.equal(nextPickerIndex(2, 3, "ArrowDown"), 0);
  assert.equal(nextPickerIndex(0, 3, "ArrowUp"), 2);
  assert.equal(nextPickerIndex(1, 3, "Home"), 0);
  assert.equal(nextPickerIndex(1, 3, "End"), 2);
  assert.equal(nextPickerIndex(-1, 0, "ArrowDown"), -1);
});

test("modelKey is provider plus model id", () => {
  assert.equal(modelKey(options[1]), "anthropic:claude-sonnet-4-6");
});
