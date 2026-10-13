// TEST ONLY. Explicit pre-suspension records, never a production/public API bypass.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
export const { taskOperation } = await jiti.import("./task-operations.ts");
export const { waitForTaskReportExecutor } = await jiti.import("./task-report-executor.ts");
export const { withTaskStore, taskColumnRemovalDigest } = await jiti.import("./task-store.ts");
const { publishContext, publicSharedContext } = await jiti.import("./task-context.ts");
const { selectContextUpdate, completeContextUpdate, updateState } = await jiti.import("./task-context-updates.ts");
const { taskContextText } = await jiti.import("./task-start.ts");
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
export const { emptyTaskFilter, projectTaskView } = await jiti.import("./task-view.ts");
export const { copySessionWithTask } = await jiti.import("./task-session-copy.ts");
export const { POST: tasksHttp } = await jiti.import("../app/api/tasks/route.ts");
export { SessionManager };
export const content = goal => ({ goal, decisions: "Synthetic decision", progress: "Legacy record", nextSteps: "User decides" });
export const assistant = { role: "assistant", content: [{ type: "text", text: "Synthetic reply" }], api: "fixture", provider: "fixture", model: "fixture", stopReason: "stop", timestamp: 1,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
export const owner = (board, sessionId) => board.tasks.find(t => t.sessionIds.includes(sessionId));
export const removal = (board, columnId = "todo", targetColumnId = "review") => ({ action: "remove-column", columnId, targetColumnId, confirmCompletion: targetColumnId === "done", operationId: randomUUID(), expectedColumnsRevision: board.columnsRevision, expectedOrderRevision: board.orderRevision, expectedSourceDigest: board.columnRemovalDigests[columnId] });
export function legacySix(good, omitEpochs = false) {
  const d = structuredClone(good); d.version = 6; delete d.sessionRelations;
  if (omitEpochs) {
    for (const task of d.tasks) {
      for (const c of task.sessionContexts) { delete c.relationGeneration; delete c.selection.expectedRelationGeneration; }
      for (const s of task.sessionUpdates) for (const c of s.choices) delete c.relationGeneration;
    }
    for (const r of d.sessionCopies) delete r.sourceRelationGeneration;
  }
  return d;
}
export async function seedLegacyVersion(f, id, goal, source) {
  let request;
  await withTaskStore(f.agentDir, d => {
    const task = d.tasks.find(t => t.id === id);
    request = { action: "publish-context", id, operationId: randomUUID(), expectedCurrentVersionId: task.sharedContext.currentVersionId, content: content(goal), ...(source ? { generationId: source.generationId } : {}) };
    publishContext(task.sharedContext, request, source);
    return { value: null, changed: true };
  });
  return { request, version: (await f.current(id)).sharedContext.versions.at(-1) };
}
export async function seedLegacyChoice(f, id, sessionId, versionId, delivered = false) {
  let choice;
  await withTaskStore(f.agentDir, d => {
    const task = d.tasks.find(t => t.id === id), generation = d.sessionRelations.find(r => r.sessionId === sessionId)?.generation ?? 0;
    choice = { action: "accept-context-update", id, sessionId, operationId: randomUUID(), expectedRevision: updateState(task, sessionId).revision, expectedRelationGeneration: generation, versionId };
    selectContextUpdate(task, choice, generation);
    if (delivered) completeContextUpdate(task, sessionId, { operationId: choice.operationId, entryId: "legacyentry", inputHash: "a".repeat(64), provider: "fixture", model: "fixture", sentAt: new Date().toISOString(), evidence: "sdk-input-successful-response" });
    return { value: null, changed: true };
  });
  return choice;
}
export async function legacyFixture(t, { seed = true } = {}) {
  const agentDir = await mkdtemp(join(tmpdir(), "legacy-"));
  assert.notEqual(spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: agentDir }).status, 0);
  for (let dir = agentDir; ; dir = dirname(dir)) { await assert.rejects(access(join(dir, "node_modules")), { code: "ENOENT" }); if (dir === dirname(dir)) break; }
  const old = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
  const cwd = join(agentDir, "chat-workspace"); await mkdir(cwd);
  const wrappers = [];
  t.after(async () => {
    await waitForTaskReportExecutor();
    for (const w of wrappers) { w.pendingUiResponses.clear(); w.activeCustomUis.clear(); await w.shutdown(); globalThis.__piSessions?.delete(w.sessionId); }
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old;
    await rm(agentDir, { recursive: true, force: true });
  });
  const native = (directory = cwd) => {
    const m = SessionManager.create(directory, join(agentDir, "sessions", "fixture"));
    m.appendMessage({ role: "user", content: "Synthetic user history", timestamp: 0 }); m.appendMessage(assistant); return m;
  };
  const source = native(), sessionId = source.getSessionId(), op = request => taskOperation(request, { agentDir });
  const createRequest = { action: "createFromSession", id: randomUUID(), title: "Legacy task", description: "Description", completionCriteria: "User checks", sourceSessionId: sessionId };
  const task = (await op(createRequest)).task;
  const f = { agentDir, cwd, source, sessionId, task, createRequest, op, native, file: join(agentDir, "tasks/board.json") };
  f.list = () => op({ action: "list" }); f.raw = async () => JSON.parse(await readFile(f.file, "utf8")); f.current = async (id = task.id) => (await f.list()).tasks.find(t => t.id === id);
  f.create = async (title = "Target", project = null) => (await op({ action: "create", id: randomUUID(), title, description: "", completionCriteria: "", cwd: project })).task;
  f.relation = async (targetTaskId, id = sessionId) => {
    const board = await f.list(), current = owner(board, id); assert.ok(current, "relation fixture needs an owned session");
    return { action: "change-session-relation", sourceTaskId: current.id, targetTaskId, sessionId: id, expectedGeneration: (await f.raw()).sessionRelations.find(r => r.sessionId === id)?.generation ?? 0,
      expectedUpdateRevision: current.sessionUpdates.find(s => s.sessionId === id)?.revision ?? 0, operationId: randomUUID() };
  };
  f.change = async (targetTaskId, id = sessionId) => op(await f.relation(targetTaskId, id));
  f.archiveRequest = async (id = task.id, archived = true) => ({ action: "set-archive", id, archived, expectedArchiveRevision: (await f.current(id)).archiveRevision, operationId: randomUUID() });
  f.archive = async (id = task.id, archived = true) => op(await f.archiveRequest(id, archived));
  f.move = async (id, columnId) => { const board = await f.list(); return op({ action: "move", id, columnId, expectedRevision: board.tasks.find(t => t.id === id).revision, expectedOrderRevision: board.orderRevision, operationId: randomUUID(), position: { edge: "end" } }); };
  f.fresh = (request = { action: "list" }) => {
    const script = `import {createJiti} from 'jiti';const {taskOperation}=await createJiti(import.meta.url).import('./lib/task-operations.ts');try{console.log(JSON.stringify({value:await taskOperation(JSON.parse(process.argv[1]),{agentDir:process.argv[2],sessionCopy:true})}));}catch(e){console.log(JSON.stringify({code:e.code}));}`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(request), agentDir], { cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 20000 });
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
  };
  f.wrapper = (m = source) => {
    const calls = { prompts: [], aborts: 0, disposes: 0 };
    const inner = { sessionManager: m, sessionId: m.getSessionId(), sessionFile: m.getSessionFile(), isStreaming: false, isCompacting: false, isBashRunning: false, pendingMessageCount: 0,
      extensionRunner: { emit: async () => {} }, settingsManager: { getDefaultTools: () => [], getShellPath: () => undefined }, agent: { state: {} }, getActiveToolNames: () => [], getAllTools: () => [], setActiveToolsByName() {},
      async prompt(message, options) { calls.prompts.push({ message, context: m.buildSessionContext() }); options.preflightResult?.(); },
      async abort() { calls.aborts++; }, abortBash() { calls.aborts++; }, dispose() { calls.disposes++; } };
    const w = new AgentSessionWrapper(inner); (globalThis.__piSessions ??= new Map()).set(w.sessionId, w); wrappers.push(w);
    return { w, inner, calls };
  };
  if (seed) {
    const manual = await seedLegacyVersion(f, task.id, "LEGACY NATIVE MATERIAL");
    const ai = await seedLegacyVersion(f, task.id, "LEGACY PENDING MATERIAL", { kind: "ai", generationId: randomUUID(), generatedAt: new Date().toISOString(), model: { provider: "fixture", modelId: "fixture" }, responseModel: "fixture", inputHash: "b".repeat(64), sources: [{ sessionId, leafId: source.getLeafId(), entryIds: [source.getLeafId()], toolEntryIds: [] }] });
    let restore, context;
    await withTaskStore(agentDir, d => {
      const stored = d.tasks.find(t => t.id === task.id);
      restore = { action: "restore-context", id: task.id, operationId: randomUUID(), expectedCurrentVersionId: ai.version.id, versionId: manual.version.id }; publishContext(stored.sharedContext, restore);
      context = { sessionId, operationId: sessionId, relationGeneration: 0, selection: { taskId: task.id, operationId: sessionId, mode: "new", sessionId: null, expectedRevision: 1, expectedCurrentVersionId: manual.version.id, confirmSameCwd: false, expectedRelationGeneration: 0 },
        snapshot: { taskId: task.id, title: task.title, description: task.description, completionCriteria: task.completionCriteria, version: publicSharedContext(stored.sharedContext).versions[0] } };
      stored.sessionContexts.push(context); return { value: null, changed: true };
    });
    const delivered = await seedLegacyChoice(f, task.id, sessionId, manual.version.id, true);
    const pending = await seedLegacyChoice(f, task.id, sessionId, ai.version.id);
    source.appendCustomMessageEntry("pi-web:task-context", taskContextText(context.snapshot), true, { taskId: task.id, operationId: sessionId, versionId: manual.version.id });
    source.appendCustomEntry("pi-web:task-context-send", { historical: true, operationId: delivered.operationId });
    source.appendMessage({ role: "user", content: "Fork after legacy material", timestamp: 2 }); source.appendMessage(assistant);
    f.legacy = { manual, ai, restore, context, delivered, pending };
  }
  return f;
}
