import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import {
  PACKAGE, atomicJson, readJson, samePath, sameProcess, assertVersions, inspectPack,
  hashFile, assertArtifact, assertBuildOwned, buildEnvironment, workerEnvironment, cutoverTransaction,
  acquireLock, releaseLock, handoffLock, validatePlan, lockKey, runnerLockfile,
} from './policy.mjs';
import { sleep } from './host.mjs';

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const planFile = plan => path.join(plan.runDir, 'plan.json');
export const savePlan = plan => atomicJson(planFile(plan), plan);
export function state(plan, phase, details = {}) {
  atomicJson(path.join(plan.runDir, 'status.json'), { phase, at: new Date().toISOString(), commit: plan.commit, version: plan.version, ...details });
}
export const lockFile = prefix => {
  const canonical = fs.existsSync(prefix) ? fs.realpathSync(prefix) : path.resolve(prefix);
  return path.join(canonical, '.pi-web-installer', `${lockKey(canonical)}.json`);
};

export function copyRunnerDependencies(destination) {
  // The short lock guard uses the existing dependency, copied with its small dependency graph so
  // the detached updater never imports from the package it is replacing or a changing checkout.
  const sourceRequire = createRequire(path.join(scriptRoot, 'install-global.mjs'));
  const copied = new Set();
  function copy(name, resolveFrom) {
    const manifest = resolveFrom.resolve(`${name}/package.json`);
    const pkg = readJson(manifest);
    const id = `${pkg.name}@${pkg.version}`;
    const target = path.join(destination, 'node_modules', name);
    if (copied.has(id)) return;
    if (fs.existsSync(target)) throw new Error(`Conflicting installer dependency versions: ${name}`);
    copied.add(id);
    fs.cpSync(path.dirname(manifest), target, { recursive: true });
    const localRequire = createRequire(manifest);
    for (const dependency of Object.keys(pkg.dependencies ?? {})) copy(dependency, localRequire);
  }
  copy('proper-lockfile', sourceRequire);
}

export async function ensureRunnerDependencies(host, destination, copy = copyRunnerDependencies) {
  const local = createRequire(path.join(destination, 'entry.mjs'));
  try {
    const resolved = local.resolve('proper-lockfile');
    const relative = path.relative(path.join(destination, 'node_modules'), resolved);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) { local('proper-lockfile'); return; }
  } catch { /* Fresh or incomplete isolated runner. */ }
  try { copy(destination); return; } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
  }
  // Fresh checkout: bootstrap only the pinned guard dependency in the external runner. No source
  // node_modules, global package, lifecycle scripts or npm user policy are changed.
  await host.run(process.execPath, [host.npmCli, 'install', '--prefix', destination, '--no-save', '--package-lock=false', '--ignore-scripts', '--no-audit', '--no-fund', 'proper-lockfile@4.1.2'], { cwd: destination });
  local('proper-lockfile');
}

const interruptedPlans = new WeakSet();
export function markInterrupted(plan) { interruptedPlans.add(plan); }
export function recordFailure(plan, error, { preserveScheduled = false, read = readJson, write = state } = {}) {
  // Memory wins over a missing or stale status file. A failed write of stopping/rolling_back
  // must not turn an interrupted installation into a failure that resume treats as safe.
  let phase;
  try { phase = read(path.join(plan.runDir, 'status.json')).phase; } catch { phase = null; }
  const preserve = ['stopping', 'installing', 'starting', 'rolling_back', 'recovery_required', 'verified'];
  if (preserve.includes(phase) || (preserveScheduled && phase === 'scheduled')) return;
  const next = interruptedPlans.has(plan) ? 'recovery_required' : 'failed';
  try { write(plan, next, { error: error.message }); } catch (writeError) {
    error.message = `${error.message}; status write failed: ${writeError.message}`;
  }
}

