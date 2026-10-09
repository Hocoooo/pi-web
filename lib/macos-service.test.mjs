import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { LaunchAgent, launchAgentPlist, readLaunchEnvironment } from '../.pi/skills/pi-web-local-global-install/scripts/lib/mac-launchagent.mjs';
import { delegateTerminal, terminalCommand } from '../.pi/skills/pi-web-local-global-install/scripts/lib/mac-terminal.mjs';
import { MacOSHost } from '../.pi/skills/pi-web-local-global-install/scripts/lib/macos-host.mjs';
import { parseArgs, PACKAGE, acquireLock, releaseLock } from '../.pi/skills/pi-web-local-global-install/scripts/lib/policy.mjs';
import { apply, inspectSource, schedule, lockFile, createPlan } from '../.pi/skills/pi-web-local-global-install/scripts/lib/workflow.mjs';

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-web-service-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function fixture(t) {
  const root = directory(t);
  const plan = { runtimeHome: root, prefix: root, port: 30141, host: '127.0.0.1', macosLaunch: 'launchagent', macosEnvFile: path.join(root, 'environment.json') };
  fs.writeFileSync(plan.macosEnvFile, JSON.stringify({ HOME: root, PATH: '/usr/bin:/bin', PI_WEB_PASSWORD: 'fixture-private-value' }), { mode: 0o600 });
  let loaded = false;
  const calls = [];
  const host = {
    runtimeEnv: { PI_WEB_PASSWORD: 'fixture-private-value' }, packageDir: prefix => path.join(prefix, 'pkg'),
    processDetails: () => ({ argv: [process.execPath, agent.files.runner, agent.files.config] }),
    launchctl: args => {
      calls.push(args);
      if (args[0] === 'print' && args[1].split('/').length === 2) return { status: 0, stdout: '' };
      if (args[0] === 'print') return loaded ? { status: 0, stdout: `arguments = {\n ${agent.files.runner}\n ${agent.files.config}\n}\npid = 123\n` } : { status: 113, stdout: '' };
      if (args[0] === 'bootstrap') loaded = true;
      if (args[0] === 'bootout') loaded = false;
      return { status: 0, stdout: '' };
    },
  };
  const agent = new LaunchAgent(host, plan);
  return { root, plan, host, agent, calls };
}

test('restart-only options are explicit, bounded and cannot request a build or silently select an invalid mode', () => {
  assert.equal(parseArgs(['restart', '--defer', '90']).restart, true);
  assert.equal(parseArgs(['restart', '--macos-launch', 'terminal']).macosLaunch, 'terminal');
  assert.throws(() => parseArgs(['restart', '--commit', 'HEAD']), /Unsupported/);
  assert.throws(() => parseArgs(['run', '--macos-launch', 'terminal']), /require/);
  assert.throws(() => parseArgs(['restart', '--macos-launch', 'detached']), /terminal or launchagent/);
  assert.throws(() => parseArgs(['restart', '--macos-env-file', '/tmp/env']), /requires/);
});

test('Terminal command keeps shell metacharacters literal and does not inline the environment', () => {
  const command = terminalCommand('/node with space', "/file's/$HOME;echo bad", '/socket', '/work space');
  assert.ok(command.includes("'/file'\\''s/$HOME;echo bad'"));
  assert.ok(command.startsWith("cd '/work space' && exec /usr/bin/env -u NODE_OPTIONS -u TURBOPACK"));
  assert.ok(!command.includes('PI_WEB_PASSWORD'));
});

test('LaunchAgent registration uses explicit private environment, escaped argv, no KeepAlive loop and no credentials in plist/config', { skip: process.platform === 'win32' }, t => {
  const { agent, plan, calls } = fixture(t);
  agent.preflight();
  agent.start();
  assert.equal(agent.loaded().pid, 123);
  const plist = fs.readFileSync(agent.files.plist, 'utf8');
  if (process.platform === 'darwin') cp.execFileSync('/usr/bin/plutil', ['-lint', agent.files.plist]);
  assert.match(plist, /<key>KeepAlive<\/key><false\/>/);
  assert.match(plist, /<key>LimitLoadToSessionType<\/key><string>Aqua/);
  assert.ok(!plist.includes('fixture-private-value'));
  assert.ok(!fs.readFileSync(agent.files.config, 'utf8').includes('fixture-private-value'));
  assert.equal(fs.statSync(agent.files.config).mode & 0o777, 0o600);
  assert.equal(agent.existing().envFile, plan.macosEnvFile);
  const escaped = launchAgentPlist({ node: '/a&b<node>', packageDir: '/pkg' }, agent.files);
  assert.ok(escaped.includes('/a&amp;b&lt;node&gt;'));
  agent.stop();
  agent.disableRegistration();
  assert.equal(agent.existing(), null);
  assert.equal(calls.filter(c => c[0] === 'bootout').length, 1);
});

