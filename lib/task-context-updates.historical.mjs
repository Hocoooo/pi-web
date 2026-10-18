import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createJiti } from "jiti";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { contextUpdateFixture, settle, attachFakeProvider } from "./task-context-updates-fixture.mjs";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { withTaskStore } = await jiti.import("./task-store.ts");
const { POST: taskPost } = await jiti.import("../app/api/tasks/route.ts");
const text = r => JSON.stringify(r.context.messages);
const materialEntries = w => w.inner.sessionManager.getEntries().filter(e => e.type === "custom_message" && e.customType === "pi-web:task-context");
async function artifact(name, f) { if (process.env.TASK_UPDATE_ARTIFACT_DIR) { await mkdir(process.env.TASK_UPDATE_ARTIFACT_DIR, { recursive: true }); await writeFile(join(process.env.TASK_UPDATE_ARTIFACT_DIR, name + ".json"), JSON.stringify({ captures: f.captures, state: await f.state() }, null, 2)); } }

test("explicit version pending persists; publication/reminder is not send; successful actual provider gets chosen not newer", async t => {
  const f = await contextUpdateFixture(t), second = await f.publish("VERSION TWO");
  assert.equal((await f.state()).state.pendingOperationId, null); await f.send("No receive yet"); await settle(f.w);
  assert.ok(!text(f.captures.at(-1)).includes(second));
  const choice = await f.accept(second), before = f.captures.length, third = await f.publish("VERSION THREE");
  assert.equal(f.captures.length, before); assert.equal(materialEntries(f.w).length, 1);
  assert.equal((await f.state()).state.pendingOperationId, choice.operationId);
  await f.send(); await settle(f.w);
  assert.match(text(f.captures.at(-1)), new RegExp(second)); assert.ok(!text(f.captures.at(-1)).includes(third));
  const state = await f.state(); assert.equal(state.state.pendingOperationId, null); assert.equal(state.current.versionId, second); assert.equal(state.current.successfulSend, true);
  assert.equal(state.state.deliveries.length, 1); assert.equal(materialEntries(f.w).length, 2); assert.equal(f.captures.at(-1).system, "Exact context-update fixture system."); assert.deepEqual(f.captures.at(-1).tools, []);
  await f.op(choice); assert.equal((await f.state()).state.pendingOperationId, null, "receipt retry does not reinstate consumed pending");
  await artifact("explicit-next", f);
});

test("busy receiving does not steer/followup/stop/prompt; lower end, queued steer/followup and automatic extension continuation stay old", async t => {
  const f = await contextUpdateFixture(t, ["read"]), gate = Promise.withResolvers(), started = Promise.withResolvers();
  let calls = 0;
  f.setResponse(async () => { calls++; if (calls === 1) { started.resolve(); await gate.promise; } return fauxAssistantMessage([fauxText("Run " + calls)]); });
  await f.send("Active work"); await started.promise;
  await f.w.send({ type: "steer", message: "Already queued steer" }); await f.w.send({ type: "follow_up", message: "Already queued followup" });
  const second = await f.publish("BUSY NEW VERSION"), choice = await f.accept(second), count = f.captures.length;
  assert.equal(materialEntries(f.w).length, 1); assert.equal(f.w.inner.pendingMessageCount, 2); assert.equal(f.captures.length, count);
  await f.send("User queued while pending exists", { streamingBehavior: "followUp" }); assert.equal(f.w.inner.pendingMessageCount, 3);
  let once = false;
  const unsubscribe = f.w.inner.subscribe(event => { if (event.type === "agent_end" && !once) { once = true; void f.w.inner.sendCustomMessage({ customType: "fixture-auto", content: "Automatic existing continuation", display: false }, { triggerTurn: true }); } });
  gate.resolve(); await settle(f.w); unsubscribe();
  assert.ok(f.captures.length > count); for (const r of f.captures.slice(1)) assert.ok(!text(r).includes(second), "queued/automatic requests do not get pending version");
  assert.equal((await f.state()).state.pendingOperationId, choice.operationId); assert.equal(materialEntries(f.w).length, 1);
  await f.send("Next explicit user send"); await settle(f.w); assert.match(text(f.captures.at(-1)), new RegExp(second));
  assert.equal((await f.state()).state.pendingOperationId, null);
  await artifact("busy-queues-auto", f);
});

