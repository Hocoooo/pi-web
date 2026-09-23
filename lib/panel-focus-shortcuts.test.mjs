import assert from "node:assert/strict";
import test from "node:test";
import { getSessionPanelShortcut } from "./panel-focus-shortcuts.ts";

const altArrow = { key: "ArrowLeft", altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, isComposing: false };

test("Alt arrows target sidebar and composer", () => {
  assert.equal(getSessionPanelShortcut(altArrow), "sidebar");
  assert.equal(getSessionPanelShortcut({ ...altArrow, key: "ArrowRight" }), "chat");
});

test("ordinary arrows, other modifiers, and composition are not panel shortcuts", () => {
  for (const override of [
    { altKey: false }, { ctrlKey: true }, { metaKey: true },
    { shiftKey: true }, { isComposing: true }, { key: "ArrowUp" },
  ]) assert.equal(getSessionPanelShortcut({ ...altArrow, ...override }), null);
});
