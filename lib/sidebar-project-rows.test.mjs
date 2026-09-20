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
const ids = (rows) => rows.map((row) => row.kind === "project" ? `project:${row.project.key}` : row.family.root.id);

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

test("project identity, not a shared directory basename, separates groups", () => {
  const other = session("other", "other", "2026-01-02", { projectRoot: "/elsewhere/one" });
  assert.equal(buildSidebarProjectRows([a, other], [], null).filter((row) => row.kind === "project").length, 2);
});
