// Independent unified-schema test: 08 snapshots + 11 receipts + 07 provenance + all old CAS.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createJiti } from "jiti";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { summaryFixture } from "./task-summary-fixture.mjs";
import { attachFakeProvider, settle } from "./task-context-updates-fixture.mjs";
const jiti=createJiti(import.meta.url,{tsconfigPaths:true});
const {emptyTaskFilter}=await jiti.import("./task-view.ts");
const {startRpcSession}=await jiti.import("./rpc-manager.ts");
const usage={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
function fresh(f) {
  const script=`import {createJiti} from 'jiti';const {taskOperation}=await createJiti(import.meta.url).import('./lib/task-operations.ts');console.log(JSON.stringify(await taskOperation({action:'list'},{agentDir:process.argv[1]})));`;
  const r=spawnSync(process.execPath,["--input-type=module","-e",script,f.agentDir],{env:process.env,encoding:"utf8"});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);
}
test("v4/v5→v6 independently retains copies/views/AI/manual/restore/history/selection and all receipts without CAS overwrite",{timeout:30000},async t=>{
  const f=await summaryFixture(),old=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=f.agentDir;
  const wrappers=[];t.after(async()=>{for(const w of wrappers) await w.shutdown();if(old===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=old;await rm(f.agentDir,{recursive:true,force:true});});
  const generated=await f.generate(await f.snapshot()),ai={action:"publish-context",id:f.task.id,operationId:randomUUID(),expectedCurrentVersionId:null,generationId:generated.generationId,content:generated.content};
  const first=await f.call(ai),v1=first.task.sharedContext.currentVersionId;
  const save={action:"save-view",id:randomUUID(),operationId:randomUUID(),expectedViewsRevision:0,name:"Combined migration",filter:emptyTaskFilter(),sort:"updated"};
  const saved=await f.call(save),custom=randomUUID();
  await f.call({action:"set-columns",expectedColumnsRevision:saved.columnsRevision,columns:[...saved.columns.map(({id,label})=>({id,label})),{id:custom,label:"Check"}]});
  const move={action:"move",id:f.task.id,operationId:randomUUID(),expectedRevision:f.task.revision,expectedOrderRevision:saved.orderRevision,columnId:custom,position:{edge:"end"}};await f.call(move);
  await writeFile(f.agentDir+"/auth.json",JSON.stringify({anthropic:{type:"api_key",key:"migration-test-only"}}));
  const preview=await f.call({action:"prepare-start",id:f.task.id,operationId:randomUUID(),sessionId:null});
  const {session:w}=await startRpcSession(preview.selection.operationId,"",preview.cwd,{newSessionId:preview.selection.operationId,toolNames:[],initialModel:{provider:"anthropic",modelId:"claude-sonnet-4-5"}});wrappers.push(w);await w.waitUntilReady();
  let requests=0;w.inner.agent.streamFunction=(model)=>{requests++;const s=createAssistantMessageEventStream();queueMicrotask(()=>{s.push({type:"done",reason:"stop",message:{role:"assistant",content:[{type:"text",text:"Migration response"}],api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),stopReason:"stop",usage}});s.end();});return s;};
  await w.send({type:"prompt",message:"Independent migration Send",taskStart:preview.selection});await w.inner.waitForIdle();assert.equal(requests,1);
  const copy={type:"fork_branch",entryId:w.inner.sessionManager.getLeafId(),operationId:randomUUID()};const copied=await w.send(copy);assert.equal(copied.cancelled,false);assert.equal(requests,1);
  const manual={action:"publish-context",id:f.task.id,operationId:randomUUID(),expectedCurrentVersionId:v1,content:{...generated.content,goal:"Later manual"}},second=await f.call(manual);
  const restore={action:"restore-context",id:f.task.id,operationId:randomUUID(),expectedCurrentVersionId:second.task.sharedContext.currentVersionId,versionId:v1};await f.call(restore);
  const good=JSON.parse(await readFile(f.file));assert.equal(good.version,7);assert.equal(good.sessionCopies.length,1);assert.equal(good.tasks[0].sessionContexts.length,1);assert.equal(good.tasks[0].sessionContexts[0].snapshot.version.source.kind,"ai");
  // 12: old v5 archive absence must preserve every established domain/receipt,
  // including a real 08 selection and SDK-created 11 child, not a minimal board.
  const legacyArchive=structuredClone(good);legacyArchive.version=5;delete legacyArchive.sessionRelations;
  for(const task of legacyArchive.tasks){delete task.archived;delete task.archiveRevision;delete task.archiveReceipt;}
  await writeFile(f.file,JSON.stringify(legacyArchive));fresh(f);
  assert.deepEqual(JSON.parse(await readFile(f.file)),good,"v5→v6 archive-only hydration preserves all independent domains as JSON");
  for(const withSelections of [false,true]) {
    const legacy=structuredClone(good);legacy.version=4;delete legacy.sessionRelations;if(!withSelections)for(const task of legacy.tasks)delete task.sessionContexts;
    await writeFile(f.file,JSON.stringify(legacy));const readers=await Promise.all([Promise.resolve().then(()=>fresh(f)),Promise.resolve().then(()=>fresh(f))]);assert.deepEqual(readers[0],readers[1]);
    const expected=structuredClone(good);if(!withSelections)expected.tasks[0].sessionContexts=[];
    assert.deepEqual(JSON.parse(await readFile(f.file)),expected,"every independent field/receipt preserved, only absent contexts hydrated");
  }
  await writeFile(f.file,JSON.stringify(good));fresh(f);const stable=await readFile(f.file);
  for(const r of [ai,manual,restore,save,move]) {await f.call(r);assert.deepEqual(await readFile(f.file),stable);}
  assert.deepEqual(await w.send(copy),copied);assert.deepEqual(await readFile(f.file),stable);
  await w.send({type:"prompt",message:"Exact start selection retry",taskStart:preview.selection});await w.inner.waitForIdle();assert.equal(requests,2);
  assert.deepEqual(await readFile(f.file),stable);assert.equal(w.inner.sessionManager.getEntries().filter(e=>e.customType==="pi-web:task-context").length,1);
  await assert.rejects(f.call({action:"save-view",id:randomUUID(),operationId:randomUUID(),expectedViewsRevision:0,name:"stale",filter:emptyTaskFilter(),sort:"manual"}),{code:"conflict"});
  await assert.rejects(f.call({action:"publish-context",id:f.task.id,operationId:randomUUID(),expectedCurrentVersionId:v1,content:generated.content}),{code:"conflict"});
  await assert.rejects(f.call({action:"set-columns",expectedColumnsRevision:0,columns:saved.columns.map(({id,label})=>({id,label}))}),{code:"conflict"});
  assert.deepEqual(await readFile(f.file),stable);
  for(const corrupt of [
    d=>{delete d.tasks[0].sessionContexts;},d=>{d.tasks[0].sessionContexts=null;},
    d=>{d.tasks[0].sessionContexts.push({...d.tasks[0].sessionContexts[0],sessionId:copied.newSessionId});},
    d=>{d.sessionCopies=null;},d=>{delete d.viewsRevision;},
    d=>{d.tasks[0].sharedContext.versions[0].source.model=null;},
  ]) {const bad=structuredClone(good);corrupt(bad);await writeFile(f.file,JSON.stringify(bad));const bytes=await readFile(f.file);await assert.rejects(f.call({action:"list"}),{code:"storage-unavailable"});assert.deepEqual(await readFile(f.file),bytes);}
  await writeFile(f.file,stable);assert.equal(f.captures.length,1,"migration/selection/copy do not re-run AI summary");
  const archive={action:"set-archive",id:f.task.id,archived:true,expectedArchiveRevision:0,operationId:randomUUID()};
  await f.call(archive);const archived=JSON.parse(await readFile(f.file));
  const stripArchive=d=>{const copy=structuredClone(d);for(const task of copy.tasks){delete task.archived;delete task.archiveRevision;delete task.archiveReceipt;}return copy;};
  assert.deepEqual(stripArchive(archived),stripArchive(good),"archive preserves selections/copies/views/AI history/columns/order/all task domains and receipts");
  const archiveBytes=await readFile(f.file);for(const r of [archive,ai,manual,restore,save,move]){await f.call(r);assert.deepEqual(await readFile(f.file),archiveBytes);}
  assert.deepEqual(await w.send(copy),copied);assert.deepEqual(await readFile(f.file),archiveBytes);
  await assert.rejects(w.send({type:"prompt",message:"Archived exact selection must remain unsent",taskStart:preview.selection}),/archived/);
  assert.equal(requests,2);assert.deepEqual(await readFile(f.file),archiveBytes);
  const restoreArchive={...archive,archived:false,expectedArchiveRevision:1,operationId:randomUUID()};await f.call(restoreArchive);
  assert.deepEqual(stripArchive(JSON.parse(await readFile(f.file))),stripArchive(good));
  await assert.rejects(f.call(archive),{code:"conflict"});
  assert.equal(f.captures.length,1,"archive/restore never dispatch AI summary");
  // 14: deleting the task's custom column retains every established domain,
  // including real AI provenance, SDK child, selection, views and exact receipts.
  const beforeRemoval=JSON.parse(await readFile(f.file));
  const removalBoard=await f.call({action:"list"});
  const remove={action:"remove-column",columnId:custom,targetColumnId:"done",confirmCompletion:true,operationId:randomUUID(),
    expectedColumnsRevision:removalBoard.columnsRevision,expectedOrderRevision:removalBoard.orderRevision,
    expectedSourceDigest:removalBoard.columnRemovalDigests[custom]};
  const removed=await f.call(remove),afterRemoval=JSON.parse(await readFile(f.file));
  const stripStatus=t=>{const copy=structuredClone(t);for(const key of ["columnId","revision","updatedAt"])delete copy[key];return copy;};
  assert.deepEqual(afterRemoval.tasks.map(stripStatus),beforeRemoval.tasks.map(stripStatus));
  assert.deepEqual(afterRemoval.sessionCopies,beforeRemoval.sessionCopies);assert.deepEqual(afterRemoval.savedViews,beforeRemoval.savedViews);
  assert.equal(afterRemoval.tasks[0].columnId,"done");assert.equal(afterRemoval.tasks[0].revision,beforeRemoval.tasks[0].revision+1);
  assert.equal(afterRemoval.orderRevision,beforeRemoval.orderRevision+1);assert.equal(afterRemoval.columnsRevision,beforeRemoval.columnsRevision+1);
  // Main10: genuine v6 preimage contains14's actual receipt plus all accepted domains,
  // but no relation epochs. Fresh processes must compose v7, not drop14 on hydration.
  const legacySix=structuredClone(afterRemoval);legacySix.version=6;delete legacySix.sessionRelations;
  for(const task of legacySix.tasks){
    for(const context of task.sessionContexts){delete context.relationGeneration;delete context.selection.expectedRelationGeneration;}
    for(const state of task.sessionUpdates)for(const choice of state.choices)delete choice.relationGeneration;
  }
  for(const receipt of legacySix.sessionCopies)delete receipt.sourceRelationGeneration;
  await writeFile(f.file,JSON.stringify(legacySix));assert.deepEqual(fresh(f),removed);
  assert.deepEqual(JSON.parse(await readFile(f.file)),afterRemoval,"v6→v7 retains14 receipt, actual07 AI/manual/restore provenance,08 strictstart,11 copy,05 view,12 archive and all CAS exactly; only epoch0 hydration");
  assert.equal("columnRemovalDigests" in afterRemoval,false,"same-lock map remains response-only");
  assert.deepEqual(fresh(f),removed);const removedBytes=await readFile(f.file);
  for(const r of [remove,ai,manual,restore,save,move]){const reply=await f.call(r);assert.deepEqual(reply.board??reply,removed,"all old board receipts return latest authority including derived digests");assert.deepEqual(await readFile(f.file),removedBytes);}
  const oldCreate={action:"createFromSession",id:f.task.id,title:"Summary task",description:"Original description",completionCriteria:"User checks",sourceSessionId:f.source.getSessionId()};
  for(const r of [oldCreate,restoreArchive]){assert.deepEqual((await f.call(r)).board,removed);assert.deepEqual(await readFile(f.file),removedBytes);}
  assert.deepEqual(await w.send(copy),copied);assert.deepEqual(await readFile(f.file),removedBytes);
  assert.equal(f.captures.length,1);assert.equal(requests,2,"column removal performs no provider work");
  await w.send({type:"prompt",message:"Explicit old start receipt after column removal",taskStart:preview.selection});await w.inner.waitForIdle();
  assert.equal(requests,3);assert.deepEqual(await readFile(f.file),removedBytes);
  assert.equal(w.inner.sessionManager.getEntries().filter(e=>e.customType==="pi-web:task-context").length,1);
  await f.call({...archive,expectedArchiveRevision:removed.tasks[0].archiveRevision,operationId:randomUUID()});
  await assert.rejects(w.send({type:"prompt",message:"Moved archive owner stays guarded",taskStart:preview.selection}),/archived/);assert.equal(requests,3);
});

