// Actual route bodies with bounded dependency fakes: no SDK/provider/user filesystem.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import { validateVideoCommand } from "../../../lib/video-attachments.ts";

async function routes() {
  const calls = [], state = { existing: null, path: "/synthetic/session.jsonl", exists: true };
  const session = { isAlive: () => true, sessionFile: state.path, async send(command) {
    calls.push(["send", command]);
    return command.type === "get_state" ? { model: { provider: "fixture", id: "one" }, thinkingLevel: "low", headless: false } : null;
  } };
  let serial = 0;
  const modules = {
    "next/server": { NextResponse: { json: (value, init) => Response.json(value, init) } },
    fs: { existsSync: cwd => { calls.push(["exists", cwd]); return state.exists; } },
    crypto: { randomUUID: () => `fixture-${++serial}` },
    "@/lib/file-access": { allowFileRoot: cwd => calls.push(["allow", cwd]) },
    "@/lib/session-reader": {
      invalidateSessionListCache: () => calls.push(["invalidate"]),
      resolveSessionPath: async id => { calls.push(["resolve", id]); return state.path; },
    },
    "@/lib/rpc-manager": {
      getRpcSession: id => { calls.push(["get", id]); return state.existing; },
      startRpcSession: async (...args) => { calls.push(["start", ...args]); return { session, realSessionId: "real-id" }; },
      setRpcSessionTools: async (...args) => { calls.push(["set_tools", ...args]); return { sessionId: "real-id", recreated: true }; },
    },
    "@/lib/task-session-copy": { SessionCopyError: class SessionCopyError extends Error {} },
    "@/lib/video-attachments": { validateVideoCommand },
  };
  const load = async path => {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    const exports = {};
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
      { exports, require(name) { assert.ok(Object.hasOwn(modules, name), `Unexpected route dependency: ${name}`); return modules[name]; } });
    return exports.POST;
  };
  const create = await load("./new/route.ts"), command = await load("./[id]/route.ts");
  return { calls, state, session, create, command: body => command({ json: async () => body }, { params: Promise.resolve({ id: "existing-id" }) }), new: body => create({ json: async () => body }) };
}

test("both agent routes reject any own taskStart before startup, lookup, tools, permissions or ensure_session", async () => {
  const f = await routes();
  for (const existing of [null, f.session]) {
    f.state.existing = existing;
    for (const type of ["prompt", "ensure_session", "steer", "follow_up", "set_tools"]) {
      for (const taskStart of [undefined, null, false, {}, { taskId: "old-task", mode: "new" }]) {
        for (const send of [f.new, f.command]) {
          const response = await send({ cwd: "/synthetic", type, message: "Never sent", taskStart });
          assert.equal(response.status, 500);
          const error = await response.json(); assert.match(error.error, /suspended/);
          if (type === "prompt") { assert.equal(error.code, "prompt_rejected"); assert.equal(error.accepted, false); }
          assert.deepEqual(f.calls, []);
        }
      }
    }
  }
});

test("ordinary new/ensure_session preserve startup options, unique keys and post-start permission grants", async () => {
  const f = await routes();
  for (const type of ["ensure_session", "prompt"]) {
    const response = await f.new({ cwd: "/synthetic", type, message: "Ordinary", toolNames: [], provider: "fixture", modelId: "one", thinkingLevel: "high", headless: true });
    assert.equal(response.status, 200); assert.equal((await response.json()).sessionId, "real-id");
    const start = f.calls.find(c => c[0] === "start");
    assert.match(start[1], /^__new__fixture-/); assert.equal(start[2], ""); assert.equal(start[3], "/synthetic");
    assert.deepEqual(JSON.parse(JSON.stringify(start[4])), { headless: true, toolNames: [], initialModel: { provider: "fixture", modelId: "one" }, thinkingLevel: "high" });
    assert.ok(f.calls.findIndex(c => c[0] === "allow") > f.calls.findIndex(c => c[0] === "start"));
    const sent = f.calls.filter(c => c[0] === "send").map(c => c[1].type);
    assert.deepEqual(sent, type === "prompt" ? ["get_state", "prompt"] : ["get_state"]);
    f.calls.length = 0;
  }
});

test("ordinary sleeping/warm commands and tool rebuilding retain their original routes without task dependencies", async () => {
  const f = await routes();
  assert.equal((await f.command({ type: "prompt", message: "Ordinary", toolNames: [] })).status, 200);
  assert.deepEqual(f.calls.map(c => c[0]), ["get", "resolve", "start", "send"]);
  assert.equal(f.calls[2][1], "existing-id"); assert.equal(f.calls[2][2], f.state.path);
  f.calls.length = 0; f.state.existing = f.session;
  assert.equal((await f.command({ type: "prompt", message: "Warm" })).status, 200);
  assert.deepEqual(f.calls.map(c => c[0]), ["get", "send"]);
  f.calls.length = 0;
  assert.equal((await f.command({ type: "set_tools", toolNames: ["read"] })).status, 200);
  assert.deepEqual(f.calls.map(c => c[0]), ["get", "set_tools"]);
});

test("ordinary validation failures still do not start sessions or grant filesystem access", async () => {
  const f = await routes();
  for (const patch of [{ cwd: undefined }, { provider: "missing-model" }, { thinkingLevel: "invalid" }, { headless: "yes" }]) {
    const response = await f.new({ cwd: "/synthetic", type: "prompt", message: "Unsent", ...patch });
    assert.ok(response.status >= 400); assert.equal((await response.json()).accepted, false);
    assert.ok(f.calls.every(c => c[0] === "exists")); f.calls.length = 0;
  }
  assert.equal((await f.command({ type: "set_tools", toolNames: "invalid" })).status, 500);
  assert.deepEqual(f.calls, []);
});
