import assert from "node:assert/strict";
import test from "node:test";
import { focusPickerOption, getSelectedPickerOption, movePickerFocus } from "./picker-keyboard.ts";

function fixture(selected = -1) {
  const document = { activeElement: null };
  const options = ["provider-a/second", "provider-a/third", "provider-b/first"].map((id, index) => ({
    id, scrolled: false,
    getAttribute: () => index === selected ? "true" : "false",
    focus() { document.activeElement = this; },
    scrollIntoView() { this.scrolled = true; },
  }));
  return { options, document, root: { querySelectorAll: () => options, ownerDocument: document } };
}

test("picker navigation follows rendered order and wraps in both directions", () => {
  const { options, document, root } = fixture(0);
  assert.equal(movePickerFocus(root, "ArrowDown"), true);
  assert.equal(document.activeElement, options[1]);
  movePickerFocus(root, "ArrowUp");
  assert.equal(document.activeElement, options[0]);
  movePickerFocus(root, "ArrowUp");
  assert.equal(document.activeElement, options[2]);
  movePickerFocus(root, "ArrowDown");
  assert.equal(document.activeElement, options[0]);
  assert.ok(options.every(option => option.scrolled));
});

test("Home and End focus boundaries without changing the selected value", () => {
  const { options, document, root } = fixture(1);
  movePickerFocus(root, "End");
  assert.equal(document.activeElement, options[2]);
  movePickerFocus(root, "Home");
  assert.equal(document.activeElement, options[0]);
  assert.equal(getSelectedPickerOption(root), options[1]);
});

test("filtered lists without a selected row start at the nearest boundary", () => {
  const { options, document, root } = fixture();
  movePickerFocus(root, "ArrowDown");
  assert.equal(document.activeElement, options[0]);
  document.activeElement = null;
  movePickerFocus(root, "ArrowUp");
  assert.equal(document.activeElement, options[2]);
  assert.equal(getSelectedPickerOption(root), options[0]);
});

test("empty and closed lists consume only navigation keys safely", () => {
  assert.equal(movePickerFocus(null, "ArrowDown"), true);
  assert.equal(movePickerFocus(null, "Enter"), false);
  assert.equal(movePickerFocus(null, "a"), false);
  assert.equal(getSelectedPickerOption(null), undefined);
  focusPickerOption(undefined);
});
