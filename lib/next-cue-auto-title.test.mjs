import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { generateNextCue } = await jiti.import("./next-cue.ts");
const { AUTO_TITLE_TYPE, isTitleOnlyLeafChange } = await jiti.import("./auto-session-title.ts");
const conversation = () => [
  { type: "message", id: "user", message: { role: "user", content: "Fix it" } },
  { type: "message", id: "reply", message: { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop" } },
];
const titleEntries = () => [
  { type: "session_info", id: "name", name: "Fix the feature" },
  { type: "custom", id: "policy", customType: AUTO_TITLE_TYPE, data: { version: 1 } },
];
function source(branch, complete = () => {}) {
  return { model: { id: "test", provider: "test" }, isIdle: true, sessionManager: { getBranch: () => branch },
    modelRuntime: { completeSimple: async () => {
      complete();
      return { stopReason: "stop", content: [{ type: "text", text: "Run the tests" }] };
    } },
  };
}

test("a title written before a cue starts still matches the client's original leaf", async () => {
  const branch = [...conversation(), ...titleEntries()];
  assert.deepEqual(await generateNextCue(source(branch), undefined, null, "reply"), { text: "Run the tests", leafId: "reply" });
});

test("a title written during a cue does not discard it or cause a second model request", async () => {
  const branch = conversation();
  let calls = 0;
  const session = source(branch, () => { calls++; branch.push(...titleEntries()); });
  assert.deepEqual(await generateNextCue(session), { text: "Run the tests", leafId: "reply" });
  assert.equal(calls, 1);
});

test("only title metadata is exempt; messages, compaction, model changes and branch switches still invalidate cues", async () => {
  for (const extra of [
    { type: "message", id: "new", message: { role: "user", content: "Another task" } },
    { type: "compaction", id: "compact" },
    { type: "custom", id: "other", customType: "unrelated" },
    { type: "model_change", id: "model" },
  ]) {
    const branch = conversation();
    const session = source(branch, () => branch.push(extra));
    assert.equal(await generateNextCue(session), null);
    assert.equal(isTitleOnlyLeafChange(branch, "reply"), false);
  }
  let called = false;
  assert.equal(await generateNextCue(source(conversation(), () => { called = true; }), undefined, null, "other-branch"), null);
  assert.equal(called, false);
});