export function inspectSource(host, options, cwd = process.cwd()) {
  const repo = host.git(cwd, 'rev-parse', '--show-toplevel');
  const commit = host.git(repo, 'rev-parse', '--verify', `${options.commit}^{commit}`);
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('Invalid source commit');
  const dirty = host.git(repo, 'status', '--porcelain', '--untracked-files=no');
  if (dirty && !options.dryRun) throw new Error('Tracked changes are uncommitted. Commit intended changes before installation; no automatic commit is performed.');
  const pkg = JSON.parse(host.git(repo, 'show', `${commit}:package.json`));
  const lock = JSON.parse(host.git(repo, 'show', `${commit}:package-lock.json`));
  assertVersions(pkg, lock);
  const prefix = host.prefix();
  const old = host.installed(prefix);
  const service = host.service(prefix, options.port);
  if (service && !options.restart && !options.dryRun) throw new Error('Global Pi Web is running. --restart is required to authorize interruption.');
  const requiresDefer = !!service && host.hostsCurrentProcess(service);
  if (requiresDefer && options.restart && !options.defer && !options.dryRun) throw new Error('This service hosts the installer. Use --restart --defer 90 so the response can finish.');
  return { repo, commit, version: pkg.version, prefix, old, service, requiresDefer, trackedChanges: dirty || null, untracked: host.git(repo, 'ls-files', '--others', '--exclude-standard') };
}

export const runsRoot = repo => path.join(path.dirname(repo), '.pi-web-installs', lockKey(repo));

export async function createPlan(host, options, source) {
  const root = runsRoot(source.repo);
  fs.mkdirSync(root, { recursive: true });
  const runDir = fs.mkdtempSync(path.join(root, `${source.commit.slice(0, 8)}-`));
  const plan = {
    schema: 1, package: PACKAGE, ...source, runDir,
    port: options.port, host: source.service?.host ?? '127.0.0.1', restart: options.restart,
    heapMb: options.heapMb, skipTests: options.skipTests, skipReason: options.skipReason ?? null,
    runtimeHome: os.homedir(), requiresJevKey: Boolean(host.env.TAPSVC_API_KEY?.trim()),
    createdAt: new Date().toISOString(),
  };
  savePlan(plan);
  state(plan, 'prepared');
  host.logFile = path.join(runDir, 'run.log');
  console.log(`Preparing run directory: ${runDir}`);
  for (const dir of ['archives', 'fallback', 'build-home', 'build-temp']) fs.mkdirSync(path.join(runDir, dir));
  // The updater must survive replacement of the installed package and later checkout changes.
  // Its lock dependency is installed here, before the controller acquires the prefix lease.
  const runner = path.join(runDir, 'runner');
  fs.cpSync(scriptRoot, runner, { recursive: true });
  await ensureRunnerDependencies(host, runner);
  return plan;
}

export function assertCurrent(host, plan) {
  if (!samePath(host.prefix(), plan.prefix)) throw new Error('Default npm prefix changed');
  if (!samePath(os.homedir(), plan.runtimeHome)) throw new Error('Runtime HOME differs from the original launch environment');
  if (plan.requiresJevKey && !host.env.TAPSVC_API_KEY?.trim()) throw new Error('Jev credential missing from restart environment');
  const current = host.installed(plan.prefix);
  if (JSON.stringify(current) !== JSON.stringify(plan.old)) throw new Error('Global installation changed since this run was prepared');
  host.assertService(plan.prefix, plan.port, plan.service);
  if (plan.service && !plan.restart) throw new Error('Restart not authorized');
}

export function cleanupBuild(host, plan) {
  const build = path.join(plan.runDir, 'build');
  if (!fs.existsSync(build)) return;
  assertBuildOwned(plan, host.git(build, 'rev-parse', '--show-toplevel'), host.git(build, 'rev-parse', 'HEAD'), fs.realpathSync(build));
  if (host.git(build, 'status', '--porcelain', '--untracked-files=no')) throw new Error('Worktree has tracked edits; cleanup deferred');
  const deps = path.join(build, 'node_modules');
  // Normally npm ci creates a real directory. Never recurse through a junction if someone replaced it.
  if (fs.existsSync(deps) && fs.lstatSync(deps).isSymbolicLink()) throw new Error('Unexpected dependency junction; cleanup deferred');
  host.git(plan.repo, 'worktree', 'remove', '--force', build);
}

export async function pack(host, cwd, directory, expected) {
  const dry = JSON.parse(host.npm(['pack', '--dry-run', '--json'], { cwd, timeout: 180_000 }));
  inspectPack(dry, expected.version);
  const packed = inspectPack(JSON.parse(host.npm(['pack', '--json', '--pack-destination', directory], { cwd, timeout: 180_000 })), expected.version);
  const file = path.join(directory, packed.filename);
  const buildId = host.capture(host.tar, ['-xOf', file, 'package/.next/BUILD_ID']).trim();
  const pkg = JSON.parse(host.capture(host.tar, ['-xOf', file, 'package/package.json']));
  if (buildId !== expected.buildId || pkg.version !== expected.version || pkg.name !== PACKAGE) throw new Error('Actual archive content mismatch');
  return { file, sha256: hashFile(file), version: pkg.version, buildId };
}

