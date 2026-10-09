import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import {
  PACKAGE, parseArgs, commandEnvironment, restartEnvironment, workerEnvironment, buildEnvironment, sameProcess, inspectPack, assertVersions,
  atomicJson, readJson, acquireLock, releaseLock, handoffLock, lockKey, hashFile, validatePlan,
  assertArtifact, assertBuildOwned, cutoverTransaction,
} from '../.pi/skills/pi-web-local-global-install/scripts/lib/policy.mjs';
import { WindowsHost } from '../.pi/skills/pi-web-local-global-install/scripts/lib/host.mjs';
import { inspectSource, prepare, execute, apply, worker, runsRoot, lockFile, copyRunnerDependencies, ensureRunnerDependencies, recordFailure, markInterrupted, state } from '../.pi/skills/pi-web-local-global-install/scripts/lib/workflow.mjs';
import { createRequire } from 'node:module';
import { main } from '../.pi/skills/pi-web-local-global-install/scripts/install-global.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-web-installer-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const runDir = path.join(root, 'run');
  fs.mkdirSync(repo); fs.mkdirSync(runDir);
  const owner = { pid: 123, parentPid: 1, created: 'original', command: 'installer' };
  const plan = { schema: 1, package: PACKAGE, repo, runDir, commit: 'a'.repeat(40), version: '1.0.0', prefix: path.join(root, 'npm'), port: 30141, heapMb: 4096 };
  return { root, repo, runDir, owner, plan };
}
const packInfo = (version = '1.0.0') => [{ name: PACKAGE, version, filename: 'agegr-pi-web-1.0.0.tgz', files: [
  'package.json', 'bin/pi-web.js', '.next/BUILD_ID', '.next/server/app.js', '.next/static/app.js', '.next/diagnostics/framework.json',
].map(path => ({ path })) }];

test('CLI requires explicit restart/defer authorization and bounded options', () => {
  assert.equal(parseArgs(['--help']).command, 'help');
  assert.deepEqual(parseArgs(['run', '--restart', '--defer', '90']).defer, 90);
  for (const args of [['run', '--defer', '90'], ['run', '--heap-mb', '999999'], ['run', '--port', '0'], ['run', '--force'], ['resume'], ['run', '--commit']]) assert.throws(() => parseArgs(args));
  const opts = parseArgs(['run', '--skip-tests-reason', 'Known symlink EPERM']);
  assert.equal(opts.skipTests, true);
  assert.throws(() => parseArgs(['run', '--skip-tests-reason', ' ']));
});

test('build environment isolates home/temp without mutating real runtime credentials or home', () => {
  const original = { HOME: 'real-home', USERPROFILE: 'real-home', TMP: 'real-temp', TAPSVC_API_KEY: 'dummy-secret', NODE_OPTIONS: '--require ./relative', TURBOPACK: '1' };
  const runtime = commandEnvironment(original);
  const build = buildEnvironment(original, path.resolve('run'), 4096);
  assert.equal(runtime.HOME, 'real-home');
  assert.equal(runtime.TAPSVC_API_KEY, 'dummy-secret');
  assert.equal(runtime.NODE_OPTIONS, undefined);
  assert.equal(runtime.TURBOPACK, undefined);
  assert.equal(build.HOME, path.resolve('run/build-home'));
  assert.equal(build.TEMP, process.platform === 'win32' ? path.resolve('run/build-temp') : os.tmpdir());
  assert.equal(build.TMP, build.TEMP);
  assert.equal(build.TMPDIR, build.TEMP);
  assert.equal(build.USERPROFILE, build.HOME);
  assert.equal(build.NODE_OPTIONS, '--max-old-space-size=4096');
  assert.equal(original.NODE_OPTIONS, '--require ./relative');
});

