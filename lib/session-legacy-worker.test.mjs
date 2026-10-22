import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url);
const {createLegacyScanWorker}=await jiti.import('./session-legacy-worker.ts');
const {createLegacyScanMetrics}=await jiti.import('./session-legacy-scan.ts');
async function fixture(t,body){const dir=await mkdtemp(join(tmpdir(),'pi-legacy-worker-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'child.jsonl');await writeFile(path,body);return {id:'child',path}}
const marker=JSON.stringify({type:'custom',customType:'pi-web:subagent',data:{version:1,parentSessionId:'parent',parentSessionPath:'/parent'}});

test('real isolated worker scans concurrent files, aggregates counters and leaves files unchanged',async t=>{
 const a=await fixture(t,JSON.stringify({type:'message',message:{content:'x'.repeat(2_000_000)}})+'\n'+marker+'\n');
 const b=await fixture(t,'{"type":"message"}\n');const before=await readFile(a.path);
 const scanner=createLegacyScanWorker();t.after(()=>scanner.close());const metrics=createLegacyScanMetrics();
 assert.deepEqual(await Promise.all([scanner.scan(a,metrics),scanner.scan(b,metrics)]),['parent',undefined]);
 assert.equal(metrics.lines,3);assert.equal(metrics.parsedLines,1);assert.ok(metrics.bytesRead>2_000_000);
 assert.deepEqual(await readFile(a.path),before);
 await scanner.close();await assert.rejects(scanner.scan(a,metrics),/closed/);
});

test('ENOENT and malformed metadata propagate; closing releases ownership for later plans',async t=>{
 const bad=await fixture(t,'{"type":"custom","customType":"pi-web:subagent","data":{"version":999}}\n');
 const scanner=createLegacyScanWorker();t.after(()=>scanner.close());
 await assert.rejects(scanner.scan({id:'missing',path:bad.path+'.missing'},createLegacyScanMetrics()),e=>e.code==='ENOENT');
 await assert.rejects(scanner.scan(bad,createLegacyScanMetrics()),/safely identify/);
 await scanner.close();
 const next=createLegacyScanWorker();t.after(()=>next.close());
 assert.equal(await next.scan(await fixture(t,marker),createLegacyScanMetrics()),'parent');
});

test('concurrent plans queue behind one worker and an unopened close acquires nothing',async t=>{
 const node=await fixture(t,marker);const first=createLegacyScanWorker(),second=createLegacyScanWorker(),unused=createLegacyScanWorker();
 t.after(async()=>{await first.close();await second.close();await unused.close()});
 await unused.close();assert.equal(await first.scan(node,createLegacyScanMetrics()),'parent');
 let completed=false;const queued=second.scan(node,createLegacyScanMetrics()).then(value=>{completed=true;return value});
 await new Promise(r=>setTimeout(r,50));assert.equal(completed,false);
 await first.close();assert.equal(await queued,'parent');await second.close();
});

test('worker artifacts are shipped and included in Next route tracing',async()=>{
 const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
 assert.ok(pkg.files.includes('bin'));
 const config=await readFile(new URL('../next.config.ts',import.meta.url),'utf8');
 assert.match(config,/outputFileTracingIncludes/);assert.match(config,/"\/api\/sessions\/\*"/);
 for(const file of ['session-legacy-worker.cjs','session-legacy-scan.cjs']){assert.ok(config.includes(file));assert.ok((await readFile(new URL('../bin/'+file,import.meta.url))).length>0)}
});
