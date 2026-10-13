import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { PATCH, GET } = await jiti.import("./route.ts");
const { AgentSessionWrapper, updateSessionTitle } = await jiti.import("@/lib/rpc-manager");
const { cacheSessionPath } = await jiti.import("@/lib/session-reader");
const { readSessionTitleState } = await jiti.import("@/lib/auto-session-title");
const params = (id) => ({ params: Promise.resolve({ id }) });
const patch = (id, body) => PATCH(new Request("http://localhost/api/sessions/test", {
  method: "PATCH", headers: { "Content-Type": "application/json" }, body,
}), params(id));

function fixture(t, live = false) {
  const directory = mkdtempSync(join(tmpdir(), "pi-web-title-route-"));
  const manager = SessionManager.create(directory, directory);
  manager.appendMessage({ role: "user", content: "Goal", timestamp: 1 });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop", timestamp: 2 });
  const id = manager.getSessionId();
  const file = manager.getSessionFile();
  cacheSessionPath(id, file);
  const previousRegistry = globalThis.__piSessions;
  const previousLocks = globalThis.__piStartLocks;
  globalThis.__piSessions = new Map();
  globalThis.__piStartLocks = new Map();
  const inner = { sessionId: id, sessionFile: file, sessionManager: manager, extensionRunner: {}, dispose() {} };
  const wrapper = new AgentSessionWrapper(inner);
  if (live) globalThis.__piSessions.set(id, wrapper);
  t.after(() => {
    wrapper.destroy();
    globalThis.__piSessions = previousRegistry;
    globalThis.__piStartLocks = previousLocks;
    rmSync(directory, { recursive: true, force: true });
  });
  return { id, file, manager, wrapper };
}

test("title PATCH rejects malformed and ambiguous input before session lookup", async () => {
  for (const body of ["not json", "null", "[]", "{}", '{"autoTitleEnabled":"true"}', '{"name":5}', '{"name":"Hi","autoTitleEnabled":true}']) {
    assert.equal((await patch("not-real", body)).status, 400);
  }
});

for (const live of [false, true]) {
  test(`manual rename and opt-in persist via ${live ? "the live manager" : "a fresh manager without waking a session"}`, async (t) => {
    const f = fixture(t, live);
    const events = [];
    f.wrapper.onEvent((event) => events.push(event));
    assert.equal((await patch(f.id, '{"name":"My title"}')).status, 200);
    const reopened = SessionManager.open(f.file);
    assert.equal(reopened.getSessionName(), "My title");
    assert.equal(readSessionTitleState(reopened.getEntries(), reopened.getSessionName()).enabled, false);
    assert.equal((await patch(f.id, '{"autoTitleEnabled":true}')).status, 200);
    const latest = SessionManager.open(f.file);
    assert.equal(readSessionTitleState(latest.getEntries(), latest.getSessionName()).enabled, true);
    assert.equal(globalThis.__piSessions.has(f.id), live);
    if (live) {
      assert.equal(f.manager.getSessionName(), "My title");
      assert.deepEqual(events.map((event) => [event.type, event.autoTitleEnabled]), [["session_title_updated", false], ["session_title_updated", true]]);
    }
    const response = await GET(new Request("http://localhost/api/sessions/test"), params(f.id));
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.info.name, "My title");
    assert.equal(data.info.autoTitleEnabled, true);
  });
}

test("a closing wrapper refuses title writes instead of using another manager", async (t) => {
  const f = fixture(t, true);
  const before = readFileSync(f.file, "utf8");
  f.wrapper.isAlive = () => false;
  const response = await patch(f.id, '{"name":"Must not write"}');
  assert.equal(response.status, 409, JSON.stringify(await response.json()));
  assert.equal(readFileSync(f.file, "utf8"), before);
});

test("a session deleted before the write cannot be recreated by an offline title update", async (t) => {
  const f = fixture(t);
  unlinkSync(f.file);
  await assert.rejects(updateSessionTitle(f.id, f.file, { name: "Must not recreate" }), { code: "STALE_SESSION_TITLE" });
  assert.equal(existsSync(f.file), false);
});

test("title writes wait for a starting wrapper and then use its authoritative manager", async (t) => {
  const f = fixture(t);
  const started = Promise.withResolvers();
  globalThis.__piStartLocks.set(f.id, started.promise);
  let settled = false;
  const write = updateSessionTitle(f.id, f.file, { name: "After startup" }).then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  globalThis.__piSessions.set(f.id, f.wrapper);
  globalThis.__piStartLocks.delete(f.id);
  started.resolve({ session: f.wrapper, realSessionId: f.id });
  await write;
  assert.equal(f.manager.getSessionName(), "After startup");
});