test('Windows build temp stays outside the original profile even for a checkout under that profile', () => {
  const original = { USERPROFILE: 'C:\\Users\\fixture', HOME: 'C:\\Users\\fixture', SystemRoot: 'C:\\Windows' };
  const external = buildEnvironment(original, 'E:\\installs\\unique-run', 4096, 'win32');
  assert.equal(external.TEMP, 'E:\\installs\\unique-run\\build-temp');
  const nested = buildEnvironment(original, 'C:\\Users\\fixture\\repo-installs\\unique-run', 4096, 'win32');
  assert.equal(nested.TEMP, 'C:\\Windows\\Temp\\pi-web-build\\unique-run');
  assert.equal(nested.TMP, nested.TEMP);
  assert.equal(nested.TMPDIR, nested.TEMP);
  assert.equal(original.USERPROFILE, 'C:\\Users\\fixture');
  assert.equal(buildEnvironment(original, '/external/run', 4096, 'darwin').TEMP, os.tmpdir());
});

test('archive manifest requires real production assets and rejects development caches/secrets, not Next diagnostics', () => {
  assert.equal(inspectPack(packInfo(), '1.0.0').version, '1.0.0');
  for (const extra of ['.env', '.env.local', '.next/dev/server.js', '.next/cache/file', 'debug.log']) {
    const p = packInfo(); p[0].files.push({ path: extra });
    assert.throws(() => inspectPack(p, '1.0.0'));
  }
  const p = packInfo(); p[0].filename = '../unsafe.tgz';
  assert.throws(() => inspectPack(p, '1.0.0'));
  assert.throws(() => inspectPack(packInfo('2.0.0'), '1.0.0'));
  assert.throws(() => inspectPack([{ ...packInfo()[0], files: [] }], '1.0.0'));
  assert.throws(() => assertVersions({ name: PACKAGE, version: '1' }, { version: '1', packages: { '': { version: '2' } } }));
});

test('prefix-level lock rejects other runs and live owners; only same-run explicit resume recovers abandoned lock', t => {
  const { root, runDir, owner } = fixture(t);
  const file = path.join(root, 'lock.json');
  acquireLock(file, runDir, owner, () => true);
  assert.throws(() => acquireLock(file, path.join(root, 'other'), owner, () => false));
  assert.throws(() => acquireLock(file, runDir, owner, () => true, true));
  assert.throws(() => acquireLock(file, runDir, owner, () => false));
  const next = { ...owner, pid: 456 };
  acquireLock(file, runDir, next, () => false, true);
  releaseLock(file, runDir, owner);
  assert.equal(readJson(file).owner.pid, 456);
  releaseLock(file, runDir, next);
  assert.equal(fs.existsSync(file), false);
  assert.equal(lockKey(path.resolve('prefix')), lockKey(path.resolve('prefix')));
  assert.notEqual(lockKey(path.resolve('prefix')), lockKey(path.resolve('other-prefix')));
});

test('worker handoff preserves the lock across controller exit and cannot be stolen by another installer', t => {
  const { root, runDir, owner } = fixture(t);
  const file = path.join(root, 'lock.json');
  const worker = { ...owner, pid: 456, parentPid: owner.pid };
  acquireLock(file, runDir, owner, () => true);
  assert.throws(() => handoffLock(file, runDir, { ...owner, created: 'reused' }, worker));
  handoffLock(file, runDir, owner, worker);
  releaseLock(file, runDir, owner);
  assert.equal(readJson(file).owner.pid, worker.pid);
  assert.throws(() => acquireLock(file, runDir, owner, () => true, true));
  releaseLock(file, runDir, worker);
});

