import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import cp from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { MacOSHost, macLaunchOptions } from '../.pi/skills/pi-web-local-global-install/scripts/lib/macos-host.mjs';
import { createHost } from '../.pi/skills/pi-web-local-global-install/scripts/install-global.mjs';
import { PACKAGE, parseArgs, buildEnvironment, hashFile, readJson, commandEnvironment } from '../.pi/skills/pi-web-local-global-install/scripts/lib/policy.mjs';
import { apply, inspectSource, runtimeHome, createPlan } from '../.pi/skills/pi-web-local-global-install/scripts/lib/workflow.mjs';

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-web-macos-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function serviceFixture(t) {
  const prefix = path.join(temporary(t), 'prefix with spaces');
  const pkg = path.join(prefix, 'lib/node_modules', PACKAGE);
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(prefix, 'bin'));
  const cli = path.join(pkg, 'bin/pi-web.js');
  fs.writeFileSync(cli, 'fixture');
  fs.symlinkSync(cli, path.join(prefix, 'bin/pi-web'));
  const server = { pid: 222, parentPid: 111, command: 'next-server (fixture)', created: 'server' };
  const launcher = { pid: 111, parentPid: 1, command: 'node launcher with spaces', created: 'launcher' };
  const host = Object.create(MacOSHost.prototype);
  host.listeners = () => [server.pid];
  host.processInfo = pid => pid === server.pid ? server : pid === launcher.pid ? launcher : null;
  host.processCwd = () => fs.realpathSync(pkg);
  let environmentReads = 0;
  host.processDetails = (pid, environment) => {
    if (pid === server.pid) return { argv: ['next-server (fixture)'] };
    if (environment) environmentReads++;
    return { executable: process.execPath, argv: ['node', path.join(prefix, 'bin/pi-web'), '--port=30141', '-H', '::1', '--no-open'],
      ...(environment ? { env: { HOME: '/fixture/home with spaces', PI_WEB_PASSWORD: 'fixture-only-secret', NODE_OPTIONS: '--use-system-ca' } } : {}) };
  };
  return { host, prefix, pkg, server, launcher, environmentReads: () => environmentReads };
}

test('macOS launch parsing preserves hostname/port and supports env defaults without ps tokenization', () => {
  assert.deepEqual(macLaunchOptions(['-p', '30142', '--hostname=0.0.0.0', '--no-open']), { port: 30142, host: '0.0.0.0' });
  assert.deepEqual(macLaunchOptions([], { PORT: '30143', PI_WEB_HOSTNAME: '::1' }), { port: 30143, host: '::1' });
  assert.throws(() => macLaunchOptions(['--port', '0']));
  assert.throws(() => macLaunchOptions(['--unknown']));
  assert.throws(() => createHost({}, 'linux'), /Windows and macOS only/);
});

test('no-wait requires explicit restart and build-only agent directory never reaches runtime', () => {
  assert.throws(() => parseArgs(['run', '--no-wait']), /requires --restart/);
  assert.equal(parseArgs(['run', '--restart', '--no-wait']).noWait, true);
  assert.equal(parseArgs(['resume', '--run-dir', '/fixture', '--restart', '--no-wait']).noWait, true);
  assert.throws(() => parseArgs(['status', '--no-wait']), /Unsupported/);
  const env = { HOME: '/real', PI_CODING_AGENT_DIR: '/real/private-agent' };
  assert.equal(buildEnvironment(env, '/build-run', 4096).PI_CODING_AGENT_DIR, path.join('/build-run/build-home/.pi/agent'));
  assert.equal(env.PI_CODING_AGENT_DIR, '/real/private-agent');
  assert.equal(runtimeHome({ platform: 'win32', runtimeEnv: { HOME: '/git-bash/home', USERPROFILE: 'C:\\Users\\fixture' } }), 'C:\\Users\\fixture');
  assert.equal(runtimeHome({ platform: 'darwin', runtimeEnv: { HOME: '/original/mac-home' } }), '/original/mac-home');
});

