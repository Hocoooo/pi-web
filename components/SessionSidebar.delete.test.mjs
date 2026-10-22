import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
function callback(name, next) {
  const start = source.indexOf(`  const ${name} = useCallback`);
  assert.notEqual(start, -1, `${name} exists`);
  return source.slice(start, source.indexOf(`  const ${next}`, start));
}
function harness(fetch) {
  const state = { catalog: { sessions: [{ id: "root" }, { id: "child" }, { id: "other" }], sessionListVersion: 1 }, deleted: [], refreshes: 0, failure: null, deleting: new Set() };
  const refs = { sessionLoadIdRef: { current: 3 }, sessionListVersionRef: { current: 1 }, detailsHydrationTimerRef: { current: null }, deleteRequestsRef: { current: new Set() } };
  const context = vm.createContext({ ...refs, fetch, clearTimeout, useCallback: fn => fn,
    setCatalogSnapshot: fn => { state.catalog = fn(state.catalog); },
    setDeletingSessionIds: fn => { state.deleting = fn(state.deleting); },
    setDeleteFailure: value => { state.failure = value; },
    onSessionDeleted: ids => state.deleted.push([...ids]),
    loadSessions: () => { state.refreshes++; return new Promise(() => {}); },
    t: key => key,
  });
  vm.runInContext(stripTypeScriptTypes(`${callback("deleteSession", "changeSessionArchive")}globalThis.remove = deleteSession;`), context);
  return { state, refs, remove: () => context.remove({ id: "root" }) };
}
const response = (body, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => body });

test("confirmed deletion removes actual IDs immediately without waiting for a slow refresh", async () => {
  const h = harness(async () => response({ ok: true, deletedSessionIds: ["root", "child"], sessionListVersion: 7 }));
  await h.remove();
  assert.deepEqual(h.state.catalog.sessions.map(s => s.id), ["other"]);
  assert.deepEqual(h.state.deleted, [["root", "child"]]);
  assert.equal(h.state.refreshes, 1);
  assert.ok(h.refs.sessionLoadIdRef.current > 3, "old list responses invalidated");
  assert.equal(h.refs.sessionListVersionRef.current, 7, "poll acknowledges deletion version");
  assert.equal(h.state.catalog.sessionListVersion, 1, "unchanged metadata retains its own version");
});

for (const [label, fetch] of [
  ["HTTP 500", async () => response({ error: "disk failure" }, false)],
  ["unconfirmed 2xx", async () => response({ ok: true })],
  ["wrong IDs", async () => response({ ok: true, deletedSessionIds: ["child"], sessionListVersion: 7 })],
  ["invalid version", async () => response({ ok: true, deletedSessionIds: ["root"], sessionListVersion: "7" })],
  ["null payload", async () => response(null)],
  ["network error", async () => { throw new Error("offline"); }],
]) test(`${label} keeps rows and navigation, restores retry controls`, async () => {
  const h = harness(fetch);
  await h.remove();
  assert.deepEqual(h.state.catalog.sessions.map(s => s.id), ["root", "child", "other"]);
  assert.deepEqual(h.state.deleted, []);
  assert.equal(h.state.refreshes, 0);
  assert.ok(h.state.failure);
  assert.equal(h.state.failure.session.id, "root");
  assert.equal(h.state.deleting.size, 0);
  assert.equal(h.refs.deleteRequestsRef.current.size, 0);
  await h.remove();
  assert.equal(h.state.deleting.size, 0, "explicit retry is available");
});

test("partial failure refreshes once but never reports successful root deletion", async () => {
  const h = harness(async () => response({ error: "root failed", deletedSessionIds: ["child"], sessionListVersion: 7 }, false));
  await h.remove();
  assert.deepEqual(h.state.deleted, []);
  assert.equal(h.state.refreshes, 1);
  assert.ok(h.state.failure);
});

test("duplicate clicks share one pending deletion", async () => {
  let finish;
  let requests = 0;
  const h = harness(() => { requests++; return new Promise(resolve => { finish = resolve; }); });
  const pending = h.remove();
  await h.remove();
  assert.equal(requests, 1);
  finish(response({ ok: true, deletedSessionIds: ["root"], sessionListVersion: 2 }));
  await pending;
  assert.equal(h.state.refreshes, 1);
});

test("the original context menu stays copy/archive only", () => {
  const menu = source.slice(source.indexOf("interface SessionContextMenuState"), source.indexOf("declare global"));
  assert.doesNotMatch(menu, /requestDelete|sidebar\.delete|deleting/);
  assert.match(menu, /session\.copyId/);
  assert.match(menu, /sidebar\.archiveSession/);
});

test("polling does not supersede a pending list refresh or apply a pre-delete version", () => {
  assert.match(source, /listRequestPendingRef\.current === null/);
  assert.match(source, /pollLoadId === sessionLoadIdRef\.current/);
});
