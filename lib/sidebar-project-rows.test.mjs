import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildSidebarProjectRows } = await jiti.import("./sidebar-project-rows.ts");
const session = (id, projectKey, modified, extra = {}) => ({
  id, projectKey, projectRoot: `/projects/${projectKey}`, cwd: `/projects/${projectKey}`,
  modified, ...extra,
});
const a = session("a", "one", "2026-01-01");
const b = session("b", "two", "2026-01-02");
const ids = (rows) => rows.map((row) => row.kind === "session" ? row.family.root.id : `${row.kind}:${row.project.key}`);

test("all projects appear in activity order and expand independently", () => {
  assert.deepEqual(ids(buildSidebarProjectRows([a, b], [], null)), ["project:two", "b", "project:one", "a"]);
  assert.deepEqual(ids(buildSidebarProjectRows([a, b], ["two"], null)), ["project:two", "project:one", "a"]);
  assert.deepEqual(ids(buildSidebarProjectRows([a, b], ["one", "two"], null)), ["project:two", "project:one"]);
});

test("worktrees share a project while subagents stay in their parent's family", () => {
  const wt = session("wt", "one", "2026-01-03", { cwd: "/worktrees/feature" });
  const child = session("child", "one", "2026-01-04", { relation: { kind: "subagent", parentSessionId: "a" } });
  const rows = buildSidebarProjectRows([a, b, wt, child], [], null);
  assert.deepEqual(ids(rows), ["project:one", "a", "wt", "project:two", "b"]);
  assert.equal(rows[1].family.subagents[0].id, "child");
  assert.equal(rows[1].family.latestModified, child.modified);
});

test("includes the active empty project without duplicating existing projects", () => {
  assert.deepEqual(ids(buildSidebarProjectRows([a], [], { key: "empty", root: "/empty" })), ["project:empty", "project:one", "a"]);
  assert.deepEqual(ids(buildSidebarProjectRows([a], [], { key: "one", root: a.projectRoot })), ["project:one", "a"]);
  assert.deepEqual(buildSidebarProjectRows([], [], null), []);
});

test("deleted projects and stale collapsed keys leave no phantom rows", () => {
  assert.deepEqual(ids(buildSidebarProjectRows([a], ["two"], null)), ["project:one", "a"]);
  assert.deepEqual(buildSidebarProjectRows([], ["one"], null), []);
});

test("preview boundaries: 0 through 5 families show fully without a more button; 6+ show five", () => {
  for (const count of [0, 1, 4, 5, 6, 20]) {
    const sessions = Array.from({ length: count }, (_, i) => session(`a${i}`, "one", `2026-01-${String(i + 1).padStart(2, "0")}`));
    const rows = buildSidebarProjectRows(sessions, [], null);
    assert.equal(rows.filter((row) => row.kind === "session").length, Math.min(count, 5));
    const more = rows.find((row) => row.kind === "more");
    assert.equal(Boolean(more), count > 5);
    if (more) {
      assert.equal(more.remaining, count - 5);
      assert.equal(more.expanded, false);
      assert.equal(rows[1].family.root.id, `a${count - 1}`, "most recent family appears first");
    }
  }
});

test("show more is independent per project, reversible, and hidden under collapsed projects", () => {
  const sessions = ["one", "two"].flatMap((key) => Array.from({ length: 8 }, (_, i) => session(`${key}${i}`, key, `2026-01-0${i + 1}`)));
  const expanded = buildSidebarProjectRows(sessions, [], null, ["one"]);
  assert.equal(expanded.filter((row) => row.kind === "session" && row.family.root.projectKey === "one").length, 8);
  assert.equal(expanded.filter((row) => row.kind === "session" && row.family.root.projectKey === "two").length, 5);
  assert.equal(expanded.find((row) => row.kind === "more" && row.project.key === "one").expanded, true);
  assert.equal(buildSidebarProjectRows(sessions, [], null, []).filter((row) => row.kind === "session").length, 10);
  assert.deepEqual(ids(buildSidebarProjectRows(sessions, ["one", "two"], null, ["one"])), ["project:one", "project:two"]);
});

test("preview counts families, not subagents, and drops the more row after deletion", () => {
  const roots = Array.from({ length: 5 }, (_, i) => session(`root${i}`, "one", "2026-01-01"));
  const children = Array.from({ length: 8 }, (_, i) => session(`child${i}`, "one", "2026-01-02", { relation: { kind: "subagent", parentSessionId: "root0" } }));
  const beforeDeletion = buildSidebarProjectRows([...roots, ...children, session("deleted", "one", "2026-01-03")], [], null, ["one"]);
  assert.equal(beforeDeletion.some((row) => row.kind === "more"), true);
  const rows = buildSidebarProjectRows([...roots, ...children], [], null, ["one"]);
  assert.equal(rows.filter((row) => row.kind === "session").length, 5);
  assert.equal(rows.some((row) => row.kind === "more"), false);
  assert.equal(rows[1].family.subagents.length, 8);
});

test("project identity, not a shared directory basename, separates groups", () => {
  const other = session("other", "other", "2026-01-02", { projectRoot: "/elsewhere/one" });
  assert.equal(buildSidebarProjectRows([a, other], [], null).filter((row) => row.kind === "project").length, 2);
});