test("receive after an explicit prompt submission began cannot enter that prompt even while awaiting admission", async t => {
  const f = await contextUpdateFixture(t), v = await f.publish("SELECTED DURING ADMISSION"), entered = Promise.withResolvers(), release = Promise.withResolvers();
  const lock = withTaskStore(f.agentDir, async () => { entered.resolve(); await release.promise; return { value: null, changed: false }; }); await entered.promise;
  const attempt = f.send("User already submitted old work"); while (!f.w.isRunning()) await new Promise(r => setTimeout(r, 5));
  const selection = f.accept(v, 0); release.resolve(); await lock; await attempt; const chosen = await selection; await settle(f.w);
  assert.ok(!text(f.captures.at(-1)).includes(v)); assert.equal((await f.state()).state.pendingOperationId, chosen.operationId);
  await f.send("User explicitly sends after previous prompt fully ends"); await settle(f.w); assert.match(text(f.captures.at(-1)), new RegExp(v));
  await artifact("admission-boundary", f);
});

test("SDK input handled and slash command acceptance are not provider adoption; exact ordinary retry appends once", async t => {
  const f = await contextUpdateFixture(t, ["read"], `export default function(pi) { pi.on('input', e => e.text === 'Handled input' ? {action:'handled'} : {action:'continue'}); pi.registerCommand('fixture-handled', {description:'Fixture', handler:async()=>{}}); }`);
  const v = await f.publish("HANDLED NOT ADOPTED"), choice = await f.accept(v), count = f.captures.length;
  await f.send("/fixture-handled"); await settle(f.w); assert.equal(f.captures.length, count); assert.equal(materialEntries(f.w).length, 1);
  await f.send("Handled input"); await settle(f.w); assert.equal(f.captures.length, count); assert.equal((await f.state()).state.deliveries.length, 0); assert.equal((await f.state()).state.pendingOperationId, choice.operationId);
  await f.send("Real next user request"); await settle(f.w); assert.equal(materialEntries(f.w).filter(e => e.details.operationId === choice.operationId).length, 1); assert.match(text(f.captures.at(-1)), new RegExp(v));
  await artifact("handled-input", f);
});

test("Stop-before-dispatch preserves durable pending; same choice retry appends exactly once", async t => {
  const f = await contextUpdateFixture(t), v = await f.publish("STOP PENDING"), choice = await f.accept(v);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const lock = withTaskStore(f.agentDir, async () => { entered.resolve(); await release.promise; return { value: null, changed: false }; }); await entered.promise;
  const before = f.captures.length, attempt = f.send();
  while (!f.w.isRunning()) await new Promise(r => setTimeout(r, 5));
  await f.w.send({ type: "abort" }); release.resolve(); await lock;
  await assert.rejects(attempt, /cancelled/); assert.equal(f.captures.length, before); assert.equal(materialEntries(f.w).length, 1); assert.equal((await f.state()).state.pendingOperationId, choice.operationId);
  await f.send(); await settle(f.w); await f.op(choice); await f.send("Another send"); await settle(f.w);
  assert.equal(materialEntries(f.w).filter(e => e.details.operationId === choice.operationId).length, 1);
  await artifact("stop-retry", f);
});

test("auth failure zero actual provider; native append is not adoption; repair keeps pending and deduplicates", async t => {
  const f = await contextUpdateFixture(t), v = await f.publish("AUTH PENDING"), choice = await f.accept(v), before = f.captures.length;
  const original = f.w.inner.modelRuntime.getAuth.bind(f.w.inner.modelRuntime);
  f.w.inner.modelRuntime.getAuth = async () => { throw new Error("Fixture auth denied"); };
  try { await f.send(); } catch {} await settle(f.w);
  assert.equal(f.captures.length, before); assert.equal((await f.state()).state.pendingOperationId, choice.operationId); assert.equal((await f.state()).state.deliveries.length, 0);
  f.w.inner.modelRuntime.getAuth = original;
  await f.send("User explicitly retries"); await settle(f.w);
  assert.equal(materialEntries(f.w).filter(e => e.details.operationId === choice.operationId).length, 1); assert.equal((await f.state()).state.deliveries.length, 1);
  await artifact("auth-retry", f);
});

