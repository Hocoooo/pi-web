import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { withSessionArchiveState, sessionsInArchiveScope } = await jiti.import("./session-archive-view.ts");
const { listSessionFamilies } = await jiti.import("./session-family.ts");
const { buildSidebarProjectRows } = await jiti.import("./sidebar-project-rows.ts");
const session = (id, relation, project = "p") => ({ id, path: `/fixture/${id}.jsonl`, cwd: `/${project}`, projectRoot: `/${project}`, projectKey: project, created: "2026-01-01", modified: "2026-01-01", messageCount: 1, firstMessage: id, ...(relation ? { relation } : {}) });
const subagent = parentSessionId => ({ kind: "subagent", parentSessionId, profile: "worker", description: "test", status: "completed" });

test("archive root hides its complete subagent family but not forks; restoration keeps every relation", () => {
  const raw = [session("root"), session("child", subagent("root")), session("nested", subagent("child")), session("fork", {kind:"fork", originSessionId:"root"}), session("other")];
  const archived = withSessionArchiveState(raw, new Set(["root"]));
  assert.deepEqual(sessionsInArchiveScope(archived, "active").map(s => s.id), ["fork", "other"]);
  assert.deepEqual(sessionsInArchiveScope(archived, "archived").map(s => s.id), ["root", "child", "nested"]);
  const families = listSessionFamilies(sessionsInArchiveScope(archived, "archived"));
  assert.equal(families.length, 1);
  assert.deepEqual(families[0].subagents.map(s => s.id), ["child", "nested"]);
  assert.ok(raw.every(s => !Object.hasOwn(s, "archived")), "cached metadata was not mutated");
  const restored = withSessionArchiveState(raw, new Set());
  assert.equal(sessionsInArchiveScope(restored, "active").length, raw.length);
  assert.equal(sessionsInArchiveScope(restored, "archived").length, 0);
  assert.deepEqual(restored.map(s => s.relation), raw.map(s => s.relation));
});

test("projects and five-family previews count only the chosen archive scope", () => {
  const raw = Array.from({length:7}, (_, i) => session(`r${i}`));
  raw.push(session("other-project", undefined, "q"));
  const catalog = withSessionArchiveState(raw, new Set(["r0", "r1", "other-project"]));
  const active = buildSidebarProjectRows(sessionsInArchiveScope(catalog, "active"), [], null);
  assert.equal(active.filter(r => r.kind === "session").length, 5);
  assert.equal(active.filter(r => r.kind === "more").length, 0);
  assert.deepEqual(active.filter(r => r.kind === "project").map(r => r.project.key), ["p"]);
  const archived = buildSidebarProjectRows(sessionsInArchiveScope(catalog, "archived"), [], null);
  assert.equal(archived.filter(r => r.kind === "session").length, 3);
  assert.equal(archived.filter(r => r.kind === "project").length, 2);
});

test("orphaned/cyclic subagents are not promoted; independent chats, transient and legacy records work", () => {
  const raw = [session("orphan", subagent("missing")), session("a", subagent("b")), session("b", subagent("a")), {...session("chat"), sessionKind:"chat"}, {...session("transient"), transient:true}];
  const catalog = withSessionArchiveState(raw, new Set(["missing", "chat"]));
  assert.equal(catalog[0].archived, true);
  assert.deepEqual(listSessionFamilies(sessionsInArchiveScope(catalog, "archived")).map(f => f.root.id), ["chat"]);
  assert.deepEqual(listSessionFamilies(sessionsInArchiveScope(catalog, "active")).map(f => f.root.id), ["transient"]);
  assert.equal(sessionsInArchiveScope([session("legacy")], "active").length, 1);
});
