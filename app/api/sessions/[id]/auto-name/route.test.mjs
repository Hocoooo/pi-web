import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { POST } = await jiti.import("./route.ts");
const { AgentSessionWrapper } = await jiti.import("@/lib/rpc-manager");
const { cacheSessionPath } = await jiti.import("@/lib/session-reader");

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "pi-web-title-post-"));
  const manager = SessionManager.create(directory, directory);
  manager.appendMessage({ role: "user", content: "Fix login", timestamp: 1 });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop", timestamp: 2 });
  const id = manager.getSessionId();
  cacheSessionPath(id, manager.getSessionFile());
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  const inner = {
    sessionId: id, sessionFile: manager.getSessionFile(), sessionManager: manager, extensionRunner: {}, dispose() {},
    agent: {
      state: { model: { provider: "test", id: "test", reasoning: false }, messages: [{ role: "user", content: "Fix login", timestamp: 1 }] },
      streamFunction: () => {
        const stream = createAssistantMessageEventStream();
        started.resolve();
        void gate.promise.then(() => {
          stream.push({ type: "done", reason: "stop", message: { role: "assistant", content: [{ type: "text", text: "Fix login redirect" }], stopReason: "stop" } });
        });
        return stream;
      },
    },
  };
  const wrapper = new AgentSessionWrapper(inner);
  const previous = globalThis.__piSessions;
  globalThis.__piSessions = new Map([[id, wrapper]]);
  t.after(() => { gate.resolve(); wrapper.destroy(); globalThis.__piSessions = previous; rmSync(directory, { recursive: true, force: true }); });
  const post = () => POST(new Request("http://localhost/api/sessions/test/auto-name", { method: "POST" }), { params: Promise.resolve({ id }) });
  return { wrapper, manager, gate, started, post };
}

test("explicit AI naming persists through the title controller without changing a manual lock", async (t) => {
  const f = fixture(t);
  f.wrapper.renameSession("My pinned name");
  const response = f.post();
  await f.started.promise;
  f.gate.resolve();
  assert.equal((await response).status, 200);
  assert.equal(f.manager.getSessionName(), "Fix login redirect");
  assert.equal(f.wrapper.getTitleState().enabled, false);
});

test("manual rename during explicit generation returns 409 and cannot be overwritten", async (t) => {
  const f = fixture(t);
  const response = f.post();
  await f.started.promise;
  f.wrapper.renameSession("User wins");
  const result = await response;
  assert.equal(result.status, 409, JSON.stringify(await result.json()));
  assert.equal(f.manager.getSessionName(), "User wins");
});