test('macOS discovers lib/node_modules, symlinked launchers and paths with spaces without logging credentials', { skip: process.platform === 'win32' }, t => {
  const fixture = serviceFixture(t);
  const { host, prefix, server, launcher } = fixture;
  const service = host.service(prefix, 30141);
  assert.deepEqual(service, { server, launcher, host: '::1' });
  assert.equal(fixture.environmentReads(), 1);
  assert.equal(host.runtimeEnv.HOME, '/fixture/home with spaces');
  assert.equal(host.runtimeEnv.NODE_OPTIONS, '--use-system-ca');
  assert.equal(host.runtimeEnv.PI_WEB_PASSWORD, 'fixture-only-secret');
  assert.equal(JSON.stringify(service).includes('fixture-only-secret'), false);
});

test('macOS refuses unrelated cwd, non-Pi launchers, multiple listeners and identity races', { skip: process.platform === 'win32' }, t => {
  for (const cause of ['cwd', 'launcher', 'multiple', 'race']) {
    const fixture = serviceFixture(t);
    const { host, prefix } = fixture;
    if (cause === 'cwd') host.processCwd = () => '/not/the/package';
    if (cause === 'launcher') host.processDetails = () => ({ executable: process.execPath, argv: ['node', '/unrelated.js'] });
    if (cause === 'multiple') host.listeners = () => [111, 222];
    if (cause === 'race') {
      let reads = 0;
      const inspect = host.processInfo;
      host.processInfo = pid => ++reads > 2 ? { ...inspect(pid), created: 'reused' } : inspect(pid);
    }
    assert.throws(() => host.service(prefix, 30141));
    if (cause !== 'race') assert.equal(fixture.environmentReads(), 0);
  }
});

function overwriteFixture(t, noWait, failure) {
  const root = temporary(t);
  const artifact = { file: path.join(root, 'new.tgz'), version: '1.0.0', buildId: 'new-build' };
  fs.writeFileSync(artifact.file, 'verified new package');
  artifact.sha256 = hashFile(artifact.file);
  const plan = { runDir: root, prefix: '/fixture/prefix', commit: 'a'.repeat(40), version: artifact.version, runtimeHome: os.homedir(),
    artifact, old: { version: '0.9.0', buildId: 'old-build' }, restart: true, noWait, port: 30141,
    service: { server: { pid: 1 }, launcher: { pid: 2 } } };
  const calls = [];
  const host = {
    prefix: () => plan.prefix, installed: () => plan.old, assertService() {}, npmCli: 'npm-cli', log() {},
    waitIdle: async () => calls.push('idle'), kill: async identity => calls.push(`stop:${identity.pid}`), waitFree: async () => calls.push('free'),
    async run(_cmd, args) { calls.push('install'); assert.equal(args.includes(artifact.file), true); if (failure === 'install') throw new Error('install failed'); },
    verify: async () => { calls.push('verify'); if (failure === 'verify') throw new Error('verify failed'); },
    launch: async (_plan, onSpawn) => { calls.push('launch'); const process = { pid: 3 }; onSpawn(process); if (failure === 'launch') throw new Error('launch failed'); return process; },
    health: async () => { calls.push('health'); if (failure === 'health') throw new Error('health failed'); return { server: { pid: 4 } }; },
    stopNew: async () => calls.push('cleanup'),
    npm() { throw new Error('Must never pack the old package'); },
  };
  return { host, plan, calls };
}

test('direct overwrite installs only the new archive; no-wait alone skips idle probing', async t => {
  for (const noWait of [false, true]) {
    const { host, plan, calls } = overwriteFixture(t, noWait);
    await apply(host, plan);
    assert.equal(calls.includes('idle'), !noWait);
    assert.equal(calls.filter(call => call === 'install').length, 1);
    assert.equal(readJson(path.join(plan.runDir, 'status.json')).phase, 'verified');
    assert.equal(plan.fallback, undefined);
    assert.equal(fs.existsSync(path.join(plan.runDir, 'fallback')), false);
  }
});

