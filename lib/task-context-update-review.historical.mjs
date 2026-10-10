import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createJiti } from "jiti";
import { contextUpdateFixture, attachFakeProvider, settle, startRpcSession, newSession, getRpcSession } from "./task-context-updates-fixture.mjs";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, fsCache: false });
const { withTaskStore } = await jiti.import("./task-store.ts");
const entries = w => w.inner.sessionManager.getEntries().filter(e => e.type === "custom_message" && e.customType === "pi-web:task-context");
async function save(name, data) {
  if (!process.env.TASK_UPDATE_ARTIFACT_DIR) return;
  await mkdir(process.env.TASK_UPDATE_ARTIFACT_DIR, { recursive: true });
  await writeFile(join(process.env.TASK_UPDATE_ARTIFACT_DIR, name + ".json"), JSON.stringify(data, null, 2));
}

test("R1 receipt-only Stop, V2 auth failure and Continue preserve previewed native V2 without appending V1", async t => {
  const f = await contextUpdateFixture(t);
  const p = await f.op({ action: "prepare-start", id: f.task.id, operationId: randomUUID(), sessionId: null });
  assert.equal(p.snapshot.version.id, f.first);
  const response = await newSession(new Request("http://localhost/api/agent/new", { method: "POST", body: JSON.stringify({ type: "ensure_session", cwd: f.cwd, toolNames: [], taskStart: p.selection }) }));
  assert.equal(response.status, 200);
  const w = getRpcSession((await response.json()).sessionId); t.after(() => w.shutdown()); await w.waitUntilReady();
  const fake = await attachFakeProvider(w);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const lock = withTaskStore(f.agentDir, async () => { entered.resolve(); await release.promise; return { value: null, changed: false }; }); await entered.promise;
  const attempt = w.send({ type: "prompt", message: "First submission", taskStart: p.selection }).then(() => null, e => e.message);
  // Main12 reserves running before acquiring the original prompt admission.
  // Stop at the later store barrier, not before that admission initializes its signal.
  while (w.pendingPromptCount !== 2) await new Promise(r => setTimeout(r, 2));
  await new Promise(r => setTimeout(r, 20));
  await w.send({ type: "abort" }); release.resolve(); await lock; assert.match(await attempt, /cancelled/);
  assert.equal(entries(w).length, 0); assert.equal(fake.captures.length, 0);
  const v2 = await f.publish("SELECTED AFTER RECEIPT ONLY STOP");
  const choice = { action: "accept-context-update", id: f.task.id, sessionId: w.sessionId, operationId: randomUUID(), versionId: v2, expectedRevision: 0 }; await f.op(choice);
  const auth = w.inner.modelRuntime.getAuth.bind(w.inner.modelRuntime);
  w.inner.modelRuntime.getAuth = async () => { throw new Error("Review fixture auth refusal"); };
  try { await w.send({ type: "prompt", message: "Attempt V2 without Continue metadata" }); } catch {} await settle(w); w.inner.modelRuntime.getAuth = auth;
  const prior = await f.op({ action: "context-update-state", sessionId: w.sessionId });
  assert.equal(prior.current.versionId, v2); assert.equal(prior.state.deliveries.length, 0); assert.equal(fake.captures.length, 0);
  const preview = await f.op({ action: "prepare-start", id: f.task.id, operationId: randomUUID(), sessionId: w.sessionId }); assert.equal(preview.snapshot.version.id, v2);
  await w.send({ type: "prompt", message: "Continue with previewed material", taskStart: preview.selection }); await settle(w);
  const after = await f.op({ action: "context-update-state", sessionId: w.sessionId });
  await save("review-receipt-only", { preview, prior, after, native: entries(w), captures: fake.captures });
  assert.deepEqual(entries(w).map(e => e.details.versionId), [v2], "Continue must not append older V1 after V2");
  assert.equal(after.current.versionId, v2); assert.equal(after.state.pendingOperationId, null);
  assert.deepEqual(after.state.deliveries.map(d => d.entryId), [entries(w)[0].id]);
  assert.ok(JSON.stringify(fake.captures.at(-1).context.messages).includes(v2));
  assert.ok(!JSON.stringify(fake.captures.at(-1).context.messages).includes(f.first));
});