test('LaunchAgent fails closed on unsafe secret files, changed password, unknown registration and GUI failures', { skip: process.platform === 'win32' }, t => {
  const { agent, plan, host } = fixture(t);
  fs.chmodSync(plan.macosEnvFile, 0o644);
  assert.throws(() => agent.preflight(), /owner-only/);
  fs.chmodSync(plan.macosEnvFile, 0o600);
  const link = path.join(plan.runtimeHome, 'link');
  fs.symlinkSync(plan.macosEnvFile, link);
  assert.throws(() => readLaunchEnvironment(link, plan.runtimeHome), /owner-only/);
  fs.writeFileSync(plan.macosEnvFile, '{"secret":"DO-NOT-PRINT"');
  assert.throws(() => agent.preflight(), e => !e.message.includes('DO-NOT-PRINT'));
  fs.writeFileSync(plan.macosEnvFile, JSON.stringify({ HOME: plan.runtimeHome, PATH: '/bin' }));
  assert.throws(() => agent.preflight(), /PI_WEB_PASSWORD/);
  host.runtimeEnv = {};
  host.launchctl = () => ({ status: 141, stdout: '' });
  assert.throws(() => agent.preflight(), /Cannot inspect/);
  host.launchctl = () => ({ status: 0, stdout: 'arguments = {\n/unknown\n}' });
  assert.throws(() => agent.preflight(), /unknown job/);
});

test('LaunchAgent never boots out or overwrites a modified plist', { skip: process.platform === 'win32' }, t => {
  const { agent, calls } = fixture(t);
  agent.start();
  fs.appendFileSync(agent.files.plist, 'changed');
  assert.throws(() => agent.stop(), /Unrecognized/);
  assert.throws(() => agent.start(), /Unrecognized/);
  assert.equal(calls.filter(c => c[0] === 'bootout').length, 0);
});

test('native Terminal handoff transports env over a private socket and confirms the actual worker, without opening Terminal', { skip: process.platform !== 'darwin' }, async t => {
  const root = directory(t);
  const runDir = path.join(root, "space's $literal");
  fs.mkdirSync(path.join(runDir, 'runner'), { recursive: true });
  const moduleUrl = pathToFileURL(path.resolve('.pi/skills/pi-web-local-global-install/scripts/lib/mac-terminal.mjs')).href;
  fs.writeFileSync(path.join(runDir, 'runner/terminal-worker.mjs'), `import {receiveEnvironment} from ${JSON.stringify(moduleUrl)}; const p=await receiveEnvironment(process.argv[2]); if(p.env.PRIVATE_TEST!=='not-on-disk')process.exit(2); console.log('received');setInterval(()=>{},1000);`);
  const host = new MacOSHost();
  host.runtimeEnv.PRIVATE_TEST = 'not-on-disk';
  let child;
  let output = '';
  t.after(() => { child?.kill('SIGTERM'); });
  const identity = await delegateTerminal(host, { runDir }, { open: command => {
    child = cp.spawn('/bin/sh', ['-c', command], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', data => { output += data; });
  } });
  assert.equal(identity.pid, child.pid);
  for (let i = 0; i < 30 && !output.includes('received'); i++) await new Promise(r => setTimeout(r, 10));
  assert.match(output, /received/);
  const exit = once(child, 'exit');
  child.kill('SIGTERM');
  await exit;
});

test('Terminal denial and absent acknowledgement fail before any stop authority is transferred', { skip: process.platform === 'win32' }, async t => {
  const runDir = directory(t);
  const host = { runtimeEnv: {} };
  await assert.rejects(delegateTerminal(host, { runDir }, { open: () => { throw new Error('Automation denied'); } }), /Automation denied/);
  await assert.rejects(delegateTerminal(host, { runDir }, { open: () => {}, timeout: 20 }), /timed out/);
  assert.deepEqual(fs.readdirSync(runDir), []);
});

test('restart transaction does not build/install and records degraded diagnostics without stopping the newly started service', async t => {
  const root = directory(t);
  const old = { version: '1.0', buildId: 'installed-build' };
  const plan = { runDir: root, prefix: root, runtimeHome: root, old, operation: 'restart', restart: true, port: 30141, noWait: false };
  const calls = [];
  const host = {
    platform: 'darwin', runtimeEnv: { HOME: root }, prefix: () => root, installed: () => old,
    assertService: () => calls.push('identity'), preflightRestart: () => calls.push('context'),
    waitIdle: async () => calls.push('idle'), stopService: async () => calls.push('stop'),
    run: async () => { throw new Error('Must not install'); },
    verify: async (_, expected) => { assert.deepEqual(expected, old); calls.push('verify'); },
    launch: async () => { calls.push('launch'); return { pid: 123 }; },
    health: async () => ({ runtimeHealth: { status: 'degraded', checks: { dns: false } } }),
    stopNew: async () => { throw new Error('Must not stop degraded service'); },
  };
  await apply(host, plan);
  assert.ok(calls.indexOf('idle') < calls.indexOf('stop'));
  assert.ok(calls.indexOf('verify') < calls.indexOf('launch'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'status.json'))).phase, 'degraded');
});

