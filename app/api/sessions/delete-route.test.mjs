import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {ChildProcess} from 'node:child_process';
import {createJiti} from 'jiti';
const dir=await fsp.mkdtemp(join(tmpdir(),'pi-delete-narrow-'));
process.env.PI_CODING_AGENT_DIR=dir;
process.env.PI_WEB_PERF='0';
const jiti=createJiti(import.meta.url,{alias:{'@':process.cwd()}});
const {DELETE}=await jiti.import('./[id]/route.ts');
const {cacheSessionPath,invalidateSessionListCache}=await jiti.import('../../../lib/session-reader.ts');
const ids=[];
async function fixture({parent,subagent,late=false,bucket='project',large=false,content}={}){
 const id=randomUUID(),folder=join(dir,'sessions',bucket),path=join(folder,`${id}.jsonl`);await fsp.mkdir(folder,{recursive:true});
 const header={type:'session',version:3,id,cwd:folder,timestamp:new Date().toISOString(),...(parent?{parentSession:parent.path}:{})};
 const meta={type:'custom',customType:'pi-web:subagent',id:'meta',parentId:null,timestamp:header.timestamp,data:{version:1,parentSessionId:parent?.id,parentSessionPath:parent?.path,profile:'Explore',description:'fixture'}};
 const message={type:'message',id:'m',parentId:null,timestamp:header.timestamp,message:{role:'user',content:content??(large?'fixture '.repeat(300000):'fixture'),timestamp:Date.now()}};
 const entries=[header,...(subagent&&!late?[meta]:[]),message,...(subagent&&late?[meta]:[])];
 await fsp.writeFile(path,entries.map(e=>JSON.stringify(e)).join('\n')+'\n');cacheSessionPath(id,path);ids.push(id);invalidateSessionListCache();return {id,path,header};
}
const remove=target=>DELETE(new Request(`http://localhost/api/sessions/${target.id}`,{method:'DELETE'}),{params:Promise.resolve({id:target.id})});
test.after(()=>fsp.rm(dir,{recursive:true,force:true}));

test('ordinary deletion avoids unrelated whole-file reads, message parsing and project Git',async t=>{
 const target=await fixture(),unrelated=await fixture({content:'const example = {"customType":"pi-web:subagent"}; \\u0001;'.repeat(60000)});
 const original=fs.readFileSync;let bodyReads=0,spawns=0,largeParses=0;
 const parse=JSON.parse;t.mock.method(JSON,'parse',function(text,...args){if(typeof text==='string'&&text.length>2000000)largeParses++;return parse.call(this,text,...args)});
 t.mock.method(fs,'readFileSync',function(path,...args){if(resolve(String(path))===resolve(unrelated.path))bodyReads++;return original.call(this,path,...args)});
 const spawn=ChildProcess.prototype.spawn;t.mock.method(ChildProcess.prototype,'spawn',function(...args){spawns++;return spawn.apply(this,args)});
 syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports()});
 const response=await remove(target);assert.equal(response.status,200);
 assert.equal(bodyReads,0,'unrelated history must not be synchronously loaded');
 assert.equal(spawns,0,'deletion metadata must not resolve display projects');
 assert.equal(largeParses,0,'legacy streaming must skip unrelated message JSON');
 const data=await response.json();assert.deepEqual(data.deletedSessionIds,[target.id]);assert.equal(typeof data.sessionListVersion,'number');
 assert.equal(fs.existsSync(unrelated.path),true);assert.equal(fs.existsSync(target.path),false);
});

test('cascade spans directories, detects legacy late markers, and preserves independent forks',async()=>{
 const grandparent=await fixture(),target=await fixture({parent:grandparent});
 const child=await fixture({parent:target,subagent:true,bucket:'different'});
 const grandchild=await fixture({parent:child,subagent:true,bucket:'third'});
 const late=await fixture({parent:target,subagent:true,late:true});
 const fork=await fixture({parent:target,large:true}),unrelated=await fixture();
 const before=await fsp.readFile(fork.path,'utf8');
 const response=await remove(target);assert.equal(response.status,200);
 const result=await response.json();assert.deepEqual(new Set(result.deletedSessionIds),new Set([target.id,child.id,grandchild.id,late.id]));
 for(const row of [target,child,grandchild,late])assert.equal(fs.existsSync(row.path),false);
 for(const row of [grandparent,fork,unrelated])assert.equal(fs.existsSync(row.path),true);
 const after=await fsp.readFile(fork.path,'utf8');assert.equal(JSON.parse(after.split('\n')[0]).parentSession,grandparent.path);
 assert.equal(after.slice(after.indexOf('\n')),before.slice(before.indexOf('\n')),'fork history unchanged');
});

