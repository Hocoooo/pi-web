import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const prefs = await jiti.import("./sidebar-view-preference.ts");

test("missing, corrupt, or unknown preferences keep the original current-project default", () => {
  for (const raw of [null, "broken", "null", "3", '{}', '{"mode":"future"}']) {
    assert.equal(prefs.parseSidebarViewPreference(raw).mode, "current");
  }
  assert.deepEqual(prefs.parseSidebarViewPreference('{"mode":"all","collapsedProjects":["a",42,"a",null,"b"]}'), {
    mode: "all", collapsedProjects: ["a", "b"],
  });
  assert.deepEqual(prefs.getSidebarViewPreference(), prefs.DEFAULT_SIDEBAR_VIEW);
});

test("mode and independent collapse preferences persist, notify, and sync across tabs", () => {
  const values = new Map();
  const handlers = new Map();
  globalThis.window = {
    localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    addEventListener: (name, handler) => handlers.set(name, handler),
    removeEventListener: (name) => handlers.delete(name),
  };
  let updates = 0;
  const unsubscribe = prefs.subscribeSidebarView(() => updates++);
  try {
    assert.equal(prefs.getSidebarViewPreference().mode, "current");
    prefs.setSidebarViewMode("all");
    prefs.setSidebarProjectCollapsed("a", true);
    prefs.setSidebarProjectCollapsed("b", true);
    prefs.setSidebarProjectCollapsed("a", false);
    prefs.setSidebarViewMode("current");
    assert.deepEqual(JSON.parse(values.get(prefs.SIDEBAR_VIEW_STORAGE_KEY)), { mode: "current", collapsedProjects: ["b"] });
    assert.equal(updates, 5);
    prefs.setSidebarProjectCollapsed("a", false);
    assert.equal(updates, 5, "no-op expansion does not trigger updates");
    assert.strictEqual(prefs.getSidebarViewPreference(), prefs.getSidebarViewPreference(), "snapshot identity stays stable");
    values.set(prefs.SIDEBAR_VIEW_STORAGE_KEY, '{"mode":"all","collapsedProjects":["remote"]}');
    handlers.get("storage")({ key: prefs.SIDEBAR_VIEW_STORAGE_KEY });
    assert.deepEqual(prefs.getSidebarViewPreference(), { mode: "all", collapsedProjects: ["remote"] });
    values.clear();
    handlers.get("storage")({ key: null });
    assert.equal(prefs.getSidebarViewPreference().mode, "current");
    window.localStorage.setItem = () => { throw new Error("blocked"); };
    prefs.setSidebarViewMode("all");
    assert.equal(prefs.getSidebarViewPreference().mode, "all", "blocked storage still allows live changes");
  } finally {
    unsubscribe();
    assert.equal(handlers.size, 0);
    delete globalThis.window;
  }
});