test("two tabs CAS, exact receipt reopen, explicit clear; stale scope, relationship and HTTP internal operations fail closed", async t => {
  const f = await contextUpdateFixture(t), v2 = await f.publish("CAS TWO"), v3 = await f.publish("CAS THREE");
  const results = await Promise.allSettled([f.accept(v2, 0), f.accept(v3, 0)]); assert.equal(results.filter(r => r.status === "fulfilled").length, 1); assert.equal(results.filter(r => r.status === "rejected").length, 1);
  const winner = results.find(r => r.status === "fulfilled").value; await f.op(winner);
  assert.equal(JSON.parse(await readFile(f.file, "utf8")).tasks[0].sessionUpdates[0].pendingOperationId, winner.operationId);
  const s = await f.state(); await f.op({ action: "clear-context-update", id: f.task.id, sessionId: f.w.sessionId, expectedRevision: s.state.revision });
  assert.equal((await f.state()).state.pendingOperationId, null); await f.op(winner); assert.equal((await f.state()).state.pendingOperationId, null);
  const bytes = await readFile(f.file, "utf8");
  for (const action of ["pending-context-update", "complete-context-update"]) { const response = await taskPost(new Request("http://localhost/api/tasks", { method: "POST", body: JSON.stringify({ action, sessionId: f.w.sessionId }) })); assert.equal(response.status, 400); assert.equal(await readFile(f.file, "utf8"), bytes); }
  const wrong = JSON.parse(bytes); wrong.tasks[0].project = { cwd: f.cwd, projectRoot: "/wrong", projectKey: "wrong" }; await writeFile(f.file, JSON.stringify(wrong));
  await assert.rejects(f.accept(v2), /project/); const n = f.captures.length; await assert.rejects(f.send(), /project/); assert.equal(f.captures.length, n);
  await writeFile(f.file, bytes);
});

test("normal read tools and model change retain permissions/pairs; provider error retains pending despite native append", async t => {
  const f = await contextUpdateFixture(t, ["read"]), v = await f.publish("NORMAL MODEL UPDATE"), choice = await f.accept(v);
  f.w.inner.setAutoRetryEnabled(false);
  f.setResponse(async () => ({ ...fauxAssistantMessage([]), stopReason: "error", errorMessage: "Fixture provider refused" }));
  await f.send(); await settle(f.w);
  assert.match(text(f.captures.at(-1)), new RegExp(v)); assert.equal((await f.state()).state.deliveries.length, 0); assert.equal((await f.state()).state.pendingOperationId, choice.operationId);
  await f.w.send({ type: "set_model", provider: "context-fake", modelId: "two", thinkingLevel: "off" });
  let calls = 0; f.setResponse(async () => ++calls === 1 ? { ...fauxAssistantMessage([{ type: "toolCall", id: "fixture-read-update", name: "read", arguments: { path: "AGENTS.md" } }]), stopReason: "toolUse" } : fauxAssistantMessage([fauxText("Tools finish")]));
  await f.send("Retry with chosen model"); await settle(f.w);
  const actual = f.captures.at(-1); assert.equal(actual.model, "two"); assert.ok(actual.tools.some(t => t.name === "read"));
  const i = actual.context.messages.findIndex(m => m.role === "assistant" && m.content.some(c => c.type === "toolCall" && c.id === "fixture-read-update"));
  assert.ok(i >= 0); assert.equal(actual.context.messages[i + 1].role, "toolResult"); assert.equal(actual.context.messages[i + 1].toolCallId, "fixture-read-update");
  assert.equal(materialEntries(f.w).filter(e => e.details.operationId === choice.operationId).length, 1); assert.equal((await f.state()).state.deliveries[0].model, "two");
  assert.equal(f.w.inner.sessionManager.getEntries().filter(e => e.type === "custom" && e.customType === "pi-web:task-context-send" && e.data.operationId === choice.operationId).length, 1);
  await artifact("model-tools-error", f);
});

test("a successful old delivery cannot clear a new busy selection; reused native IDs across sessions or start receipts conflict", async t => {
  const f = await contextUpdateFixture(t), v2 = await f.publish("OLDER SELECTED SEND"), choice = await f.accept(v2);
  const gate = Promise.withResolvers(), started = Promise.withResolvers();
  f.setResponse(async () => { started.resolve(); await gate.promise; return fauxAssistantMessage([fauxText("Original delivery response")]); });
  await f.send("Send previously selected version"); await started.promise;
  const v3 = await f.publish("NEW BUSY CHOICE"), next = await f.accept(v3);
  assert.match(text(f.captures.at(-1)), new RegExp(v2)); assert.ok(!text(f.captures.at(-1)).includes(v3));
  gate.resolve(); await settle(f.w);
  assert.equal((await f.state()).state.pendingOperationId, next.operationId); assert.equal((await f.state()).state.deliveries[0].operationId, choice.operationId);
  const copied = await f.w.send({ type: "fork_branch", entryId: f.w.inner.sessionManager.getLeafId(), operationId: randomUUID() });
  await assert.rejects(f.op({ action: "accept-context-update", id: f.task.id, sessionId: copied.newSessionId, operationId: choice.operationId, expectedRevision: 0, versionId: v2 }), /belongs to another/);
  const bytes = await readFile(f.file, "utf8"); await assert.rejects(f.accept(v3, undefined, f.w.sessionId), /initial task start/); assert.equal(await readFile(f.file, "utf8"), bytes);
  await f.send("Explicit next user send"); await settle(f.w); assert.match(text(f.captures.at(-1)), new RegExp(v3));
  const preview = await f.op({ action: "prepare-start", id: f.task.id, operationId: randomUUID(), sessionId: f.w.sessionId }); assert.equal(preview.snapshot.version.id, v3);
  await artifact("busy-new-choice-cas", f);
});