test('lease publication is a complete rename; a corrupt lease fails closed', t => {
  const { root, runDir, owner } = fixture(t);
  const file = path.join(root, 'lock.json');
  const published = [];
  const original = fs.renameSync;
  fs.renameSync = (from, to) => { published.push(fs.readFileSync(from, 'utf8')); original(from, to); };
  try { acquireLock(file, runDir, owner, () => true); } finally { fs.renameSync = original; }
  assert.equal(JSON.parse(published[0]).runDir, runDir);
  assert.deepEqual(readJson(file).owner, owner);
  fs.writeFileSync(file, '{truncated');
  assert.throws(() => acquireLock(file, runDir, { ...owner, pid: 456 }, () => false, true), /Corrupt lease/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{truncated');
});

test('a mutation guard abandoned by a crash expires and explicit resume can recover it', t => {
  const { root, runDir, owner } = fixture(t);
  const file = path.join(root, 'lock.json');
  atomicJson(file, { runDir, owner });
  fs.mkdirSync(`${file}.guard`);
  const past = new Date(Date.now() - 130_000);
  fs.utimesSync(`${file}.guard`, past, past);
  const next = { ...owner, pid: 456 };
  acquireLock(file, runDir, next, () => false, true);
  assert.equal(readJson(file).owner.pid, next.pid);
  releaseLock(file, runDir, next);
});

test('process identity includes creation time, command and parent, not only PID', t => {
  const { owner } = fixture(t);
  assert.equal(sameProcess(owner, { ...owner }), true);
  for (const changed of [{ created: 'recycled' }, { parentPid: 9 }, { command: 'other' }]) assert.equal(sameProcess(owner, { ...owner, ...changed }), false);
});

test('plan and cleanup validation refuse wrong repo/root/commit/artifact paths', t => {
  const { repo, runDir, plan } = fixture(t);
  assert.equal(validatePlan(plan, runDir), plan);
  assert.throws(() => validatePlan({ ...plan, runDir: repo }, repo));
  assert.throws(() => validatePlan({ ...plan, artifact: { file: path.join(repo, 'a.tgz'), sha256: 'a'.repeat(64), version: '1', buildId: 'x' } }, runDir));
  assertBuildOwned(plan, path.join(runDir, 'build'), plan.commit, path.join(runDir, 'build'));
  assert.throws(() => assertBuildOwned(plan, repo, plan.commit, repo));
  assert.throws(() => assertBuildOwned(plan, path.join(runDir, 'build'), 'b'.repeat(40), path.join(runDir, 'build')));
});

test('artifact identity detects same-version different content and corruption', t => {
  const { root } = fixture(t);
  const file = path.join(root, 'a.tgz'); fs.writeFileSync(file, 'archive');
  const artifact = { file, sha256: hashFile(file) };
  assertArtifact(artifact);
  fs.writeFileSync(file, 'different build, same version');
  assert.throws(() => assertArtifact(artifact), /integrity/);
});

function actions(failure) {
  const calls = [];
  let preflights = 0;
  const invoke = async name => { calls.push(name); if (failure === name) throw new Error(name); };
  return { calls, hooks: {
    preflight: async () => invoke(`preflight-${++preflights}`), idle: () => invoke('idle'),
    stop: async mark => { await invoke('stop'); mark(); if (failure === 'partial-stop') throw new Error('partial-stop'); },
    install: () => invoke('install'), verify: () => invoke('verify'),
    launch: async () => { await invoke('launch'); return 'new-launcher'; },
    health: () => invoke('health'), success: () => invoke('success'),
    failure: async (error, launcher) => { calls.push(`failure:${error.message}:${launcher ?? 'none'}`); },
  } };
}

test('transaction checks idle and identity before stopping, then verifies before success', async () => {
  const { calls, hooks } = actions();
  await cutoverTransaction(hooks);
  assert.deepEqual(calls, ['preflight-1', 'idle', 'preflight-2', 'stop', 'install', 'verify', 'launch', 'health', 'success']);
});

test('pre-interruption failures never install; interrupted failures report recovery without reinstalling', async () => {
  for (const failure of ['preflight-1', 'idle', 'preflight-2', 'stop']) {
    const { calls, hooks } = actions(failure);
    await assert.rejects(cutoverTransaction(hooks));
    assert.equal(calls.some(c => c.startsWith('failure')), false);
    assert.equal(calls.includes('install'), false);
  }
  for (const failure of ['partial-stop', 'install', 'verify', 'launch', 'health']) {
    const { calls, hooks } = actions(failure);
    await assert.rejects(cutoverTransaction(hooks), new RegExp(failure));
    assert.equal(calls.at(-1).startsWith(`failure:${failure}`), true);
    assert.equal(calls.filter(call => call === 'install').length <= 1, true);
    assert.equal(calls.includes('success'), false);
  }
});

test('password-protected idle/health probes use the application fixed pi Basic Auth username', () => {
  const host = Object.create(WindowsHost.prototype);
  host.runtimeEnv = { PI_WEB_PASSWORD: 'fixture-password' };
  assert.equal(Buffer.from(host.requestOptions().headers.Authorization.slice(6), 'base64').toString(), 'pi:fixture-password');
  assert.equal(host.url('0.0.0.0', 30141), 'http://127.0.0.1:30141');
  assert.equal(host.url('::1', 30141), 'http://[::1]:30141');
});

test('dry-run reports dirty source; real run refuses it; status indexes are repository-specific', () => {
  const host = {
    git(_repo, ...args) {
      if (args[0] === 'status') return ' M tracked.ts';
      if (args[0] === 'show') return JSON.stringify(args[1].endsWith('package.json') ? { name: PACKAGE, version: '1' } : { version: '1', packages: { '': { version: '1' } } });
      if (args[1] === '--show-toplevel') return path.resolve('repo');
      if (args[1] === '--verify') return 'a'.repeat(40);
      return 'ignored.log';
    }, prefix: () => path.resolve('npm'), installed: () => null, service: () => null, hostsCurrentProcess: () => false,
  };
  assert.throws(() => inspectSource(host, parseArgs(['run'])), /uncommitted/);
  assert.match(inspectSource(host, parseArgs(['run', '--dry-run'])).trackedChanges, /tracked/);
  assert.match(inspectSource(host, parseArgs(['run', '--allow-dirty'])).trackedChanges, /tracked/);
  assert.notEqual(runsRoot(path.resolve('repo-a')), runsRoot(path.resolve('repo-b')));
});

function fakeBuildHost(plan, failBuild = false) {
  const calls = [];
  const host = {
    env: { HOME: 'runtime-home', USERPROFILE: 'runtime-home' }, npmCli: 'npm-cli', tar: 'tar', calls,
    log: () => {},
    git(_repo, ...args) {
      if (args[0] === 'worktree' && args[1] === 'add') fs.mkdirSync(path.join(plan.runDir, 'build'));
      return '';
    },
    async run(_cmd, args, opts) {
      calls.push({ args, opts });
      if (opts.env) {
        assert.ok(fs.statSync(opts.env.HOME).isDirectory(), 'isolated HOME exists before checks');
        assert.ok(fs.statSync(opts.env.TEMP).isDirectory(), 'isolated TEMP exists before checks');
      }
      if (args.includes('build')) {
        if (failBuild) throw new Error('build failed');
        fs.mkdirSync(path.join(opts.cwd, '.next'));
        fs.writeFileSync(path.join(opts.cwd, '.next/BUILD_ID'), 'fixture-build');
      }
    },
    npm(args) {
      if (args.includes('--pack-destination')) fs.writeFileSync(path.join(plan.runDir, 'archives/agegr-pi-web-1.0.0.tgz'), 'fixture archive');
      return JSON.stringify(packInfo());
    },
    capture(_cmd, args) { return args.at(-1).endsWith('BUILD_ID') ? 'fixture-build' : JSON.stringify({ name: PACKAGE, version: plan.version }); },
  };
  return host;
}

test('prepare uses separate dependencies and build-only home; repeated preparation reuses only verified archive', async t => {
  const { plan, repo } = fixture(t);
  fs.mkdirSync(path.join(plan.runDir, 'archives'));
  fs.mkdirSync(path.join(repo, '.next')); fs.writeFileSync(path.join(repo, '.next/dev-sentinel'), 'untouched');
  const host = fakeBuildHost(plan);
  await prepare(host, plan);
  assert.equal(host.calls.length, 4); // npm ci, typecheck, tests, build
  assert.ok(host.calls[0].args.includes('--include=dev'));
  assert.equal(host.calls[0].opts.env, undefined); // real host env supplies npm configuration
  assert.equal(host.calls.at(-1).opts.env.HOME, path.join(plan.runDir, 'build-home'));
  assert.equal(host.calls.at(-1).opts.cwd, path.join(plan.runDir, 'build'));
  assert.equal(readJson(path.join(plan.runDir, 'status.json')).phase, 'packed');
  await prepare(host, plan);
  assert.equal(host.calls.length, 4);
  assert.equal(fs.readFileSync(path.join(repo, '.next/dev-sentinel'), 'utf8'), 'untouched');
});

test('a failed build cannot pack old artifacts or mutate the global installation', async t => {
  const { plan } = fixture(t);
  fs.mkdirSync(path.join(plan.runDir, 'archives'));
  const host = fakeBuildHost(plan, true);
  await assert.rejects(prepare(host, plan), /build failed/);
  assert.equal(plan.artifact, undefined);
  assert.deepEqual(fs.readdirSync(path.join(plan.runDir, 'archives')), []);
  assert.equal(host.calls.some(c => c.args.includes('-g')), false);
});

test('resume refuses interrupted cutover and does not relabel it as a harmless pre-install failure', async t => {
  const { plan, owner } = fixture(t);
  atomicJson(path.join(plan.runDir, 'status.json'), { phase: 'installing' });
  const host = { processInfo: () => owner, alive: () => false };
  await assert.rejects(execute(host, plan, parseArgs(['resume', '--run-dir', plan.runDir]), true), /manual recovery/);
  assert.equal(readJson(path.join(plan.runDir, 'status.json')).phase, 'installing');
});

test('worker and in-memory interruption keep cutover phases when status writes fail', t => {
  const { plan } = fixture(t);
  for (const phase of ['stopping', 'installing', 'starting', 'rolling_back']) {
    state(plan, phase);
    recordFailure(plan, new Error('worker exploded'));
    assert.equal(readJson(path.join(plan.runDir, 'status.json')).phase, phase);
  }
  state(plan, 'packed');
  markInterrupted(plan);
  const writes = [];
  recordFailure(plan, new Error('status disk full'), {
    read: () => { throw new Error('missing status'); },
    write: () => { throw new Error('disk full'); },
  });
  recordFailure(plan, new Error('recorded'), {
    read: () => { throw new Error('missing status'); },
    write: (current, phase) => writes.push(phase),
  });
  assert.deepEqual(writes, ['recovery_required']);
  assert.equal(readJson(path.join(plan.runDir, 'status.json')).phase, 'packed');
});

test('worker preserves interrupted overwrite risk when recovery status cannot be written', async t => {
  const { plan, owner } = fixture(t);
  const artifact = { file: path.join(plan.runDir, 'archives/new.tgz'), version: plan.version, buildId: 'new-build' };
  fs.mkdirSync(path.dirname(artifact.file), { recursive: true });
  fs.writeFileSync(artifact.file, 'new archive');
  artifact.sha256 = hashFile(artifact.file);
  const saved = { ...plan, runtimeHome: os.homedir(), worker: owner, notBefore: Date.now() - 1000, artifact, old: { version: '0.9.0', buildId: 'old-build' } };
  atomicJson(path.join(plan.runDir, 'plan.json'), saved);
  atomicJson(path.join(plan.runDir, 'status.json'), { phase: 'packed' });
  acquireLock(lockFile(plan.prefix), plan.runDir, owner, () => true);
  const host = {
    processInfo: () => owner,
    alive: () => true,
    log: () => {},
    prefix: () => plan.prefix,
    installed: () => saved.old,
    service: () => null,
    assertService: () => {},
    waitIdle: async () => {},
    kill: () => {},
    waitFree: async () => {},
    stopNew: async () => {},
    async run() { throw new Error('replacement install failed'); },
  };
  const original = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (path.basename(to) === 'status.json' && fs.readFileSync(from, 'utf8').includes('recovery_required')) throw new Error('status disk full');
    original(from, to);
  };
  try { await assert.rejects(worker(host, plan.runDir), /replacement install failed/); }
  finally { fs.renameSync = original; }
  assert.equal(readJson(path.join(plan.runDir, 'status.json')).phase, 'installing');
  assert.equal(fs.existsSync(path.join(plan.runDir, 'fallback')), false);
});

test('CLI awaits asynchronous plan preparation before execution, and stops on preparation failure', async t => {
  const { plan } = fixture(t);
  const host = {
    git(_repo, ...args) {
      if (args[0] === 'show') return JSON.stringify(args[1].endsWith(':package.json')
        ? { name: PACKAGE, version: plan.version }
        : { version: plan.version, packages: { '': { version: plan.version } } });
      if (args[1] === '--show-toplevel') return plan.repo;
      if (args[1] === '--verify') return plan.commit;
      return '';
    },
    prefix: () => plan.prefix, installed: () => null, service: () => null,
    hostsCurrentProcess: () => false,
  };
  let ready = false;
  let executions = 0;
  const executePlan = async (_host, current) => {
    assert.equal(ready, true);
    assert.equal(current, plan);
    assert.equal(host.logFile, path.join(plan.runDir, 'run.log'));
    executions++;
    state(plan, 'verified');
  };
  await main(['run'], {
    host,
    createPlan: async () => { await new Promise(resolve => setImmediate(resolve)); ready = true; return plan; },
    execute: executePlan,
  });
  assert.equal(executions, 1);
  await assert.rejects(main(['run'], {
    host,
    createPlan: async () => { await new Promise(resolve => setImmediate(resolve)); throw new Error('bootstrap failed'); },
    execute: executePlan,
  }), /bootstrap failed/);
  assert.equal(executions, 1);
});

test('actual apply does not roll back before stop, and preserves in-memory risk when stopping status cannot be written', async t => {
  const { plan } = fixture(t);
  const archive = path.join(plan.runDir, 'new.tgz');
  fs.writeFileSync(archive, 'fixture');
  Object.assign(plan, {
    runtimeHome: os.homedir(), old: null, restart: true,
    service: { server: { pid: 1 }, launcher: { pid: 2 } },
    artifact: { file: archive, sha256: hashFile(archive), version: plan.version, buildId: 'fixture-build' },
  });
  state(plan, 'packed');
  const forbidden = [];
  const host = {
    prefix: () => plan.prefix, installed: () => null, assertService: () => {}, waitIdle: async () => {},
    kill: () => forbidden.push('kill'), stopNew: async () => forbidden.push('rollback'),
    run: async () => forbidden.push('install'), log: () => {},
  };
  const original = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (path.basename(to) === 'status.json' && JSON.parse(fs.readFileSync(from, 'utf8')).phase === 'stopping') throw new Error('stopping status failed');
    return original(from, to);
  };
  try { await assert.rejects(apply(host, plan), /stopping status failed/); }
  finally { fs.renameSync = original; }
  assert.deepEqual(forbidden, []);
  assert.equal(readJson(path.join(plan.runDir, 'status.json')).phase, 'packed');
  recordFailure(plan, new Error('stopping status failed'));
  assert.equal(readJson(path.join(plan.runDir, 'status.json')).phase, 'recovery_required');
});

