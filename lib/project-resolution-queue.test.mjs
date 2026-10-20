import assert from 'node:assert/strict';
import test from 'node:test';
import {setImmediate as tick} from 'node:timers/promises';
import {createJiti} from 'jiti';
const {createProjectResolutionQueue}=await createJiti(import.meta.url).import('./project-resolution-queue.ts');

test('background launches yield and remain bounded, leaving slots for foreground work',async()=>{
 const queue=createProjectResolutionQueue();
 const releases=[];let active=0,max=0,started=0;
 const jobs=Array.from({length:12},()=>queue.run('background',()=>{
  started++;active++;max=Math.max(max,active);
  return new Promise(resolve=>releases.push(()=>{active--;resolve('done')}));
 }));
 assert.equal(started,0,'enqueue must not synchronously spawn');
 await tick();assert.equal(started,2);
 const fast=queue.run('foreground',async()=>'current session');
 assert.equal(await fast,'current session');
 assert.equal(started,2,'foreground must not sit behind the background backlog');
 while(started<12||active){while(releases.length)releases.shift()();await tick()}
 assert.deepEqual(await Promise.all(jobs),Array(12).fill('done'));assert.equal(max,2);
});

test('mixed backlog gives foreground the next released slot without exceeding either limit',async()=>{
 const queue=createProjectResolutionQueue(),order=[],releases=new Map();
 let active=0,bg=0,max=0,maxBg=0;
 const work=(id,priority)=>queue.run(priority,()=>{
  order.push(id);active++;if(priority==='background')bg++;
  max=Math.max(max,active);maxBg=Math.max(maxBg,bg);
  return new Promise(resolve=>releases.set(id,()=>{active--;if(priority==='background')bg--;releases.delete(id);resolve()}));
 });
 const jobs=[0,1,2,3].map(i=>work(`b${i}`,'background'));await tick();
 jobs.push(...[0,1,2].map(i=>work(`f${i}`,'foreground')));await tick();
 assert.deepEqual(order,['b0','b1','f0','f1']);
 releases.get('b0')();await tick();await tick();assert.equal(order.at(-1),'f2');
 while(order.length<7||active){for(const release of [...releases.values()])release();await tick()}
 await Promise.all(jobs);assert.equal(max,4);assert.equal(maxBg,2);
});

test('all callers share the total limit and rejection releases capacity',async()=>{
 const queue=createProjectResolutionQueue();let active=0,max=0;
 const jobs=Array.from({length:14},(_,i)=>queue.run('foreground',async()=>{
  active++;max=Math.max(max,active);await tick();active--;
  if(i===0)throw new Error('expected');return i;
 }));
 const results=await Promise.allSettled(jobs);
 assert.equal(max,4);assert.equal(active,0);assert.equal(results[0].status,'rejected');
 assert.equal(results.slice(1).every(r=>r.status==='fulfilled'),true);
 assert.equal(await queue.run('foreground',()=>{throw new Error('sync')} ).catch(e=>e.message),'sync');
 assert.equal(await queue.run('foreground',async()=>'retry'),'retry');
});