test("v5->v6 locked migration preserves every old domain; fresh process retains pending; corrupt present states refuse without reset", async t => {
  const f = await contextUpdateFixture(t), good = JSON.parse(await readFile(f.file, "utf8"));
  const legacy = structuredClone(good); legacy.version = 5; delete legacy.sessionRelations; for (const task of legacy.tasks) delete task.sessionUpdates;
  await writeFile(f.file, JSON.stringify(legacy)); await f.op({ action: "list" });
  const migrated = JSON.parse(await readFile(f.file, "utf8")); assert.deepEqual(migrated, good);
  const v = await f.publish("DURABLE REOPEN"), choice = await f.accept(v);
  const reopened = spawnSync(process.execPath, ["--input-type=module", "-e", `import {createJiti} from ${JSON.stringify(import.meta.resolve("jiti"))}; const jiti=createJiti(${JSON.stringify(import.meta.url)}); const {taskOperation}=await jiti.import('./task-operations.ts'); console.log(JSON.stringify(await taskOperation({action:'context-update-state',sessionId:${JSON.stringify(f.w.sessionId)}},{agentDir:${JSON.stringify(f.agentDir)}})));`], { encoding: "utf8", env: process.env });
  assert.equal(reopened.status, 0, reopened.stderr); assert.equal(JSON.parse(reopened.stdout).state.pendingOperationId, choice.operationId);
  const valid = JSON.parse(await readFile(f.file, "utf8"));
  for (const corrupt of [d => { delete d.tasks[0].sessionUpdates; }, d => { d.tasks[0].sessionUpdates = null; }, d => { d.tasks[0].sessionUpdates[0].pendingOperationId = randomUUID(); }, d => { d.tasks[0].sessionUpdates[0].choices[0].versionId = randomUUID(); }, d => { d.tasks[0].sessionUpdates.push(structuredClone(d.tasks[0].sessionUpdates[0])); }]) {
    const bad = structuredClone(valid); corrupt(bad); await writeFile(f.file, JSON.stringify(bad)); const bytes = await readFile(f.file, "utf8"); await assert.rejects(f.op({ action: "list" }), { code: "storage-unavailable" }); assert.equal(await readFile(f.file, "utf8"), bytes);
  }
  await writeFile(f.file, JSON.stringify(valid));
});

test("fresh SDK process actually sends persisted pending version, not newer; no duplicated native material", async t => {
  const f = await contextUpdateFixture(t), v2 = await f.publish("CROSS PROCESS CHOSEN"), choice = await f.accept(v2);
  await f.w.shutdown(); const v3 = await f.publish("CROSS PROCESS NOT CHOSEN");
  const script = `import {startRpcSession, attachFakeProvider, settle} from ${JSON.stringify(new URL("./task-context-updates-fixture.mjs", import.meta.url).href)};
    const w=(await startRpcSession(${JSON.stringify(f.w.sessionId)},${JSON.stringify(f.w.sessionFile)})).session;
    const fake=await attachFakeProvider(w); await w.send({type:'prompt',message:'User explicitly sends after restart'}); await settle(w);
    console.log('RESULT:'+JSON.stringify({captures:fake.captures,entries:w.inner.sessionManager.getEntries().filter(e=>e.type==='custom_message')})); await w.shutdown();`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: f.agentDir } });
  assert.equal(child.status, 0, child.stderr); const result = JSON.parse(child.stdout.split("\n").find(s => s.startsWith("RESULT:")).slice(7));
  assert.match(text(result.captures.at(-1)), new RegExp(v2)); assert.ok(!text(result.captures.at(-1)).includes(v3));
  assert.equal(result.entries.filter(e => e.details.operationId === choice.operationId).length, 1); assert.equal((await f.state()).state.pendingOperationId, null); assert.equal((await f.state()).state.deliveries.length, 1);
  f.captures.push(...result.captures); await artifact("fresh-process-actual-provider", f);
});

