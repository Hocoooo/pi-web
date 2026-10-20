import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,mkdir,rm,unlink,rename,readFile,writeFile,utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ChildProcess} from 'node:child_process';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {createTaskTestJiti} from './__fixtures__/task-jiti.mjs';
const agentDir=await mkdtemp(join(tmpdir(),'pi-picker-narrow-'));
process.env.PI_CODING_AGENT_DIR=agentDir;
const jiti=createTaskTestJiti(import.meta.url);
const {taskOperation}=await jiti.import('./task-operations.ts');
const {taskSessionProject,taskSessionCatalogue}=await jiti.import('./task-sessions.ts');
const run=body=>taskOperation(body,{agentDir});
const sessions=[];
for(let i=0;i<8;i++){
 const cwd=join(agentDir,`project-${i}`);await mkdir(cwd);
 const manager=SessionManager.create(cwd,join(agentDir,'sessions',`bucket-${i}`));
 manager.appendMessage({role:'user',content:'PRIVATE conversation',timestamp:Date.now()});sessions.push(manager);
}
await run({action:'list'});
test.after(()=>rm(agentDir,{recursive:true,force:true}));

test('existing-session picker launches Git only for the target project, not every cwd',async t=>{
 let launches=0;const spawn=ChildProcess.prototype.spawn;
 t.mock.method(ChildProcess.prototype,'spawn',function(...args){launches++;return spawn.apply(this,args)});
 const result=await run({action:'task-picker',sessionId:sessions[0].getSessionId()});
 assert.equal(result.relation.sessionId,sessions[0].getSessionId());
 assert.equal(launches,1,'a single-session read must not resolve unrelated projects');
});

test('ownerOnly returns the latest owner, revision and relation tokens without candidates',async()=>{
 const create=async title=>(await run({action:'create',id:randomUUID(),title,description:'PRIVATE',completionCriteria:'',cwd:sessions[0].getCwd()})).task;
 const owner=await create('owner');await create('other candidate');
 const sessionId=sessions[0].getSessionId();
 await run({action:'link',id:owner.id,expectedRevision:owner.revision,sessionIds:[sessionId]});
 const full=await run({action:'task-picker',sessionId});
 const snapshot=await run({action:'task-picker',sessionId,ownerOnly:true});
 assert.equal(full.tasks.length,2);
 assert.deepEqual(snapshot.tasks,full.tasks.filter(t=>t.id===owner.id));
 assert.deepEqual(snapshot.relation,full.relation);
 await run({action:'change-session-relation',sessionId,sourceTaskId:owner.id,targetTaskId:null,
 expectedGeneration:snapshot.relation.generation,expectedUpdateRevision:snapshot.relation.updateRevision,operationId:randomUUID()});
 const unbound=await run({action:'task-picker',sessionId,ownerOnly:true});
 assert.deepEqual(unbound.tasks,[]);assert.equal(unbound.relation.sourceTaskId,null);
 assert.ok(unbound.relation.generation>snapshot.relation.generation);
});

test('target lookup supports nonstandard filenames and refuses a subsequently deleted session',async()=>{
 const manager=sessions[7],id=manager.getSessionId(),file=manager.getSessionFile();
 const moved=join(agentDir,'sessions','bucket-7','legacy-layout.jsonl');await rename(file,moved);
 assert.equal((await run({action:'task-picker',sessionId:id})).relation.sessionId,id);
 await unlink(moved);
 await assert.rejects(run({action:'task-picker',sessionId:id}),e=>e.code==='not-found');
});

test('mixed standard/legacy duplicate IDs keep the same project as authoritative catalogue',async()=>{
 const original=sessions[5];
 const header=JSON.parse((await readFile(original.getSessionFile(),'utf8')).split('\n')[0]);
 const duplicate=join(agentDir,'sessions','bucket-5','legacy-duplicate.jsonl');
 await writeFile(duplicate,JSON.stringify({...header,cwd:sessions[4].getCwd()})+'\n');
 await utimes(duplicate,new Date(1000),new Date(1000));
 try {
  const catalogue=await taskSessionCatalogue(agentDir);
  const target=await taskSessionProject(agentDir,original.getSessionId());
  assert.deepEqual(target,catalogue.find(s=>s.id===original.getSessionId()).project);
  assert.equal(target.cwd,sessions[4].getCwd());
 }finally{await unlink(duplicate)}
});

test('changed headers, chat identity and isolated agent directories remain authoritative',async()=>{
 const manager=sessions[6],file=manager.getSessionFile(),oldId=manager.getSessionId(),newId=randomUUID();
 await run({action:'task-picker',sessionId:oldId});
 const header=JSON.parse((await readFile(file,'utf8')).split('\n')[0]);
 await writeFile(file,JSON.stringify({...header,id:newId,cwd:sessions[3].getCwd(),extra:'replacement'})+'\n');
 await assert.rejects(run({action:'task-picker',sessionId:oldId}),e=>e.code==='not-found');
 assert.equal((await taskSessionProject(agentDir,newId)).cwd,sessions[3].getCwd());
 assert.equal(await taskSessionProject(join(agentDir,'other-agent'),newId),undefined);
 const chat=join(agentDir,'chat-workspace');await mkdir(chat);
 const native=SessionManager.create(chat,join(agentDir,'sessions','chat-bucket'));
 native.appendMessage({role:'user',content:'private',timestamp:Date.now()});
 assert.equal(await taskSessionProject(agentDir,native.getSessionId()),null);
});

test('ownerOnly is a literal true and is forbidden on cwd picker requests',async()=>{
 for(const body of [{action:'task-picker',cwd:null,ownerOnly:true},{action:'task-picker',sessionId:sessions[0].getSessionId(),ownerOnly:false}])
 await assert.rejects(run(body),e=>e.code==='invalid-input');
});
