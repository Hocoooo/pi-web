import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { contextUpdateFixture, settle } from "./task-context-updates-fixture.mjs";

for (const mode of ["redact", "truncate", "late-auth-redact", "late-auth-truncate", "clone", "pass", "concat", "wrap", "split"]) {
  test(`R3 SDK conversion retains both selected identity and full material (${mode})`, async t => {
    const f = await contextUpdateFixture(t), version = await f.publish("LOCKED COMPLETE VERSION TWO"), choice = await f.accept(version);
    const originalConvert = f.w.inner.agent.convertToLlm, originalStream = f.w.inner.agent.streamFunction;
    const getApiKey = f.w.inner.agent.getApiKey;
    let sdkInput, selectedContent;
    const changed = mode.includes("redact") || mode.includes("truncate");
    const alter = content => { content[0].text = mode.includes("redact") ? "[REDACTED BY PUBLIC SDK CONVERTER]" : content[0].text.slice(0, 30); };
    const converter = async messages => {
      const converted = await originalConvert(messages);
      const selected = messages.find(m => m.role === "custom" && m.details?.operationId === choice.operationId);
      if (!selected) return converted;
      const contribution = converted.find(m => m.role === "user" && m.content === selected.content);
      assert.ok(contribution, "real SDK converter preserves this contribution's content array");
      selectedContent = contribution.content;
      if (mode === "redact" || mode === "truncate") alter(selectedContent);
      if (mode === "clone") return structuredClone(converted);
      if (mode === "concat") return [].concat(converted, [{ role: "user", content: [{ type: "text", text: "Other request-local reference" }], timestamp: Date.now() }]);
      if (mode === "wrap") selectedContent[0].text = "Reference begins:\n" + selectedContent[0].text + "\nReference ends.";
      if (mode === "split") {
        const text = selectedContent[0].text, cut = Math.floor(text.length / 2);
        selectedContent.splice(0, selectedContent.length, { type: "text", text: text.slice(0, cut) }, { type: "text", text: text.slice(cut) });
      }
      return converted;
    };
    f.w.inner.agent.convertToLlm = converter;
    // Agent-loop resolves auth after conversion and before calling streamFunction.
    // Mutation here tests that conversion-time completeness is not final evidence.
    if (mode.startsWith("late-auth")) f.w.inner.agent.getApiKey = async provider => {
      if (selectedContent) alter(selectedContent);
      return getApiKey?.(provider);
    };
    f.w.inner.agent.streamFunction = (model, context, options) => {
      sdkInput = structuredClone(context);
      return originalStream(model, context, options);
    };
    await f.send("Explicit Send after public SDK conversion"); await settle(f.w);
    const state = await f.state(), native = f.w.inner.sessionManager.getEntries().find(e => e.type === "custom_message" && e.details?.operationId === choice.operationId);
    assert.ok(native); assert.ok(native.content.includes(version)); assert.equal(typeof native.content, "string", "request-local mutation never changes SDK raw history");
    assert.equal(f.w.inner.agent.convertToLlm, converter); assert.equal(f.captures.length, 2);
    const inputText = input => input.messages.filter(m => m.role === "user").map(m => typeof m.content === "string" ? m.content : m.content.filter(c => c.type === "text").map(c => c.text).join("")).join("\n");
    const sdkText = inputText(sdkInput), providerText = inputText(f.captures.at(-1).context);
    if (changed) {
      assert.ok(!sdkText.includes(version)); assert.ok(!sdkText.includes(native.content));
      assert.ok(!providerText.includes(version)); assert.ok(!providerText.includes(native.content));
      assert.equal(state.state.deliveries.length, 0); assert.equal(state.state.pendingOperationId, choice.operationId);
      assert.equal(f.w.inner.sessionManager.getEntries().filter(e => e.customType === "pi-web:task-context-send" && e.data?.operationId === choice.operationId).length, 0);
      assert.ok(providerText.includes(mode.includes("redact") ? "[REDACTED BY PUBLIC SDK CONVERTER]" : native.content.slice(0, 30)), "model receives the converter's result, not secretly restored material");
      // A later explicit Send with the default converter may succeed on the same
      // native entry, without duplicating it or silently replacing the intent.
      f.w.inner.agent.getApiKey = getApiKey; f.w.inner.agent.convertToLlm = originalConvert;
      await f.send("Explicit retry after removing redaction"); await settle(f.w);
      const retried = await f.state(); assert.equal(retried.state.pendingOperationId, null);
      assert.equal(retried.state.deliveries.length, 1); assert.equal(retried.state.deliveries[0].entryId, native.id);
      assert.equal(f.w.inner.sessionManager.getEntries().filter(e => e.type === "custom_message" && e.details?.operationId === choice.operationId).length, 1);
    } else {
      assert.ok(sdkText.includes(native.content)); assert.ok(providerText.includes(native.content));
      assert.equal(state.state.deliveries.length, mode === "clone" ? 0 : 1);
      assert.equal(state.state.pendingOperationId, mode === "clone" ? choice.operationId : null);
      if (mode !== "clone") assert.equal(state.state.deliveries[0].entryId, native.id);
    }
    if (process.env.TASK_UPDATE_ARTIFACT_DIR) {
      await mkdir(process.env.TASK_UPDATE_ARTIFACT_DIR, { recursive: true });
      await writeFile(join(process.env.TASK_UPDATE_ARTIFACT_DIR, "conversion-" + mode + ".json"), JSON.stringify({ choice, native, sdkInput, captures: f.captures, state, after: await f.state() }, null, 2));
    }
  });
}
