import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  NEXT_CUE_STORAGE_KEY, parseNextCuePreference, getNextCuePreference,
  setNextCueEnabled, setNextCueModel, subscribeNextCuePreference,
} = await createJiti(import.meta.url).import("./next-cue-preference.ts");

test("defaults to enabled and the current chat model, but fails closed on corrupted settings", () => {
  assert.deepEqual(parseNextCuePreference(null), { enabled: true, model: null });
  assert.deepEqual(parseNextCuePreference("bad json"), { enabled: false, model: null });
  assert.deepEqual(parseNextCuePreference(JSON.stringify({ enabled: true, model: { provider: "x" } })), { enabled: false, model: null });
  assert.deepEqual(parseNextCuePreference(JSON.stringify({ enabled: false, model: { provider: "x", modelId: "y" } })), {
    enabled: false, model: { provider: "x", modelId: "y" },
  });
});

test("settings apply in the same tab and react to a change in another tab", () => {
  const previousWindow = globalThis.window;
  const storage = new Map();
  const events = new Map();
  globalThis.window = {
    localStorage: {
      getItem(key) { return storage.get(key) ?? null; },
      setItem(key, value) { storage.set(key, value); },
    },
    addEventListener(key, fn) { events.set(key, fn); },
    removeEventListener(key) { events.delete(key); },
  };
  let notifications = 0;
  const unsubscribe = subscribeNextCuePreference(() => { notifications++; });
  try {
    assert.equal(getNextCuePreference().enabled, true);
    setNextCueModel({ provider: "test", modelId: "quick" });
    setNextCueEnabled(false);
    assert.deepEqual(getNextCuePreference(), { enabled: false, model: { provider: "test", modelId: "quick" } });
    assert.equal(notifications, 2);
    assert.equal(JSON.parse(storage.get(NEXT_CUE_STORAGE_KEY)).enabled, false);
    storage.set(NEXT_CUE_STORAGE_KEY, JSON.stringify({ enabled: true, model: null }));
    events.get("storage")({ key: NEXT_CUE_STORAGE_KEY });
    assert.deepEqual(getNextCuePreference(), { enabled: true, model: null });
    assert.equal(notifications, 3);
  } finally {
    unsubscribe();
    globalThis.window = previousWindow;
  }
});