test('unsupported dry-run on resume is rejected rather than silently executing installation', () => {
  assert.throws(() => parseArgs(['resume', '--run-dir', 'example', '--dry-run']), /Unsupported/);
  assert.throws(() => parseArgs(['status', '--restart']), /Unsupported/);
});

test('runtime Node options survive detached handoff while updater startup stays sanitized', () => {
  const original = { HOME: 'real-home', NODE_OPTIONS: '--require ./bin/stdio-guard.js --use-system-ca', TURBOPACK: '1', TAPSVC_API_KEY: 'fixture-secret' };
  const worker = workerEnvironment(original);
  assert.equal(worker.NODE_OPTIONS, '');
  assert.deepEqual(restartEnvironment(worker), original);
  assert.equal(commandEnvironment(original).NODE_OPTIONS, undefined);
  assert.equal(original.NODE_OPTIONS, '--require ./bin/stdio-guard.js --use-system-ca');
});

test('global lock is stored under canonical prefix, not caller TEMP or the checkout', t => {
  const { plan } = fixture(t);
  const before = lockFile(plan.prefix);
  assert.equal(path.dirname(before), path.join(fs.realpathSync(path.dirname(plan.prefix)), path.basename(plan.prefix), '.pi-web-installer'));
  fs.mkdirSync(plan.prefix);
  assert.equal(lockFile(plan.prefix), before, 'creating the prefix must not change lease identity');
  assert.equal(path.dirname(lockFile(plan.prefix)), path.join(fs.realpathSync(plan.prefix), '.pi-web-installer'));
});

