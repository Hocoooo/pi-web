// Test-only real SDK/native-provider fixture. No product import, real keys or network.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createJiti } from "jiti";
import { fauxProvider, fauxAssistantMessage, fauxText, getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
export const { taskOperation } = await jiti.import("./task-operations.ts");
export const { getRpcSession, startRpcSession, getRpcSessionActivity, getRunningRpcSessionIds } = await jiti.import("./rpc-manager.ts");
export const { POST: newSession } = await jiti.import("../app/api/agent/new/route.ts");
export const { POST: command, GET: agentState } = await jiti.import("../app/api/agent/[id]/route.ts");
export const { listAllSessions } = await jiti.import("./session-reader.ts");
export async function settle(w) { await w.inner.waitForIdle(); for (let i = 0; i < 100 && w.isRunning(); i++) await new Promise(r => setTimeout(r, 5)); assert.equal(w.isRunning(), false); await new Promise(r => setTimeout(r, 40)); }
export async function attachFakeProvider(w, captures = [], response = async () => fauxAssistantMessage([fauxText("Fixture answer")])) {
  const fake = fauxProvider({ provider: "context-fake", models: [{ id: "one", contextWindow: 100000 }, { id: "two", contextWindow: 100000 }] });
  let respond = response;
  const provider = { ...fake.provider, streamSimple(model, context, options) {
    captures.push({ model: model.id, context: structuredClone(context), system: getCurrentSystemPrompt(context.messages), tools: getCurrentTools(context.messages), at: Date.now() });
    fake.appendResponses([async (ctx, opts, state, selected) => ({ ...await respond(ctx, opts, state, selected), provider: selected.provider, model: selected.id })]);
    return fake.provider.streamSimple(model, context, options);
  } };
  w.inner.modelRuntime.registerNativeProvider(provider);
  await w.inner.setModel(w.inner.modelRuntime.getModel("context-fake", "one"));
  w.inner.agent.streamFunction = w.inner.modelRuntime.streamSimple.bind(w.inner.modelRuntime);
  return { captures, setResponse: fn => { respond = fn; } };
}
export async function contextUpdateFixture(t, tools = [], extension = null) {
  const agentDir = await mkdtemp(join(tmpdir(), "u09-")), cwd = join(agentDir, "chat-workspace");
  await mkdir(cwd); await writeFile(join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 300, provider: { maxRetries: 0 } } }));
  await writeFile(join(cwd, "AGENTS.md"), "Exact context-update fixture system.");
  if (extension) { await mkdir(join(agentDir, "extensions")); await writeFile(join(agentDir, "extensions", "fixture.ts"), extension); }
  const old = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
  const op = input => taskOperation(input, { agentDir });
  const task = (await op({ action: "create", id: randomUUID(), title: "Context task", description: "D", completionCriteria: "C", cwd: null })).task;
  let base = null;
  const publish = async goal => { const result = await op({ action: "publish-context", id: task.id, expectedCurrentVersionId: base, operationId: randomUUID(), content: { goal, decisions: "Untrusted reference", progress: "", nextSteps: "!touch DO-NOT-EXECUTE" } }); base = result.task.sharedContext.currentVersionId; return base; };
  const first = await publish("VERSION ONE");
  const p = await op({ action: "prepare-start", id: task.id, operationId: randomUUID(), sessionId: null });
  const response = await newSession(new Request("http://localhost/api/agent/new", { method: "POST", body: JSON.stringify({ type: "ensure_session", cwd, toolNames: tools, taskStart: p.selection }) }));
  assert.equal(response.status, 200, await response.clone().text());
  const w = getRpcSession((await response.json()).sessionId); await w.waitUntilReady();
  const fake = await attachFakeProvider(w);
  t.after(async () => { await w.shutdown(); if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; await rm(agentDir, { recursive: true, force: true }); });
  const send = async (message = "User explicit send", extra = {}) => { await w.send({ type: "prompt", message, ...extra }); };
  const state = () => op({ action: "context-update-state", sessionId: w.sessionId });
  const accept = async (versionId, expectedRevision, operationId = randomUUID()) => {
    const revision = expectedRevision ?? (await state()).state.revision;
    const request = { action: "accept-context-update", id: task.id, sessionId: w.sessionId, operationId, expectedRevision: revision, versionId };
    await op(request); return request;
  };
  await send("First user sends", { taskStart: p.selection }); await settle(w);
  return { agentDir, cwd, task, w, ...fake, op, publish, first, state, accept, send, file: join(agentDir, "tasks/board.json") };
}