test("automatic SDK retry after low-level end never receives a version selected during retry delay", async t => {
  const f = await contextUpdateFixture(t), retrying = Promise.withResolvers(); let calls = 0;
  f.w.inner.subscribe(e => { if (e.type === "auto_retry_start") retrying.resolve(); });
  f.setResponse(async () => ++calls === 1 ? { ...fauxAssistantMessage([]), stopReason: "error", errorMessage: "429 rate limit fixture" } : fauxAssistantMessage([fauxText("Retried old work")]));
  await f.send("Work that retries"); await retrying.promise;
  const v = await f.publish("RETRY DELAY NEW"), choice = await f.accept(v); await settle(f.w);
  assert.equal(calls, 2); assert.ok(!text(f.captures.at(-1)).includes(v)); assert.equal((await f.state()).state.pendingOperationId, choice.operationId);
  await f.send("Next explicit send"); await settle(f.w); assert.match(text(f.captures.at(-1)), new RegExp(v));
  await artifact("automatic-retry", f);
});

test("context edit/compaction/branch preserve audit, do not claim absent provider input or reappend; copied child has no pending/delivery", async t => {
  const f = await contextUpdateFixture(t), v2 = await f.publish("BRANCH TWO"), choice = await f.accept(v2);
  const before = f.w.inner.sessionManager.getLeafId(); await f.send(); await settle(f.w);
  const entry = materialEntries(f.w).find(e => e.details.operationId === choice.operationId); assert.ok(entry);
  f.w.inner.sessionManager.appendContextEdit(entry.id, null);
  // Reopen from SDK's own projection (not readonly state assignment).
  await f.w.shutdown();
  const { startRpcSession } = await jiti.import("./rpc-manager.ts"); const restarted = (await startRpcSession(f.w.sessionId, f.w.sessionFile)).session;
  t.after(() => restarted.shutdown());
  await attachFakeProvider(restarted, f.captures);
  await restarted.send({ type: "prompt", message: "Send after context edit" }); await settle(restarted);
  assert.ok(!text(f.captures.at(-1)).includes(v2)); assert.equal(materialEntries(restarted).filter(e => e.details.operationId === choice.operationId).length, 1);
  const v3 = await f.publish("SOURCE PENDING NOT CHILD"), pending = await f.accept(v3);
  // Task metadata remains durable; raw historical facts explicitly differ from projection.
  const edited = await f.state(); assert.equal(edited.current.versionId, v2); assert.equal(edited.current.projected, false); assert.equal(edited.state.deliveries.length, 1);
  const copied = await restarted.send({ type: "fork_branch", entryId: entry.id, operationId: randomUUID() });
  const childState = await f.op({ action: "context-update-state", sessionId: copied.newSessionId });
  assert.equal(childState.state.pendingOperationId, null); assert.deepEqual(childState.state.choices, []); assert.deepEqual(childState.state.deliveries, []);
  assert.equal((await f.state()).state.pendingOperationId, pending.operationId); assert.equal(childState.current.successfulSend, false); assert.equal(childState.current.originSessionId, f.w.sessionId);
  await restarted.shutdown();
  const { SessionManager } = await import("@earendil-works/pi-coding-agent"); const manager = SessionManager.open(restarted.sessionFile); manager.branch(before); manager.appendMessage({ role: "user", content: "Alternative branch before update", timestamp: Date.now() });
  const branch = await f.state(); assert.notEqual(branch.current?.versionId, v2); assert.equal(branch.state.deliveries.length, 1);
  const nativeCount = manager.getEntries().filter(e => e.type === "custom_message").length;
  manager.appendCompaction("Synthetic retain-none", manager.getLeafId(), 123);
  assert.equal(manager.getEntries().filter(e => e.type === "custom_message").length, nativeCount);
  const again = (await startRpcSession(f.w.sessionId, f.w.sessionFile)).session; t.after(() => again.shutdown()); await attachFakeProvider(again, f.captures);
  const pendingState = await f.state(); await f.op({ action: "clear-context-update", id: f.task.id, sessionId: again.sessionId, expectedRevision: pendingState.state.revision });
  await again.send({ type: "prompt", message: "After branch and synthetic compaction" }); await settle(again);
  assert.ok(!text(f.captures.at(-1)).includes(v2)); assert.ok(!text(f.captures.at(-1)).includes(v3)); assert.equal(materialEntries(again).length, nativeCount);
  await artifact("branch-audit-copy", f);
});