test("main joint v5→v6 retains09 pending +12 receipt +08 strict start +11 child +07 AI draft/history +05 views; only eligible restored Send uses original choice", {timeout:30000}, async t => {
  const f=await summaryFixture(),old=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=f.agentDir;
  let w;t.after(async()=>{await w?.shutdown();if(old===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=old;await rm(f.agentDir,{recursive:true,force:true});});
  const generated=await f.generate(await f.snapshot());
  const ai={action:"publish-context",id:f.task.id,operationId:randomUUID(),expectedCurrentVersionId:null,generationId:generated.generationId,content:generated.content};
  const published=await f.call(ai),v1=published.task.sharedContext.currentVersionId;
  const save={action:"save-view",id:randomUUID(),operationId:randomUUID(),expectedViewsRevision:0,name:"Pending archived migration",filter:emptyTaskFilter(),sort:"priority"};await f.call(save);
  const preview=await f.call({action:"prepare-start",id:f.task.id,operationId:randomUUID(),sessionId:null});
  w=(await startRpcSession(preview.selection.operationId,"",preview.cwd,{newSessionId:preview.selection.operationId,toolNames:[]})).session;await w.waitUntilReady();
  const fake=await attachFakeProvider(w);await w.send({type:"prompt",message:"Initial actual provider",taskStart:preview.selection});await settle(w);
  const copy={type:"fork_branch",entryId:w.inner.sessionManager.getLeafId(),operationId:randomUUID()},child=await w.send(copy);
  const manual={action:"publish-context",id:f.task.id,operationId:randomUUID(),expectedCurrentVersionId:v1,content:{...generated.content,goal:"Later manual"}},v2=(await f.call(manual)).task.sharedContext.currentVersionId;
  const restore={action:"restore-context",id:f.task.id,operationId:randomUUID(),expectedCurrentVersionId:v2,versionId:v1},restored=await f.call(restore),chosen=restored.task.sharedContext.currentVersionId;
  const draft=await f.generate(await f.snapshot(),{expectedCurrentVersionId:chosen});assert.equal(f.captures.length,2);
  const choice={action:"accept-context-update",id:f.task.id,sessionId:w.sessionId,operationId:randomUUID(),expectedRevision:0,versionId:chosen};await f.call(choice);
  const archive={action:"set-archive",id:f.task.id,archived:true,expectedArchiveRevision:0,operationId:randomUUID()};await f.call(archive);
  const good=JSON.parse(await readFile(f.file)),legacy=structuredClone(good);legacy.version=5;delete legacy.sessionRelations;
  await writeFile(f.file,JSON.stringify(legacy));fresh(f);assert.deepEqual(JSON.parse(await readFile(f.file)),good,"present valid09 domain and all12/08/11/07/05 domains survive v5→v6 exactly");
  const stable=await readFile(f.file);for(const r of [ai,manual,restore,save,choice,archive]){await f.call(r);assert.deepEqual(await readFile(f.file),stable);}
  assert.deepEqual(await w.send(copy),child);assert.deepEqual(await readFile(f.file),stable);
  const childState=await f.call({action:"context-update-state",sessionId:child.newSessionId});assert.deepEqual(childState.state.choices,[]);assert.equal(childState.state.pendingOperationId,null);
  assert.equal(good.tasks[0].sessionContexts.some(c=>c.sessionId===child.newSessionId),false,"strictnew receipt never copied");
  await assert.rejects(w.send({type:"prompt",message:"Archived pending cannot send"}),/archived/);assert.equal(fake.captures.length,1);
  // Retained07 review draft may publish while archived, without resetting09 intent
  // or automatically restoring; it is not the version chosen for next Send.
  const later=await f.call({action:"publish-context",id:f.task.id,operationId:randomUUID(),expectedCurrentVersionId:chosen,generationId:draft.generationId,content:{...draft.content,goal:"Unchosen later AI draft"}});
  assert.equal(later.task.archived,true);assert.equal(later.task.sessionUpdates[0].pendingOperationId,choice.operationId);
  await f.call({...archive,archived:false,expectedArchiveRevision:1,operationId:randomUUID()});
  await w.send({type:"prompt",message:"User eligible Send after restore"});await settle(w);
  const input=JSON.stringify(fake.captures.at(-1).context.messages);assert.match(input,new RegExp(chosen));assert.ok(!input.includes(later.task.sharedContext.currentVersionId));
  const state=await f.call({action:"context-update-state",sessionId:w.sessionId});assert.equal(state.state.deliveries.length,1);assert.equal(state.state.pendingOperationId,null);
  assert.equal(w.inner.sessionManager.getEntries().filter(e=>e.customType==="pi-web:task-context"&&e.details.operationId===choice.operationId).length,1);
  assert.equal(f.captures.length,2,"migration/archive/send never re-run07 summary");
  if(process.env.TASK_UPDATE_ARTIFACT_DIR)await writeFile(process.env.TASK_UPDATE_ARTIFACT_DIR+"/joint-all-domain-migration.json",JSON.stringify({before:good,captures:fake.captures,state},null,2));
});