test('prefix locking uses the runner copy and ignores a checkout without node_modules', async t => {
  const { plan, owner } = fixture(t);
  plan.runtimeHome = os.homedir();
  fs.mkdirSync(plan.prefix, { recursive: true });
  const runner = path.join(plan.runDir, 'runner', 'node_modules', 'proper-lockfile');
  fs.mkdirSync(runner, { recursive: true });
  fs.writeFileSync(path.join(runner, 'package.json'), JSON.stringify({ name: 'proper-lockfile', version: '4.1.2', main: 'index.js' }));
  fs.writeFileSync(path.join(runner, 'index.js'), 'module.exports.lockSync = file => { require("node:fs").writeFileSync(file + ".runner", "1"); return () => require("node:fs").rmSync(file + ".runner", { force: true }); };\n');
  const host = {
    processInfo: () => owner,
    alive: () => false,
    prefix: () => plan.prefix,
    installed: () => { throw new Error('stop before mutation'); },
    service: () => null,
  };
  await assert.rejects(execute(host, plan, parseArgs(['run', '--restart'])), /stop before mutation/);
  assert.equal(fs.existsSync(lockFile(plan.prefix)), false);
  assert.equal(fs.existsSync(`${lockFile(plan.prefix)}.runner`), false);
});

test('a checkout without node_modules bootstraps only the pinned guard into the runner', async t => {
  const { runDir } = fixture(t);
  const installs = [];
  const host = {
    npmCli: 'npm-cli',
    async run(command, args) {
      installs.push(args);
      assert.equal(command, process.execPath);
      const prefix = args[args.indexOf('--prefix') + 1];
      const target = path.join(prefix, 'node_modules', 'proper-lockfile');
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name: 'proper-lockfile', version: '4.1.2', main: 'index.js' }));
      fs.writeFileSync(path.join(target, 'index.js'), 'module.exports = { lockSync() { return () => {}; } };');
    },
  };
  await ensureRunnerDependencies(host, runDir, () => { const error = new Error('missing'); error.code = 'MODULE_NOT_FOUND'; throw error; });
  assert.equal(installs.length, 1);
  assert.deepEqual(installs[0].slice(1, 8), ['install', '--prefix', runDir, '--no-save', '--package-lock=false', '--ignore-scripts', '--no-audit']);
  assert.equal(installs[0].at(-1), 'proper-lockfile@4.1.2');
  const require = createRequire(path.join(runDir, 'entry.mjs'));
  assert.equal(typeof require('proper-lockfile').lockSync, 'function');
  await ensureRunnerDependencies(host, runDir, () => { throw new Error('must not copy twice'); });
  assert.equal(installs.length, 1);
});