test('parentless early/late markers and conflicting header parents preserve the old local cascade',async()=>{
 const target=await fixture(),unrelated=await fixture();
 const early=await fixture({parent:target,subagent:true});
 const late=await fixture({parent:target,subagent:true,late:true});
 const conflict=await fixture({parent:target,subagent:true,late:true});
 for(const node of [early,late,conflict]){
  const lines=(await fsp.readFile(node.path,'utf8')).split('\n');const header=JSON.parse(lines[0]);
  if(node===conflict)header.parentSession=unrelated.path;else delete header.parentSession;
  lines[0]=JSON.stringify(header);await fsp.writeFile(node.path,lines.join('\n'));
 }
 const response=await remove(target);assert.equal(response.status,200);
 assert.deepEqual(new Set((await response.json()).deletedSessionIds),new Set([target.id,early.id,late.id,conflict.id]));
 assert.equal(fs.existsSync(unrelated.path),true);
});

test('legacy identity cache is invalidated by an appended parentless child marker',async()=>{
 const first=await fixture(),candidate=await fixture();
 assert.equal((await remove(first)).status,200);
 const second=await fixture();
 await fsp.appendFile(candidate.path,JSON.stringify({type:'custom',customType:'pi-web:subagent',data:{version:1,parentSessionId:second.id,parentSessionPath:second.path}})+'\n');
 const response=await remove(second);assert.equal(response.status,200);
 assert.deepEqual(new Set((await response.json()).deletedSessionIds),new Set([second.id,candidate.id]));
 assert.equal(fs.existsSync(candidate.path),false);
});

test('a rewritten prefix plus file growth cannot reuse a cached negative relation',async()=>{
 const first=await fixture(),candidate=await fixture({large:true});
 assert.equal((await remove(first)).status,200);
 const second=await fixture();
 const marker=JSON.stringify({type:'custom',customType:'pi-web:subagent',data:{version:1,parentSessionId:second.id,parentSessionPath:second.path}});
 const source=await fsp.readFile(candidate.path,'utf8');
 const newline=source.indexOf('\n');
 // The file grows, but its previously checked prefix is NOT append-only.
 await fsp.writeFile(candidate.path,source.slice(0,newline+1)+marker+'\n'+source.slice(newline+1));
 const response=await remove(second);assert.equal(response.status,200);
 assert.deepEqual(new Set((await response.json()).deletedSessionIds),new Set([second.id,candidate.id]));
 assert.equal(fs.existsSync(candidate.path),false);
});

test('related malformed subagent metadata fails closed before changing files',async()=>{
 const target=await fixture(),child=await fixture({parent:target,subagent:true});
 const lines=(await fsp.readFile(child.path,'utf8')).split('\n');const entry=JSON.parse(lines[1]);entry.data.version=999;lines[1]=JSON.stringify(entry);await fsp.writeFile(child.path,lines.join('\n'));
 const response=await remove(target);assert.equal(response.status,500);assert.deepEqual((await response.json()).deletedSessionIds,[]);
 assert.equal(fs.existsSync(target.path),true);assert.equal(fs.existsSync(child.path),true);
 // Isolate this deliberately malformed fixture from later deletion plans.
 await fsp.unlink(child.path);await fsp.unlink(target.path);
});

