import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { THEME_INIT_SCRIPT, THEME_OPTIONS, isDarkTheme, isThemePreference } from "./theme.ts";

test("first paint restores every palette and falls back to the system for invalid or blocked storage", () => {
  for (const systemDark of [false, true]) {
    for (const stored of [...THEME_OPTIONS.map(({ id }) => id), null, "", "unknown", new Error("Blocked")]) {
      const root = { dataset: {}, classList: { toggle: (name, value) => { root[name] = value; } } };
      runInNewContext(THEME_INIT_SCRIPT, {
        localStorage: { getItem: () => { if (stored instanceof Error) throw stored; return stored; } },
        window: { matchMedia: () => ({ matches: systemDark }) },
        document: { documentElement: root },
      });
      const expected = isThemePreference(stored) && stored !== "auto" ? stored : systemDark ? "dark" : "light";
      assert.equal(root.dataset.theme, expected);
      assert.equal(root.dark, isDarkTheme(expected));
    }
  }
});

test("dev first-paint cleanup unregisters service workers without breaking theme restore", () => {
  const root = { dataset: {}, classList: { toggle: (name, value) => { root[name] = value; } } };
  const unregistered = [];
  runInNewContext(THEME_INIT_SCRIPT, {
    localStorage: { getItem: () => "dark" },
    window: { matchMedia: () => ({ matches: false }) },
    document: { documentElement: root },
    navigator: {
      serviceWorker: {
        getRegistrations: async () => [{ unregister: async () => unregistered.push("sw") }],
      },
    },
    caches: {
      keys: async () => ["pi-web-static-stale", "other"],
      delete: async (key) => unregistered.push(key),
    },
  });
  assert.equal(root.dataset.theme, "dark");
});
