// Joint 08/11: real SDK managers/runtime/routes, fake provider at actual SDK dispatch.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { taskOperation } = await jiti.import("./task-operations.ts");
const { getRpcSession, startRpcSession } = await jiti.import("./rpc-manager.ts");
const { withTaskStore } = await jiti.import("./task-store.ts");
const { POST: create } = await jiti.import("../app/api/agent/new/route.ts");
const { POST } = await jiti.import("../app/api/agent/[id]/route.ts");
const usage = { input:0, output:0, cacheRead:0, cacheWrite:0, totalTokens:0, cost:{ input:0, output:0, cacheRead:0, cacheWrite:0, total:0 } };
const native = manager => manager.getEntries().filter(e => e.type === "custom_message" && e.customType === "pi-web:task-context");
async function fixture(t, handled = false) {
  const dir = await mkdtemp(join(tmpdir(), "j08-")), cwd = join(dir, "chat-workspace"), previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir; await mkdir(cwd);
  await writeFile(join(cwd,"AGENTS.md"), "Joint exact prompt.");
  await writeFile(join(dir,"auth.json"), JSON.stringify({ anthropic:{type:"api_key",key:"joint-fake-no-network"} }));
  await writeFile(join(dir,"settings.json"), JSON.stringify({defaultProvider:"anthropic",defaultModel:"claude-sonnet-4-5"}));
  if (handled) { await mkdir(join(dir,"extensions")); await writeFile(join(dir,"extensions","handled.ts"), "export default function(pi) { pi.registerCommand('joint-handled', { description:'No provider', handler:async()=>{} }); }"); }
  const wrappers = new Set();
  t.after(async () => { for (const w of wrappers) await w.shutdown(); if(previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR=previous; await rm(dir,{recursive:true,force:true}); });
  const op = input => taskOperation(input,{agentDir:dir});
  const task = (await op({action:"create",id:randomUUID(),title:"Joint task",description:"Original task",completionCriteria:"Check",cwd:null})).task;
  const publish = async (goal,base=null) => (await op({action:"publish-context",id:task.id,operationId:randomUUID(),expectedCurrentVersionId:base,content:{goal,decisions:"",progress:"",nextSteps:""}})).task.sharedContext.currentVersionId;
  const preview = sessionId => op({action:"prepare-start",id:task.id,operationId:randomUUID(),sessionId:sessionId ?? null});
  const p = await preview();
  const response = await create(new Request("http://localhost/api/agent/new",{method:"POST",body:JSON.stringify({cwd,type:"ensure_session",taskStart:p.selection,toolNames:handled ? ["read"] : [],provider:"anthropic",modelId:"claude-sonnet-4-5"})}));
  assert.equal(response.status,200); const source = getRpcSession((await response.json()).sessionId); wrappers.add(source); await source.waitUntilReady();
  const send = (w,cmd) => POST(new Request("http://localhost/api/agent/joint",{method:"POST",body:JSON.stringify(cmd)}),{params:Promise.resolve({id:w.sessionId})});
  const captures = [];
  const capture = w => {
    w.inner.agent.streamFunction = (model,context) => {
      const board = JSON.parse(readFileSync(join(dir,"tasks/board.json"))), owner = board.tasks.find(x=>x.sessionIds.includes(w.sessionId));
      captures.push({sessionId:w.sessionId,model:{provider:model.provider,id:model.id},context:structuredClone(context),owner:owner?.id,selected:owner?.sessionContexts.find(c=>c.sessionId===w.sessionId) ?? null});
      const stream = createAssistantMessageEventStream(); queueMicrotask(()=>{ stream.push({type:"done",reason:"stop",message:{role:"assistant",content:[{type:"text",text:"Joint response"}],api:model.api,provider:model.provider,model:model.id,stopReason:"stop",timestamp:Date.now(),usage}}); stream.end(); }); return stream;
    };
  };
  const turn = async (w,selection,message="Explicit joint Send") => { const r=await send(w,{type:"prompt",message,...(selection?{taskStart:selection}:{})}); assert.equal(r.status,200,await r.clone().text()); await w.inner.waitForIdle(); };
  capture(source); await turn(source,null,"Independent pre-context history");
  const pre = source.inner.sessionManager.getBranch().find(e=>e.type==="message" && e.message.role==="assistant").id;
  const open = async id => { const path=(await SessionManager.listAll()).find(s=>s.id===id).path; const {session:w}=await startRpcSession(id,path); wrappers.add(w); await w.waitUntilReady(); capture(w); return w; };
  return {dir,op,task,publish,preview,source,pre,send,turn,captures,open};
}
for (const mode of ["before", "after", "clone", "fork", "branch", "compaction", "context-edit"]) test(`08/11 ${mode}: inherited native fact, no copied selection or child reading before first Send`, {timeout:30000}, async t => {
  const f=await fixture(t), v1=await f.publish("ORIGINAL APPROVED VERSION"), p=await f.preview();
  // The real prepared UUID is already warmed, so refresh the original selection identity.
  p.selection.operationId=f.source.sessionId;
  await f.turn(f.source,p.selection);
  const manager=f.source.inner.sessionManager, context=native(manager)[0]; assert.ok(context);
  let target=manager.getLeafId();
  if(mode==="branch") { await f.source.send({type:"navigate_tree",targetId:f.pre}); target=manager.getLeafId(); }
  if(mode==="compaction") { manager.appendCompaction("Synthetic retain-none summary", "",100); target=manager.getLeafId(); }
  if(mode==="context-edit") { manager.appendContextEdit(context.id,null); target=manager.getLeafId(); }
  await f.publish("LATEST MUST NOT ENTER CHILD",v1);
  const type=mode==="clone"?"clone":mode==="fork"?"fork":"fork_branch";
  // fork excludes its user message; select the post-context user to retain earlier context.
  const entryId=mode==="before"?f.pre:mode==="fork"?manager.getBranch().find(e=>e.type==="message" && e.message.role==="user" && JSON.stringify(e.message.content).includes("Explicit joint Send")).id:target;
  const command={type,operationId:randomUUID(),...(type==="clone"?{leafId:target}:{entryId})};
  const before=f.captures.length, first=await f.send(f.source,command); assert.equal(first.status,200,await first.clone().text()); const result=await first.json();
  assert.equal(f.captures.length,before,"copy never dispatches provider");
  assert.deepEqual(await (await f.send(f.source,command)).json(),result,"exact copy retry confirms original child");
  const child=await f.open(result.data.newSessionId), hasNative=native(child.inner.sessionManager).length>0;
  assert.equal(hasNative,!["before","branch"].includes(mode));
  const bytes=await readFile(join(f.dir,"tasks/board.json")), saved=(await f.op({action:"list"})).tasks[0];
  assert.equal(saved.sessionContexts.length,1); assert.equal(saved.sessionContexts[0].sessionId,f.source.sessionId);
  assert.equal(saved.sessionContexts.some(c=>c.sessionId===child.sessionId),false,"source new-start tuple is never copied to child");
  const continuation=await f.preview(child.sessionId);
  assert.equal(continuation.snapshot.version?.id ?? null,hasNative?v1:null);
  assert.equal(continuation.inheritedFromSessionId,hasNative?f.source.sessionId:undefined);
  assert.deepEqual(await readFile(join(f.dir,"tasks/board.json")),bytes,"inheritance preview is read-only");
  await f.turn(child,continuation.selection,"Child FIRST explicit send");
  const captured=f.captures.at(-1), messages=JSON.stringify(captured.context.messages);
  assert.equal(captured.owner,f.task.id); assert.equal(captured.selected,null,"child has no fabricated new-start selection/read receipt");
  assert.deepEqual(captured.model,{provider:"anthropic",id:"claude-sonnet-4-5"});
  assert.equal(captured.context.systemPrompt ?? captured.context.messages[0].content,"Joint exact prompt.");
  assert.equal(captured.context.messages.flatMap(m=>m.toolsAdded??[]).length,0);
  assert.ok(!messages.includes("LATEST MUST NOT ENTER CHILD"));
  assert.equal(messages.includes("ORIGINAL APPROVED VERSION"),hasNative && !["compaction","context-edit"].includes(mode));
  const count=native(child.inner.sessionManager).length;
  await f.turn(child,continuation.selection,"Child exact selection retry"); assert.equal(native(child.inner.sessionManager).length,count);
  if(process.env.TASK_START_ARTIFACT_DIR) await writeFile(join(process.env.TASK_START_ARTIFACT_DIR,`joint-${mode}.json`),JSON.stringify({continuation,captures:f.captures,saved},null,2));
});

test("08/11 append without reading: extension-handled source material is native inheritance, child first provider is independent",{timeout:30000},async t=>{
  const f=await fixture(t,true),version=await f.publish("APPENDED NOT YET READ"),p=await f.preview();p.selection.operationId=f.source.sessionId;
  const before=f.captures.length;await f.turn(f.source,p.selection,"/joint-handled");assert.equal(f.captures.length,before);assert.equal(native(f.source.inner.sessionManager).length,1);
  const command={type:"fork_branch",entryId:f.source.inner.sessionManager.getLeafId(),operationId:randomUUID()},response=await f.send(f.source,command);assert.equal(response.status,200);assert.equal(f.captures.length,before);
  const child=await f.open((await response.json()).data.newSessionId),preview=await f.preview(child.sessionId);
  assert.equal(preview.snapshot.version.id,version);assert.equal(preview.inheritedFromSessionId,f.source.sessionId);assert.equal(f.captures.length,before);
  await f.turn(child,preview.selection,"Child first actual provider request");const request=f.captures.at(-1);
  assert.match(JSON.stringify(request.context.messages),/APPENDED NOT YET READ/);assert.equal(request.selected,null);assert.equal(request.owner,f.task.id);
  assert.equal(native(child.inner.sessionManager).length,1);assert.ok(request.context.messages.flatMap(m=>m.toolsAdded??[]).some(tool=>tool.name==="read"));
  assert.equal((await f.op({action:"list"})).tasks[0].sessionContexts.length,1);
  if(process.env.TASK_START_ARTIFACT_DIR) await writeFile(join(process.env.TASK_START_ARTIFACT_DIR,"joint-append-not-read.json"),JSON.stringify({preview,captures:f.captures},null,2));
});

test("08/11 Stop receipt-only source copy never fills child; source Continue fills original snapshot exactly once",{timeout:30000},async t=>{
  const f=await fixture(t),v1=await f.publish("STOP ORIGINAL"),p=await f.preview(); p.selection.operationId=f.source.sessionId;
  const entered=Promise.withResolvers(),release=Promise.withResolvers();
  const lock=withTaskStore(f.dir,async()=>{entered.resolve();await release.promise;return{value:null,changed:false};}); await entered.promise;
  const pending=f.send(f.source,{type:"prompt",message:"Stopped",taskStart:p.selection});
  for(let i=0;i<100&&!f.source.isRunning();i++) await new Promise(r=>setTimeout(r,5));
  await f.source.send({type:"abort"});release.resolve();await lock; const refused=await pending;
  assert.equal(refused.status,500);assert.equal((await refused.json()).accepted,false);assert.equal(native(f.source.inner.sessionManager).length,0);
  const copy=await f.send(f.source,{type:"fork_branch",entryId:f.pre,operationId:randomUUID()});assert.equal(copy.status,200);const child=await f.open((await copy.json()).data.newSessionId);
  await f.publish("LATER STOP LATEST",v1);
  const childPreview=await f.preview(child.sessionId);assert.equal(childPreview.snapshot.version,null);
  await f.turn(child,childPreview.selection);assert.equal(native(child.inner.sessionManager).length,0);assert.ok(!JSON.stringify(f.captures.at(-1).context.messages).includes("STOP ORIGINAL"));
  const resumed=await f.preview(f.source.sessionId);assert.equal(resumed.snapshot.version.id,v1);await f.turn(f.source,resumed.selection);await f.turn(f.source,resumed.selection);
  assert.equal(native(f.source.inner.sessionManager).length,1);assert.match(JSON.stringify(f.captures.at(-1).context.messages),/STOP ORIGINAL/);assert.ok(!JSON.stringify(f.captures.at(-1).context.messages).includes("LATER STOP LATEST"));
  if(process.env.TASK_START_ARTIFACT_DIR) await writeFile(join(process.env.TASK_START_ARTIFACT_DIR,"joint-stop-continue.json"),JSON.stringify(f.captures,null,2));
});
