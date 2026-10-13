import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createJiti } from "jiti";

const { buildTitleRequest, generateSessionTitle } = await createJiti(import.meta.url).import("./session-title.ts");
function source(streamFunction, getApiKey) {
  return { agent: {
    state: { model: { id: "test", provider: "test", reasoning: false }, messages: [{ role: "user", content: "Fix login", timestamp: 1 }] },
    streamFunction, getApiKey,
  } };
}

test("automatic naming supplies the existing title and asks for stable wording", () => {
  const request = buildTitleRequest(source().agent, "User: Fix login", "Fix login redirects");
  assert.match(request.context.messages[0].content[0].text, /Current title: "Fix login redirects"/);
  assert.match(request.context.messages[0].content[0].text, /Keep it verbatim unless/);
  assert.equal(request.context.tools, undefined);
});

test("a pre-aborted title request never authenticates or calls the provider", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  await assert.rejects(generateSessionTitle(source(() => { called = true; }, () => { called = true; }), { signal: controller.signal }), { name: "AbortError" });
  assert.equal(called, false);
});

test("cancellation while auth is pending settles promptly and never submits after late auth", async () => {
  const auth = Promise.withResolvers();
  const controller = new AbortController();
  let called = false;
  const request = generateSessionTitle(source(() => { called = true; }, () => auth.promise), { signal: controller.signal });
  controller.abort();
  await assert.rejects(request, { name: "AbortError" });
  auth.resolve("test-only");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(called, false);
});

test("cancellation settles even when the provider ignores the abort signal", async () => {
  const started = Promise.withResolvers();
  const controller = new AbortController();
  const request = generateSessionTitle(source(() => { started.resolve(); return new Promise(() => {}); }), { signal: controller.signal });
  await started.promise;
  controller.abort();
  await assert.rejects(request, { name: "AbortError" });
});

test("the automatic deadline bounds an uncooperative stream", async () => {
  await assert.rejects(generateSessionTitle(source(() => ({ result: () => new Promise(() => {}) })), { timeoutMs: 10 }), /timed out/);
});

test("truncated title output is rejected rather than persisted", async () => {
  await assert.rejects(generateSessionTitle(source(() => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      stream.push({ type: "done", reason: "length", message: { role: "assistant", content: [{ type: "text", text: "Truncated title" }], stopReason: "length" } });
    });
    return stream;
  })), /did not complete normally/);
});
