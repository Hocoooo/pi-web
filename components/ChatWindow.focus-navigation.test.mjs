import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import ts from "typescript";

function loadSource(name) {
  return ts.createSourceFile(name, readFileSync(new URL(name, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function findNode(root, predicate) {
  if (predicate(root)) return root;
  return ts.forEachChild(root, (node) => findNode(node, predicate));
}

function attribute(node, name) {
  return node.attributes.properties.find((prop) => prop.name?.text === name)?.initializer;
}

function runArrow(source, arrow, context) {
  return new Script(ts.transpileModule(arrow.getText(source), {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText).runInNewContext(context);
}

const inputSource = loadSource("ChatInput.tsx");
const inputHandler = findNode(inputSource, (node) => ts.isVariableDeclaration(node) && node.name.getText(inputSource) === "handleKeyDown").initializer.arguments[0];
const chatSource = loadSource("ChatWindow.tsx");
const inputElement = findNode(chatSource, (node) => ts.isJsxSelfClosingElement(node) && node.tagName.getText(chatSource) === "ChatInput" && attribute(node, "ref")?.getText(chatSource) === "{composerRef}");
const region = findNode(chatSource, (node) => ts.isJsxOpeningElement(node) && attribute(node, "ref")?.getText(chatSource) === "{scrollContainerRef}");

test("Alt+ArrowUp enters the messages only when no composer completion or IME is active", () => {
  const cases = [
    ["plain Alt+ArrowUp", {}, {}, true],
    ["history menu", { historyMenuOpen: true }, {}, false],
    ["slash menu", { slashMenuOpen: true, slashQuery: "help" }, {}, false],
    ["file menu", { atMenuOpen: true, atQuery: {} }, {}, false],
    ["IME composition", { isComposingRef: { current: true } }, {}, false],
    ["native IME", {}, { nativeEvent: { isComposing: true, keyCode: 229 } }, false],
    ["slash menu during IME", { slashMenuOpen: true, slashQuery: "help", isComposingRef: { current: true } }, {}, false],
    ["ArrowUp without Alt", {}, { altKey: false }, false],
    ["Alt+Shift+ArrowUp", {}, { shiftKey: true }, false],
    ["Ctrl+Alt+ArrowUp", {}, { ctrlKey: true }, false],
    ["plain Tab stays in the composer", {}, { key: "Tab", altKey: false }, false],
    ["no message region", { onFocusMessages: () => false }, {}, false],
    ["compact composer", { onFocusMessages: undefined }, {}, false],
  ];
  for (const [name, state, keys, expected] of cases) {
    let focused = false;
    let prevented = false;
    const handler = runArrow(inputSource, inputHandler, {
      Date, COMPOSITION_END_ENTER_GRACE_MS: 100,
      isMobile: false, enterSendMode: "enter", isStreaming: false, compact: false, nextCue: null, attachedImages: [],
      isComposingRef: { current: false }, lastCompositionEndAtRef: { current: 0 },
      historyMenuOpen: false, inputHistory: ["previous"], historyActiveIndex: 0,
      slashMenuOpen: false, slashQuery: null, displayedSlashCommands: [{}], slashActiveIndex: 0,
      atMenuOpen: false, atQuery: null, atMatches: [{}], atActiveIndex: 0,
      draftCompletion: { suffix: "", dismiss() {} },
      value: "hello", onFocusMessages: () => { focused = true; return true; },
      applyHistoryInput() {}, applySlashCommand() {}, applyAtCompletion() {},
      ...state,
    });
    handler({
      key: "ArrowUp", shiftKey: false, altKey: true, ctrlKey: false, metaKey: false,
      nativeEvent: { isComposing: false, keyCode: 38 },
      preventDefault() { prevented = true; },
      ...keys,
    });
    assert.equal(focused, expected, `${name}: focus`);
    assert.equal(prevented, expected, `${name}: default`);
  }
});

test("the message region is focusable without jumping the scroll position", () => {
  assert.equal(attribute(region, "role")?.getText(chatSource), '"region"');
  assert.equal(attribute(region, "tabIndex")?.getText(chatSource), "{0}");
  assert.match(attribute(region, "aria-label")?.getText(chatSource) ?? "", /chat\.messageArea/);
  assert.match(readFileSync(new URL("../app/globals.css", import.meta.url), "utf8"), /\.chat-message-region:focus-visible\s*\{[^}]*outline:/);

  const focusCallback = runArrow(chatSource, attribute(inputElement, "onFocusMessages").expression, {
    scrollContainerRef: { current: { focus(options) { assert.equal(options.preventScroll, true); } } },
    pendingScrollRestore: null, extensionDialog: null, extensionCustomUi: null,
  });
  assert.equal(focusCallback(), true);
  for (const blocked of [
    { scrollContainerRef: { current: null } },
    { pendingScrollRestore: {} },
    { extensionDialog: {} },
    { extensionCustomUi: {} },
  ]) {
    const callback = runArrow(chatSource, attribute(inputElement, "onFocusMessages").expression, {
      scrollContainerRef: { current: { focus() { throw Error("must not focus"); } } },
      pendingScrollRestore: null, extensionDialog: null, extensionCustomUi: null,
      ...blocked,
    });
    assert.equal(callback(), false);
  }
});

test("Alt+ArrowDown from the region returns to the composer, without trapping child controls", () => {
  const regionKeyDown = attribute(region, "onKeyDown").expression;
  for (const [name, targetIsRegion, keys, expected] of [
    ["return to composer", true, {}, true],
    ["ArrowDown without Alt stays in the region", true, { altKey: false }, false],
    ["Alt+Shift+ArrowDown stays in the region", true, { shiftKey: true }, false],
    ["Tab uses native order", true, { key: "Tab", altKey: false }, false],
    ["child control Alt+ArrowDown uses native order", false, {}, false],
  ]) {
    let focused = false;
    let prevented = false;
    const handler = runArrow(chatSource, regionKeyDown, {
      composerRef: { current: { focusComposer() { focused = true; } } },
    });
    const currentTarget = {};
    handler({
      key: "ArrowDown", shiftKey: false, ctrlKey: false, altKey: true, metaKey: false,
      target: targetIsRegion ? currentTarget : {}, currentTarget,
      nativeEvent: { isComposing: false },
      preventDefault() { prevented = true; },
      ...keys,
    });
    assert.equal(focused, expected, `${name}: focus`);
    assert.equal(prevented, expected, `${name}: default`);
  }
});