for (const mode of ["omit", "replace", "compact", "null-leaf", "context-handler"]) {
  test(`R2 same-version A cannot stand in for excluded B contribution (${mode})`, async t => {
    const extension = mode === "context-handler" ? `export default function(pi) { pi.on('context', e => ({messages:e.messages.filter(m => !(m.role==='custom' && m.details?.operationId===globalThis.__reviewExcludedChoice))})); }` : null;
    const f = await contextUpdateFixture(t, extension ? ["read"] : [], extension);
    const v2 = await f.publish("SAME VERSION DISTINCT INTENTS"), a = await f.accept(v2); await f.send(); await settle(f.w);
    const b = await f.accept(v2), auth = f.w.inner.modelRuntime.getAuth.bind(f.w.inner.modelRuntime);
    const converter = f.w.inner.agent.convertToLlm;
    f.w.inner.modelRuntime.getAuth = async () => { throw new Error("Review fixture auth refusal"); };
    try { await f.send("Append B then fail auth"); } catch {} await settle(f.w); f.w.inner.modelRuntime.getAuth = auth;
    assert.equal(f.w.inner.agent.convertToLlm, converter, "auth failure restores original public converter");
    const ae = entries(f.w).find(e => e.details.operationId === a.operationId), be = entries(f.w).find(e => e.details.operationId === b.operationId);
    assert.ok(ae && be); assert.notEqual(ae.id, be.id); assert.equal(ae.content, be.content);
    assert.deepEqual((await f.state()).state.deliveries.map(d => d.operationId), [a.operationId]);
    if (mode === "omit") f.w.inner.sessionManager.appendContextEdit(be.id, null);
    if (mode === "replace") f.w.inner.sessionManager.appendContextEdit(be.id, { content: "Replaced B: no shared version material" });
    if (mode === "compact") f.w.inner.sessionManager.appendCompaction("Summary without B", null, 100, {}, true);
    if (mode === "context-handler") globalThis.__reviewExcludedChoice = b.operationId;
    t.after(() => { delete globalThis.__reviewExcludedChoice; });
    // A retain-none compaction removes B by its native boundary alone. Reintroduce
    // V2 with a different SDK entry to prove text inclusion cannot attest to B.
    await f.w.shutdown();
    const w = (await startRpcSession(f.w.sessionId, f.w.sessionFile)).session; t.after(() => w.shutdown()); await attachFakeProvider(w, f.captures);
    if (mode === "null-leaf") w.inner.sessionManager.resetLeaf();
    if (mode === "compact" || mode === "null-leaf") await w.inner.sendCustomMessage({ customType: "review-other-entry", content: ae.content, display: false }, { triggerTurn: false });
    const reopenedConverter = w.inner.agent.convertToLlm;
    const projection = w.inner.sessionManager.buildSessionProjection();
    const target = projection.entries.find(p => p.sourceEntry.id === be.id);
    if (mode === "omit") assert.equal(target.messages.length, 0);
    if (mode === "replace") assert.equal(target.messages[0].content, "Replaced B: no shared version material");
    if (mode === "null-leaf" || mode === "compact") assert.equal(target, undefined);
    const before = await f.state();
    await w.send({ type: "prompt", message: "Explicit retry with B excluded" }); await settle(w);
    const after = await f.state(), capture = f.captures.at(-1);
    await save("review-identity-" + mode, { a, b, ae, be, projection, before, after, capture });
    assert.ok(JSON.stringify(capture.context.messages).includes(v2), "V2 really reaches provider via A/other entry; this does not validate B");
    if (mode !== "null-leaf") assert.equal(before.current.projected, mode === "context-handler", "state describes B's full native projection, not matching A text");
    assert.equal(after.state.deliveries.some(d => d.operationId === b.operationId || d.entryId === be.id), false);
    assert.equal(after.state.pendingOperationId, b.operationId); assert.equal(entries(w).filter(e => e.details.operationId === b.operationId).length, 1);
    // Explicitly choosing the SAME version again is a new legitimate intent.
    // C contributes its own entry and can succeed; excluded B still cannot.
    const c = await f.accept(v2); await w.send({ type: "prompt", message: "New explicit same-version choice" }); await settle(w);
    const final = await f.state(), ce = entries(w).find(e => e.details.operationId === c.operationId);
    assert.ok(ce); assert.equal(final.state.pendingOperationId, null);
    assert.deepEqual(final.state.deliveries.map(d => d.operationId), [a.operationId, c.operationId]);
    assert.equal(final.state.deliveries.at(-1).entryId, ce.id);
    assert.equal(final.current.versionId, v2); assert.equal(final.current.projected, true);
    assert.equal(w.inner.agent.convertToLlm, reopenedConverter, "successful/absent contribution restores original converter");
    assert.equal(ce.content, be.content, "request-local identity does not change persisted same-version text");
    const finalInput = f.captures.at(-1).context.messages;
    assert.ok(finalInput.some(m => m.role === "user" && Array.isArray(m.content) && m.content.some(c => c.type === "text" && c.text === ce.content)));
    assert.ok(!JSON.stringify(finalInput).includes(c.operationId), "operation identity is not a provider marker or permission");
    await save("review-identity-final-" + mode, { state: final, native: entries(w), captures: f.captures });
  });
}