test('delegated worker receives the prefix lease even though its parent is Terminal, not the controller', async t => {
  const root = directory(t);
  const plan = { prefix: root, runDir: root };
  const owner = { pid: 101, parentPid: 1, command: 'controller', created: 'now' };
  const worker = { pid: 202, parentPid: 999, command: 'terminal-worker', created: 'now' };
  const file = lockFile(root);
  acquireLock(file, root, owner, () => false);
  t.after(() => releaseLock(file, root, worker));
  const host = { startWorker: async () => {
    // Simulate the separate worker observing the published lease, then acknowledging it.
    const timer = setInterval(() => {
      if (JSON.parse(fs.readFileSync(file)).owner.pid === worker.pid) {
        clearInterval(timer);
        fs.writeFileSync(path.join(root, 'worker-ready.json'), '{}');
      }
    }, 5);
    t.after(() => clearInterval(timer));
    return worker;
  }, alive: () => true };
  await schedule(host, plan, owner, 90);
  assert.equal(JSON.parse(fs.readFileSync(file)).owner.pid, worker.pid);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'status.json'))).phase, 'scheduled');
  assert.ok(plan.notBefore > Date.now());
});

test('macOS refuses direct detached launch; delegated Terminal CLI remains in its process group', { skip: process.platform !== 'darwin' }, async t => {
  const root = directory(t);
  fs.mkdirSync(path.join(root, 'bin'));
  fs.writeFileSync(path.join(root, 'bin/pi-web.js'), 'setInterval(()=>{},1000)');
  const host = new MacOSHost();
  host.packageDir = () => root;
  host.listeners = () => [];
  const plan = { runDir: root, port: 30141, host: '127.0.0.1', macosLaunch: 'terminal' };
  await assert.rejects(host.launch(plan), /acknowledged Terminal/);
  host.terminalDelegated = true;
  const identity = await host.launch(plan);
  t.after(() => { try { process.kill(identity.pid); } catch {} });
  const group = pid => cp.execFileSync('/bin/ps', ['-p', String(pid), '-o', 'pgid='], { encoding: 'utf8' }).trim();
  assert.equal(group(identity.pid), group(process.pid));
  await host.kill(identity);
});

test('runtime diagnostic reader refuses missing endpoints and non-boolean health claims', async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const host = Object.create(MacOSHost.prototype);
  host.runtimeEnv = {};
  const plan = { host: '127.0.0.1', port: 30141 };
  globalThis.fetch = async () => new Response('{}', { status: 404 });
  assert.equal((await host.diagnose(plan)).status, 'unavailable');
  globalThis.fetch = async () => new Response(JSON.stringify({ checks: { user: 'true' } }));
  assert.equal((await host.diagnose(plan)).status, 'unavailable');
  globalThis.fetch = async () => new Response(JSON.stringify({ checks: { user: true, dns: true, childUser: true, childDns: true, paths: true } }));
  assert.equal((await host.diagnose(plan)).status, 'healthy');
});

test('restart plan reports the installed version, not the unbuilt checkout version', async t => {
  const root = directory(t);
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const plan = await createPlan({ platform: 'darwin', runtimeEnv: { HOME: root } }, parseArgs(['restart']), {
    repo, prefix: root, commit: 'a'.repeat(40), version: 'checkout-new', old: { version: 'installed-old', buildId: 'old-build' }, service: null,
  });
  assert.equal(plan.operation, 'restart');
  assert.equal(plan.version, 'installed-old');
  assert.equal(fs.existsSync(path.join(plan.runDir, 'build')), false);
});

test('restart source inspection tolerates dirty checkout but requires a recognized installed package', () => {
  const host = { git: (_cwd, cmd, ...args) => {
    if (cmd === 'rev-parse') return args[0] === '--show-toplevel' ? '/repo' : 'a'.repeat(40);
    if (cmd === 'status') return ' M changed';
    if (cmd === 'show') return JSON.stringify(args[0].endsWith('package.json') ? { name: PACKAGE, version: '1' } : { version: '1', packages: { '': { version: '1' } } });
    return '';
  }, prefix: () => '/prefix', installed: () => ({ version: '0', buildId: 'old' }), service: () => null };
  assert.equal(inspectSource(host, parseArgs(['restart']), '/repo').old.buildId, 'old');
  host.installed = () => null;
  assert.throws(() => inspectSource(host, parseArgs(['restart']), '/repo'), /No global/);
});