test('detached runner copies its locking dependencies instead of importing the replaceable global package', t => {
  const { runDir } = fixture(t);
  copyRunnerDependencies(runDir);
  const require = createRequire(path.join(runDir, 'entry.mjs'));
  assert.ok(require.resolve('proper-lockfile').startsWith(fs.realpathSync(runDir) + path.sep));
  const copied = require('proper-lockfile');
  const release = copied.lockSync(path.join(runDir, 'test-lock'), { realpath: false });
  release();
});

test('failure cleanup stops the verified startup tree even when no child has opened the port', async () => {
  const launcher = { pid: 123, parentPid: 1, command: 'launcher', created: 'original' };
  const child = { pid: 456, parentPid: 123, command: 'next', created: 'child' };
  let stopped = false;
  let waited = false;
  const host = Object.create(WindowsHost.prototype);
  host.processInfo = pid => pid === launcher.pid ? launcher : child;
  host.ps = () => '[456]';
  host.alive = () => !stopped;
  host.run = async (command, args) => {
    assert.equal(command, 'taskkill.exe');
    assert.deepEqual(args, ['/PID', '123', '/T', '/F']);
    stopped = true;
  };
  host.waitFree = async () => { assert.equal(stopped, true); waited = true; };
  await host.stopNew({ port: 30141 }, launcher);
  assert.equal(waited, true);
});

test('failure cleanup refuses uncertain startup ownership or child termination', async () => {
  const host = Object.create(WindowsHost.prototype);
  host.processInfo = () => null;
  host.ps = () => '[456]';
  // Unverified spawn is refused even before process inspection.
  await assert.rejects(host.stopNew({ port: 30141 }, { pid: 123, unverifiedStartup: true }), /ownership/);
  host.processInfo = pid => pid === 456 ? { pid: 456, parentPid: 123, command: 'next', created: 'child' } : null;
  await assert.rejects(host.stopNew({ port: 30141 }, { pid: 123, parentPid: 1, command: 'launcher', created: 'original' }), /Orphaned/);
});
