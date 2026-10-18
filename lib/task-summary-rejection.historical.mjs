import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";

// A plain Node subprocess is essential: the test runner's rejection listener can hide
// a fatal gap between internal generation failure and the public caller's await.
const fixtureUrl = new URL("./task-summary-fixture.mjs", import.meta.url).href;
const script = `
import assert from 'node:assert/strict';
import {readFile,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
const {summaryFixture,content}=await import(${JSON.stringify(fixtureUrl)});
globalThis.fetch=()=>{throw new Error('REAL NETWORK FORBIDDEN')};
assert.equal(process.listenerCount('unhandledRejection'),0);
assert.equal(process.execArgv.some(a=>a.startsWith('--unhandled-rejections')),false);
const mode=process.argv[1], f=await summaryFixture();
try {
 const snapshot=await f.snapshot(), board=await readFile(f.file), native=await readFile(f.source.getSessionFile());
 if(mode==='unavailable') f.runtime.getAvailable=async()=>[];
 else if(mode==='auth') f.runtime.registerNativeProvider({...f.fake.provider,auth:{apiKey:{name:'Explicit failing fake auth',check:async()=>({type:'api_key'}),resolve:async()=>{throw new Error('Fake auth resolution failed')}}}});
 else {
  const getProvider=f.runtime.getProvider.bind(f.runtime);
  f.runtime.getProvider=id=>{const p=getProvider(id);return p?{...p,streamSimple(){throw new Error('Fake synchronous provider failure')}}:p};
 }
 const operationId=randomUUID(), expected=mode==='unavailable'?'invalid-input':'storage-unavailable';
 let failure;
 try { await f.generate(snapshot,{operationId}); assert.fail('generation must reject'); }
 catch(e) { failure=e; assert.equal(e.code,expected); }
 if(mode==='unavailable') assert.match(failure.message,/Selected model unavailable/);
 // Give Node default fatal rejection handling time to run; no process-level handler.
 await new Promise(r=>setTimeout(r,40));
 assert.equal(f.fake.state.callCount,0); assert.equal(f.captures.length,0);
 assert.deepEqual(await readFile(f.file),board); assert.deepEqual(await readFile(f.source.getSessionFile()),native);
 await assert.rejects(f.generate(snapshot,{operationId}),{code:'conflict'});
 await assert.rejects(f.call({action:'publish-context',id:f.task.id,expectedCurrentVersionId:null,operationId:randomUUID(),generationId:operationId,content}),{code:'conflict'});
 // A failed generation releases admission, but exact failed IDs never automatically retry.
 await assert.rejects(f.generate(snapshot,{operationId:randomUUID()}),{code:expected});
 await new Promise(r=>setTimeout(r,40));
 assert.equal(f.fake.state.callCount,0); assert.deepEqual(await readFile(f.file),board);
 console.log(JSON.stringify({mode,callerCaught:failure.code,providerCalls:f.fake.state.callCount,publishedVersions:0,exactRetry:'conflict',admissionReleased:true,globalRejectionListeners:process.listenerCount('unhandledRejection')}));
} finally { await rm(f.agentDir,{recursive:true,force:true}); }
`;
for (const mode of ["unavailable", "auth", "provider"]) {
  test(`default Node caller try/catch survives fast ${mode} failure without dispatch/publication; failed exact retry and admission remain correct`, () => {
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script, mode], {
      cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(child.status, 0, `default Node child failed (${mode})\n${child.stdout}\n${child.stderr}`);
    assert.equal(child.signal, null);
    assert.doesNotMatch(child.stderr, /PromiseRejectionHandledWarning|unhandledRejection/);
    const evidence = JSON.parse(child.stdout.trim());
    assert.equal(evidence.mode, mode); assert.equal(evidence.providerCalls, 0); assert.equal(evidence.publishedVersions, 0);
    assert.equal(evidence.globalRejectionListeners, 0); assert.equal(evidence.admissionReleased, true);
  });
}