export async function prepare(host, plan) {
  if (plan.artifact) { assertArtifact(plan.artifact); return; }
  const build = path.join(plan.runDir, 'build');
  if (fs.existsSync(build)) cleanupBuild(host, plan); // Never use partial/stale build output after failure.
  state(plan, 'building');
  host.git(plan.repo, 'worktree', 'add', '--detach', build, plan.commit);
  await host.run(process.execPath, [host.npmCli, 'ci', '--include=dev', '--no-audit', '--no-fund'], { cwd: build });
  // Dependency installation uses real npm credentials/cache. HOME isolation begins only for compilation.
  const env = buildEnvironment(host.env, plan.runDir, plan.heapMb);
  await host.run(process.execPath, [path.join(build, 'node_modules/typescript/bin/tsc'), '--noEmit'], { cwd: build, env, timeout: 180_000 });
  if (!plan.skipTests) await host.run(process.execPath, [host.npmCli, 'test'], { cwd: build, env, timeout: 300_000 });
  else host.log(`Tests explicitly skipped: ${plan.skipReason}`);
  await host.run(process.execPath, [host.npmCli, 'run', 'build'], { cwd: build, env });
  const buildId = fs.readFileSync(path.join(build, '.next/BUILD_ID'), 'utf8').trim();
  if (!buildId) throw new Error('Build completed without BUILD_ID');
  plan.built = { version: plan.version, buildId };
  savePlan(plan);
  state(plan, 'built', { buildId });
  plan.artifact = await pack(host, build, path.join(plan.runDir, 'archives'), plan.built);
  savePlan(plan);
  state(plan, 'packed', { buildId });
}

export async function backup(host, plan) {
  assertCurrent(host, plan);
  if (!plan.old) return;
  if (plan.fallback) { assertArtifact(plan.fallback); return; }
  state(plan, 'backing_up');
  plan.fallback = await pack(host, host.packageDir(plan.prefix), path.join(plan.runDir, 'fallback'), plan.old);
  savePlan(plan);
}

export async function apply(host, plan) {
  let replacement;
  let verifiedService;
  const install = artifact => host.run(process.execPath, [host.npmCli, 'install', '-g', artifact.file, '--no-audit', '--no-fund', '--prefer-offline'], { cwd: plan.runDir });
  await cutoverTransaction({
    preflight: async () => { assertCurrent(host, plan); assertArtifact(plan.artifact); if (plan.old) assertArtifact(plan.fallback); },
    idle: () => host.waitIdle(plan.service, plan.port),
    stop: async markTransactionInterrupted => {
      // Persist before interruption so an abruptly killed updater cannot silently resume forward.
      markInterrupted(plan);
      state(plan, 'stopping');
      if (plan.service) {
        host.kill(plan.service.server); markTransactionInterrupted();
        host.kill(plan.service.launcher);
        await host.waitFree(plan.port);
      }
    },
    install: async () => { state(plan, 'installing'); await install(plan.artifact); },
    verify: () => host.verify(plan, plan.artifact),
    launch: async () => {
      if (!plan.restart) return null;
      state(plan, 'starting');
      replacement = await host.launch(plan, owned => {
        replacement = owned;
        plan.replacement = owned;
        savePlan(plan);
      });
      return replacement;
    },
    health: async launcher => { verifiedService = await host.health(plan, launcher); },
    success: async () => {
      state(plan, 'verified', { buildId: plan.artifact.buildId, service: verifiedService, testsSkipped: plan.skipReason });
      try { cleanupBuild(host, plan); } catch (error) { host.log(`Cleanup deferred: ${error.message}`); }
    },
    rollback: async error => {
      markInterrupted(plan);
      try { state(plan, 'rolling_back', { error: error.message }); } catch (writeError) {
        host.log(`Could not persist rolling_back: ${writeError.message}`);
      }
      try {
        await host.stopNew(plan, replacement);
        if (!plan.fallback) throw new Error('No previous installation to restore; manual recovery required');
        assertArtifact(plan.fallback);
        // The previous service may already have been killed by its child-exit handler.
        if (plan.service) { host.kill(plan.service.server); host.kill(plan.service.launcher); }
        await host.waitFree(plan.port);
        await install(plan.fallback);
        await host.verify(plan, plan.fallback);
        const launcher = plan.service ? await host.launch(plan) : null;
        const service = await host.health(plan, launcher);
        state(plan, 'rolled_back', { error: error.message, buildId: plan.fallback.buildId, service });
      } catch (rollbackError) {
        state(plan, 'recovery_required', { error: error.message, rollbackError: rollbackError.message });
        throw rollbackError;
      }
    },
  });
}

