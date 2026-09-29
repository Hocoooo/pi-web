import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const api = await createJiti(import.meta.url).import("./draft-completion-preference.ts");
const off = { enabled: false, model: null };

test("draft upload is opt-in, including invalid or absent settings", () => {
  for (const raw of [null, "broken", "null", "{}", '{"enabled":"true"}', '{"enabled":true,"model":{"provider":"x"}}']) {
    assert.deepEqual(api.parseDraftCompletionPreference(raw), off);
  }
  assert.deepEqual(api.parseDraftCompletionPreference('{"enabled":true,"model":null}'), { enabled: true, model: null });
  assert.deepEqual(api.parseDraftCompletionPreference('{"enabled":true,"model":{"provider":"p","modelId":"fast"}}'), {
    enabled: true, model: { provider: "p", modelId: "fast" },
  });
});

test("draft preference is independent from Next Cue and syncs only its own consent", () => {
  const original = globalThis.window;
  const storage = new Map([["pi-web:next-cue", '{"enabled":true,"model":null}']]);
  const events = new Map();
  globalThis.window = {
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    addEventListener: (key, fn) => events.set(key, fn), removeEventListener: (key) => events.delete(key),
  };
  let notified = 0;
  const unsubscribe = api.subscribeDraftCompletionPreference(() => notified++);
  try {
    assert.deepEqual(api.getDraftCompletionPreference(), off);
    api.setDraftCompletionModel({ provider: "p", modelId: "fast" });
    assert.equal(api.getDraftCompletionPreference().enabled, false, "choosing a model isn't consent");
    api.setDraftCompletionEnabled(true);
    assert.equal(notified, 2);
    events.get("storage")({ key: "pi-web:next-cue" });
    assert.equal(notified, 2);
    storage.set(api.DRAFT_COMPLETION_STORAGE_KEY, '{"enabled":false,"model":null}');
    events.get("storage")({ key: api.DRAFT_COMPLETION_STORAGE_KEY });
    assert.deepEqual(api.getDraftCompletionPreference(), off);
    storage.clear();
    events.get("storage")({ key: null });
    assert.deepEqual(api.getDraftCompletionPreference(), off);
    globalThis.window.localStorage.setItem = () => { throw new Error("blocked"); };
    api.setDraftCompletionEnabled(true);
    assert.equal(api.getDraftCompletionPreference().enabled, true, "explicit consent works in the current tab");
  } finally {
    unsubscribe();
    globalThis.window = original;
  }
});
