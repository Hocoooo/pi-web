import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { mergeCatalogRow, protectCatalogTitle } = await jiti.import("./session-catalog-helpers.ts");

function row(overrides = {}) {
  return {
    path: "/s.jsonl", id: "s1", cwd: "/p", created: "2026-01-01", modified: "2026-01-02",
    messageCount: 0, firstMessage: "", transient: false, ...overrides,
  };
}

test("a hydrated row clears the pending marker the first paint set", () => {
  // The catalogue omits detailsPending once details arrive, so a plain spread
  // would leave the selected session marked pending forever.
  const pending = row({ detailsPending: true, messageCount: 0, firstMessage: "" });
  const hydrated = row({ messageCount: 12, firstMessage: "real first message" });
  const merged = mergeCatalogRow(pending, hydrated);
  assert.equal(merged.detailsPending, undefined);
  assert.equal(merged.messageCount, 12);
  assert.equal(merged.firstMessage, "real first message");
});

test("dropped optional keys are cleared, not inherited", () => {
  const current = row({
    relation: { kind: "fork" },
    branch: "feature/x",
    isWorktree: true,
  });
  const merged = mergeCatalogRow(current, row());
  assert.equal(merged.relation, undefined);
  assert.equal(merged.branch, undefined);
  assert.equal(merged.isWorktree, undefined);
});

test("a locally applied title survives until the catalogue carries it", () => {
  // AppShell writes an auto-generated name onto the selected session before the
  // next listing has picked it up off disk.
  const named = row({ name: "auto-generated title" });
  const merged = mergeCatalogRow(named, row());
  assert.equal(merged.name, "auto-generated title");
  // ...and the catalogue wins once it does carry one.
  assert.equal(mergeCatalogRow(named, row({ name: "renamed on disk" })).name, "renamed on disk");
});

test("a delayed catalogue or hydration response cannot roll back a newer title event", () => {
  const current = row({ name: "New generated title", autoTitleEnabled: true, detailsPending: true });
  const event = { name: "New generated title", autoTitleEnabled: true, sessionListVersion: 20 };
  const stale = row({ name: "Older generated title", autoTitleEnabled: false, modified: "2026-02-01", messageCount: 12 });
  const merged = mergeCatalogRow(current, protectCatalogTitle(stale, 19, event));
  assert.equal(merged.name, "New generated title");
  assert.equal(merged.autoTitleEnabled, true);
  assert.equal(merged.modified, "2026-02-01");
  assert.equal(merged.messageCount, 12);
  assert.equal(merged.detailsPending, undefined, "unrelated hydration must still apply");
  assert.equal(protectCatalogTitle(stale, undefined, event).name, "New generated title");
  assert.equal(protectCatalogTitle(stale, 21, event).name, "Older generated title", "genuinely newer server metadata remains authoritative");
  assert.equal(protectCatalogTitle(stale, 19).name, "Older generated title", "legacy selection has no local pin");
});

test("values the catalogue does carry always win", () => {
  const merged = mergeCatalogRow(row({ modified: "2026-01-02", messageCount: 1 }), row({ modified: "2026-06-01", messageCount: 99, relation: { kind: "subagent", parentSessionId: "p1" } }));
  assert.equal(merged.modified, "2026-06-01");
  assert.equal(merged.messageCount, 99);
  assert.deepEqual(merged.relation, { kind: "subagent", parentSessionId: "p1" });
});
