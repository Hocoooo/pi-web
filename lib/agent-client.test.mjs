import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const { AgentCommandError, isPromptRejectedError, sendAgentCommand } = await jiti.import("./agent-client.ts");

test("agent command HTTP rejections are distinguishable from transport failures", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () => new Response(
    JSON.stringify({
      error: "Authentication failed",
      code: "prompt_rejected",
      accepted: false,
    }),
    { status: 500, headers: { "Content-Type": "application/json" } },
  );

  await assert.rejects(
    sendAgentCommand("session-id", { type: "prompt", message: "hello" }),
    (error) => {
      assert.equal(error instanceof AgentCommandError, true);
      assert.equal(error.status, 500);
      assert.equal(error.message, "Authentication failed");
      assert.equal(error.code, "prompt_rejected");
      assert.equal(error.accepted, false);
      assert.equal(isPromptRejectedError(error), true);
      return true;
    },
  );

  const transportError = new TypeError("connection reset");
  globalThis.fetch = async () => {
    throw transportError;
  };

  await assert.rejects(
    sendAgentCommand("session-id", { type: "prompt", message: "hello" }),
    (error) => {
      assert.equal(error, transportError);
      assert.equal(error instanceof AgentCommandError, false);
      assert.equal(isPromptRejectedError(error), false);
      return true;
    },
  );
});

test("all copy entries retain an exact UUID across rejection, transport loss and page-module reload, then clear on confirmed success", async (t) => {
  const fetch = globalThis.fetch, storage = globalThis.sessionStorage;
  const values = new Map();
  globalThis.sessionStorage = { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: (k) => values.delete(k) };
  t.after(() => { globalThis.fetch = fetch; if (storage === undefined) delete globalThis.sessionStorage; else globalThis.sessionStorage = storage; });
  for (const type of ["fork", "fork_branch", "clone"]) {
    const bodies = [], command = { type, entryId: "fixture-entry" };
    globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify({ error: "copy inheritance unconfirmed", code: "session_copy_unconfirmed" }), { status: 500 }); };
    await assert.rejects(sendAgentCommand("fixture-session", command), { code: "session_copy_unconfirmed" });
    globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(init.body)); throw new TypeError("lost response"); };
    await assert.rejects(sendAgentCommand("fixture-session", command), /lost response/);
    const reloaded = await createJiti(import.meta.url, { moduleCache: false }).import("./agent-client.ts");
    globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify({ success: true, data: { cancelled: false, newSessionId: "child" } })); };
    assert.equal((await reloaded.sendAgentCommand("fixture-session", command)).newSessionId, "child");
    assert.ok(bodies.every((b) => b.operationId === bodies[0].operationId));
    assert.match(bodies[0].operationId, /^[0-9a-f-]{36}$/); assert.equal(values.size, 0);
    await reloaded.sendAgentCommand("fixture-session", command);
    assert.notEqual(bodies.at(-1).operationId, bodies[0].operationId, "a later explicit copy is a distinct intent");
  }
  const bodies = []; globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(init.body)); return new Response(JSON.stringify({ success: true, data: {} })); };
  await sendAgentCommand("fixture-session", { type: "navigate_tree", targetId: "fixture-entry" });
  await sendAgentCommand("fixture-session", { type: "ensure_session" });
  assert.ok(bodies.every((b) => !Object.hasOwn(b, "operationId"))); assert.equal(values.size, 0);
});

test("only an explicit negative prompt acknowledgement is definitive", () => {
  assert.equal(
    isPromptRejectedError(new AgentCommandError("proxy failure", 502)),
    false,
  );
  assert.equal(
    isPromptRejectedError(new AgentCommandError("generic API failure", 500, "internal_error", false)),
    false,
  );
});
