import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createAgentSession, DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
import { summaryFixture, readSummarySession } from "./task-summary-fixture.mjs";
const { AgentSessionWrapper } = await createJiti(import.meta.url).import("./rpc-manager.ts");
const oldFetch = globalThis.fetch; globalThis.fetch = () => { throw new Error("REAL NETWORK FORBIDDEN"); };
test.after(() => { globalThis.fetch = oldFetch; });
async function fixture(t) { const f = await summaryFixture(); t.after(() => rm(f.agentDir, { recursive: true, force: true })); return f; }
const publication = (f, g) => ({ action: "publish-context", id: f.task.id, expectedCurrentVersionId: null, operationId: randomUUID(), generationId: g.generationId, content: g.content });

test("P1 real SDK auth resolve suspension: relationship invalidation prevents actual faux dispatch, not just post-generation publication", async (t) => {
  const f = await fixture(t), s = await f.snapshot();
  let start, release; const started = new Promise((r) => start = r), held = new Promise((r) => release = r);
  f.runtime.registerNativeProvider({ ...f.fake.provider, auth: { apiKey: { name: "Explicit test auth", check: async () => ({ type: "api_key" }), resolve: async () => { start(); await held; return { auth: {} }; } } } });
  const result = f.generate(s).then((value) => ({ value }), (error) => ({ error })); await started;
  const changed = JSON.parse(await readFile(f.file, "utf8")); changed.tasks[0].sessionIds = []; await writeFile(f.file, JSON.stringify(changed));
  const stable = await readFile(f.file); release(); const outcome = await result;
  assert.equal(outcome.error?.code, "invalid-input");
  assert.equal(f.fake.state.callCount, 0, "no reviewed text or billable request reaches provider after suspended auth");
  assert.deepEqual(await readFile(f.file), stable); assert.equal(changed.tasks[0].sharedContext.versions.length, 0);
});

test("P2 appended SDK context edits deleting/replacing previewed text reject before dispatch and after generation before publication, while plain append stays locked", async (t) => {
  for (const replacement of [null, { content: "Replacement approved instead" }]) {
    const f = await fixture(t), s = await f.snapshot(), before = await readFile(f.file);
    f.source.appendContextEdit(f.user, replacement);
    const manager = await readSummarySession(f.agentDir, f.source.getSessionId());
    assert.doesNotMatch(JSON.stringify(manager.buildSessionProjection().messages), /Approved words/);
    await assert.rejects(f.generate(s), { code: "conflict" }); assert.equal(f.fake.state.callCount, 0); assert.deepEqual(await readFile(f.file), before);
    const fresh = await f.snapshot(), g = await f.generate(fresh); assert.equal(f.fake.state.callCount, 1);
    f.source.appendMessage({ role: "user", content: "ordinary later message excluded", timestamp: Date.now() });
    f.source.appendContextEdit(f.assistant, replacement);
    await assert.rejects(f.call(publication(f, g)), { code: "conflict" });
    assert.deepEqual(await readFile(f.file), before); assert.equal(f.fake.state.callCount, 1, "publication invalidation never generates again");
  }
});

async function warm(f, t) {
  const settingsManager = SettingsManager.inMemory({ defaultTools: ["read"] });
  const resourceLoader = new DefaultResourceLoader({ cwd: f.chat, agentDir: f.agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true }); await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: f.chat, agentDir: f.agentDir, modelRuntime: f.runtime, model: f.fake.getModel("chat"), settingsManager, resourceLoader, sessionManager: f.source });
  const wrapper = new AgentSessionWrapper(session), previous = globalThis.__piSessions; globalThis.__piSessions = new Map([[session.sessionId, wrapper]]);
  session.prompt = () => { throw new Error("SOURCE PROMPT FORBIDDEN"); };
  t.after(() => { wrapper.destroy(); globalThis.__piSessions = previous; }); return session;
}
test("P2 real warm SDK resetLeaf preserves null in read-only clone and invalidates both old generation and already-generated publication", async (t) => {
  const f = await fixture(t), session = await warm(f, t), s = await f.snapshot(), before = await readFile(f.file);
  session.sessionManager.resetLeaf(); assert.equal(session.sessionManager.getLeafId(), null);
  const clone = await readSummarySession(f.agentDir, session.sessionId); assert.equal(clone.getLeafId(), null, "null is an authoritative active leaf, not default-last-entry");
  await assert.rejects(f.generate(s), { code: "conflict" }); assert.equal(f.fake.state.callCount, 0);
  await assert.rejects(f.snapshot(), { code: "invalid-input" });
  session.sessionManager.branch(s.leafId); const g = await f.generate(await f.snapshot()); assert.equal(f.fake.state.callCount, 1);
  session.sessionManager.resetLeaf(); await assert.rejects(f.call(publication(f, g)), { code: "conflict" });
  assert.deepEqual(await readFile(f.file), before); assert.equal(f.fake.state.callCount, 1); assert.equal(session.sessionManager.getLeafId(), null);
});