test('interrupted install/verify/start failures never restore an old archive or report success', async t => {
  for (const failure of ['install', 'verify', 'launch', 'health']) {
    const { host, plan, calls } = overwriteFixture(t, true, failure);
    await assert.rejects(apply(host, plan), new RegExp(failure));
    assert.equal(calls.filter(call => call === 'install').length, 1);
    assert.equal(calls.at(-1), 'cleanup');
    assert.equal(readJson(path.join(plan.runDir, 'status.json')).phase, 'recovery_required');
    assert.equal(plan.fallback, undefined);
  }
});

test('macOS plan copies the independent runner and never creates a fallback directory', async t => {
  const root = temporary(t);
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const host = { platform: 'darwin', runtimeEnv: { HOME: '/fixture/home', PI_WEB_PASSWORD: 'fixture-private' }, env: {} };
  const plan = await createPlan(host, parseArgs(['run', '--restart', '--no-wait']), {
    repo, commit: 'a'.repeat(40), version: '1.0.0', prefix: path.join(root, 'prefix'), old: { version: '0.9.0', buildId: 'old' }, service: null,
  });
  assert.equal(plan.platform, 'darwin');
  assert.equal(plan.noWait, true);
  assert.equal(plan.overwriteOnly, true);
  assert.equal(plan.runtimeHome, '/fixture/home');
  assert.equal(fs.existsSync(path.join(plan.runDir, 'fallback')), false);
  assert.equal(fs.existsSync(path.join(plan.runDir, 'runner/lib/mac-process.py')), true);
  assert.equal(fs.existsSync(path.join(plan.runDir, 'runner/lib/local-host.mjs')), true);
  assert.equal(fs.readFileSync(path.join(plan.runDir, 'plan.json'), 'utf8').includes('fixture-private'), false);
});

test('self-hosted immediate cutover is allowed only with explicit no-wait authorization', () => {
  const host = { git(_repo, ...args) {
    if (args[0] === 'show') return JSON.stringify(args[1].endsWith(':package.json') ? { name: PACKAGE, version: '1' } : { version: '1', packages: { '': { version: '1' } } });
    if (args[0] === 'status') return '';
    if (args[1] === '--verify') return 'a'.repeat(40);
    if (args[1] === '--show-toplevel') return '/repo';
    return '';
  }, prefix: () => '/prefix', installed: () => null, service: () => ({ server: {}, launcher: {} }), hostsCurrentProcess: () => true };
  assert.throws(() => inspectSource(host, parseArgs(['run', '--restart'])), /--no-wait/);
  assert.equal(inspectSource(host, parseArgs(['run', '--restart', '--no-wait'])).requiresDefer, true);
});

test('native macOS inspection preserves private environment only in memory and refuses reused PID', { skip: process.platform !== 'darwin' }, async t => {
  const host = new MacOSHost();
  const child = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: commandEnvironment({ ...process.env, INSTALLER_FIXTURE_SECRET: 'fixture value with spaces' }), stdio: 'ignore' });
  await once(child, 'spawn');
  t.after(() => { try { child.kill(); } catch { /* Already exited. */ } });
  const identity = host.processInfo(child.pid);
  const details = host.processDetails(child.pid, true);
  assert.equal(identity.parentPid, process.pid);
  assert.equal(details.env.INSTALLER_FIXTURE_SECRET, 'fixture value with spaces');
  assert.equal(details.argv.includes('-e'), true);
  await assert.rejects(host.kill({ ...identity, created: 'reused' }), /reused or changed/);
  assert.equal(host.alive(identity), true);
  await host.kill(identity);
  assert.equal(host.processInfo(child.pid), null);
});