export async function schedule(host, plan, owner, delaySeconds) {
  const fd = fs.openSync(path.join(plan.runDir, 'updater.log'), 'a');
  let child;
  try {
    child = cp.spawn(process.execPath, [path.join(plan.runDir, 'runner/install-global.mjs'), 'worker', '--run-dir', plan.runDir], {
      cwd: plan.runDir,
      env: workerEnvironment(host.runtimeEnv),
      detached: true, windowsHide: true, stdio: ['ignore', fd, fd],
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
  } finally { fs.closeSync(fd); }
  const worker = host.processInfo(child.pid);
  if (!worker || worker.parentPid !== owner.pid) throw new Error('Detached worker did not start');
  plan.worker = worker;
  plan.notBefore = Date.now() + delaySeconds * 1000;
  savePlan(plan);
  state(plan, 'scheduled', { delaySeconds, worker });
  const file = lockFile(plan.prefix);
  handoffLock(file, plan.runDir, owner, worker, runnerLockfile(plan.runDir));
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(plan.runDir, 'worker-ready.json'))) return;
    if (!host.alive(worker)) throw new Error('Detached worker exited; inspect updater.log');
    await sleep(250);
  }
  throw new Error('Worker handoff not acknowledged; inspect status before retrying');
}

export async function worker(host, runDir) {
  let plan;
  const owner = host.processInfo(process.pid);
  for (let i = 0; i < 80; i++) {
    plan = validatePlan(readJson(path.join(runDir, 'plan.json')), runDir);
    const file = lockFile(plan.prefix);
    if (plan.worker && sameProcess(plan.worker, owner) && fs.existsSync(file) && sameProcess(readJson(file).owner, owner)) break;
    if (i === 79) throw new Error('Detached worker has no valid handoff; refusing to act');
    await sleep(250);
  }
  atomicJson(path.join(runDir, 'worker-ready.json'), { pid: process.pid });
  try {
    await sleep(Math.max(0, plan.notBefore - Date.now()));
    await apply(host, plan);
  } catch (error) {
    recordFailure(plan, error);
    throw error;
  } finally { releaseLock(lockFile(plan.prefix), runDir, owner, runnerLockfile(runDir)); }
}

export async function execute(host, plan, options, resume = false) {
  const owner = host.processInfo(process.pid);
  const file = lockFile(plan.prefix);
  // The controller may be a fresh checkout with no node_modules. Use the runner's copy.
  const lockfile = runnerLockfile(plan.runDir);
  acquireLock(file, plan.runDir, owner, identity => host.alive(identity), resume, lockfile);
  try {
    atomicJson(path.join(path.dirname(plan.runDir), 'latest.json'), { runDir: plan.runDir });
    if (resume) {
      const previous = readJson(path.join(plan.runDir, 'status.json')).phase;
      if (['stopping', 'installing', 'starting', 'rolling_back', 'recovery_required'].includes(previous)) throw new Error('Interrupted cutover requires manual recovery; inspect archives and run.log before starting a new run');
      if (previous === 'verified') throw new Error('This run is already verified');
      if (JSON.stringify(host.installed(plan.prefix)) !== JSON.stringify(plan.old)) throw new Error('Installed build changed; do not reuse this run');
      plan.service = host.service(plan.prefix, plan.port);
      if (plan.service && !options.restart) throw new Error('Resume requires --restart to authorize stopping the current service');
      if (plan.service && host.hostsCurrentProcess(plan.service) && !options.defer) throw new Error('Resume from the hosted session requires --restart --defer 90');
      plan.restart = options.restart;
      plan.host = plan.service?.host ?? plan.host;
      delete plan.worker;
      delete plan.replacement;
      fs.rmSync(path.join(plan.runDir, 'worker-ready.json'), { force: true });
      savePlan(plan);
    }
    assertCurrent(host, plan);
    await prepare(host, plan);
    await backup(host, plan);
    if (options.defer) await schedule(host, plan, owner, options.defer);
    else await apply(host, plan);
  } catch (error) {
    recordFailure(plan, error, { preserveScheduled: true });
    throw error;
  } finally { releaseLock(file, plan.runDir, owner, lockfile); }
}