test('fork snapshot and replacement stay in one synchronous turn and preserve appended entries',async()=>{
 const implementation=await fsp.readFile(new URL('../../../lib/session-deletion.ts',import.meta.url),'utf8');
 const start=implementation.indexOf('source = readFileSync(fork.path');
 const end=implementation.indexOf('writePrivateFileAtomicSync(fork.path',start);
 assert.ok(start>=0&&end>start);assert.doesNotMatch(implementation.slice(start,end),/\bawait\b/,'no same-process append opportunity between snapshot and replacement');
 const target=await fixture(),fork=await fixture({parent:target});
 const append=JSON.stringify({type:'message',id:'live-append',message:{role:'user',content:'appended entry'}})+'\n';
 await fsp.appendFile(fork.path,append);
 const response=await remove(target);assert.equal(response.status,200);
 assert.ok((await fsp.readFile(fork.path,'utf8')).endsWith(append));
});

test('unflushed live subagents shut down before the root and late flush files are removed',async t=>{
 const target=await fixture(),id=randomUUID(),path=join(dir,'sessions','project',`${id}.jsonl`);
 const header={type:'session',version:3,id,cwd:dir,timestamp:new Date().toISOString(),parentSession:target.path};
 const meta={type:'custom',customType:'pi-web:subagent',data:{version:1,parentSessionId:target.id,parentSessionPath:target.path}};
 const previous=globalThis.__piSessions,order=[];
 globalThis.__piSessions=new Map([
  [target.id,{isRunning:()=>false,shutdown:async()=>{order.push(target.id);globalThis.__piSessions.delete(target.id)}}],
  [id,{isAlive:()=>true,isRunning:()=>false,sessionId:id,sessionFile:path,cwd:dir,
   inner:{sessionManager:{getHeader:()=>header,getEntries:()=>[meta],getSessionFile:()=>path,getSessionName:()=>undefined}},
   shutdown:async()=>{order.push(id);await fsp.writeFile(path,JSON.stringify(header)+'\n'+JSON.stringify(meta)+'\n');globalThis.__piSessions.delete(id)},
  }],
 ]);
 t.after(()=>{globalThis.__piSessions=previous});
 const response=await remove(target);assert.equal(response.status,200);
 assert.deepEqual((await response.json()).deletedSessionIds,[id,target.id]);assert.deepEqual(order,[id,target.id]);
 assert.equal(fs.existsSync(path),false);assert.equal(fs.existsSync(target.path),false);
});

test('a replaced file behind a cached ID is not deleted',async()=>{
 const target=await fixture();await fsp.writeFile(target.path,JSON.stringify({...target.header,id:randomUUID()}));
 const response=await remove(target);assert.equal(response.status,500);assert.equal(fs.existsSync(target.path),true);
 assert.deepEqual((await response.json()).deletedSessionIds,[]);
});

test('shutdown failure is not reported as successful deletion',async t=>{
 const target=await fixture();const previous=globalThis.__piSessions;
 globalThis.__piSessions=new Map([[target.id,{isRunning:()=>false,shutdown:async()=>{throw new Error('shutdown failed')}}]]);
 t.after(()=>{globalThis.__piSessions=previous});
 const response=await remove(target);assert.equal(response.status,500);
 const result=await response.json();assert.notEqual(result.ok,true);assert.equal(fs.existsSync(target.path),true);
});

test('partial unlink failure reports only completed deletions and can be retried',async t=>{
 const target=await fixture(),child=await fixture({parent:target,subagent:true});
 const original=await fsp.readFile(target.path);const previous=globalThis.__piSessions;
 // A real filesystem failure after planning, portable across Windows and Unix.
 globalThis.__piSessions=new Map([[target.id,{isRunning:()=>false,shutdown:async()=>{
  await fsp.unlink(target.path);await fsp.mkdir(target.path);globalThis.__piSessions.delete(target.id);
 }}]]);
 t.after(()=>{globalThis.__piSessions=previous});
 const response=await remove(target);assert.equal(response.status,500);const result=await response.json();
 assert.deepEqual(result.deletedSessionIds,[child.id]);assert.equal(fs.existsSync(target.path),true);assert.equal(fs.existsSync(child.path),false);
 await fsp.rmdir(target.path);await fsp.writeFile(target.path,original);
 const retried=await remove(target);assert.equal(retried.status,200);assert.deepEqual((await retried.json()).deletedSessionIds,[target.id]);
});
