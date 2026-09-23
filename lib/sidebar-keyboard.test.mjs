import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { sidebarKeyboardAction: action, sidebarRowKey } = await jiti.import("./sidebar-keyboard.ts");
const project = (key, collapsed = false) => ({ kind: "project", project: { key, root: `/${key}` }, collapsed });
const session = (id) => ({ kind: "session", family: { root: { id }, subagents: [] } });
const more = (expanded) => ({ kind: "more", project: { key: "one", root: "/one" }, expanded, remaining: 20 });
const rows = [project("one"), session("a"), session("b"), more(false), project("two", true)];

test("navigation crosses project/session/more rows and clamps at boundaries", () => {
  assert.deepEqual(action(rows, 0, "ArrowUp"), { kind: "focus", index: 0 });
  assert.deepEqual(action(rows, 4, "ArrowDown"), { kind: "focus", index: 4 });
  assert.deepEqual(action(rows, 2, "ArrowDown"), { kind: "focus", index: 3 });
  assert.deepEqual(action(rows, 4, "ArrowUp"), { kind: "focus", index: 3 });
  assert.deepEqual(action(rows, -1, "ArrowDown"), { kind: "focus", index: 0 });
  assert.deepEqual(action(rows, 3, "Home"), { kind: "focus", index: 0 });
  assert.deepEqual(action(rows, 0, "End"), { kind: "focus", index: 4 });
});

test("navigation is independent of the mounted virtualization window", () => {
  const many = Array.from({ length: 2000 }, (_, index) => session(`s${index}`));
  assert.deepEqual(action(many, 0, "End"), { kind: "focus", index: 1999 });
  assert.deepEqual(action(many, 1999, "Home"), { kind: "focus", index: 0 });
  assert.deepEqual(action(many, 99, "ArrowDown"), { kind: "focus", index: 100 });
});

test("left/right collapse and expand projects and navigate their children", () => {
  assert.deepEqual(action(rows, 0, "ArrowLeft"), { kind: "expand", expanded: false });
  assert.deepEqual(action(rows, 4, "ArrowRight"), { kind: "expand", expanded: true });
  assert.deepEqual(action(rows, 0, "ArrowRight"), { kind: "focus", index: 1 });
  assert.deepEqual(action(rows, 2, "ArrowLeft"), { kind: "focus", index: 0 });
  assert.deepEqual(action(rows, 4, "ArrowLeft"), { kind: "none" });
  assert.deepEqual(action([project("empty"), project("next")], 0, "ArrowRight"), { kind: "none" });
});

test("more controls expand/collapse without introducing a hidden subagent tree", () => {
  assert.deepEqual(action(rows, 3, "ArrowRight"), { kind: "expand", expanded: true });
  assert.deepEqual(action([project("one"), session("a"), more(true)], 2, "ArrowLeft"), { kind: "expand", expanded: false });
  assert.deepEqual(action(rows, 1, "ArrowRight"), { kind: "none" });
  assert.deepEqual(action([session("a")], 0, "ArrowLeft"), { kind: "none" });
});

test("Enter activates every primary row, while unrelated keys do nothing", () => {
  rows.forEach((_, index) => assert.deepEqual(action(rows, index, "Enter"), { kind: "activate" }));
  assert.deepEqual(action(rows, 1, "Delete"), { kind: "none" }, "deletion belongs to the session confirmation UI");
  for (const key of ["Home", "End", "ArrowUp", "ArrowDown", "Enter"]) assert.deepEqual(action([], -1, key), { kind: "none" });
});

test("stable row identities distinguish project, preview control and session", () => {
  assert.deepEqual(rows.map(sidebarRowKey), ["project:one", "session:a", "session:b", "more:one", "project:two"]);
});
