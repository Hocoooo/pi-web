import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/** Lock implementation copied into the external runner. Callers fall back to this file's module when it is absent. */
export function runnerLockfile(runDir) {
  const root = path.join(runDir, 'runner', 'node_modules', 'proper-lockfile');
  const manifest = path.join(root, 'package.json');
  if (!fs.existsSync(manifest)) return undefined;
  const entry = path.join(root, JSON.parse(fs.readFileSync(manifest, 'utf8')).main ?? 'index.js');
  return createRequire(path.join(runDir, 'runner', 'entry.mjs'))(entry);
}

export const PACKAGE = '@agegr/pi-web';

export function parseArgs(argv) {
  const options = { command: argv[0] ?? 'help', restart: false, noWait: false, defer: 0, port: 30141, heapMb: 4096, skipTests: false, allowDirty: false, commit: 'HEAD' };
  if (['--help', '-h'].includes(options.command)) options.command = 'help';
  if (!['run', 'resume', 'status', 'help', 'worker'].includes(options.command)) throw new Error('Expected run, resume, status, or help');
  const allowed = {
    run: ['--commit', '--defer', '--port', '--heap-mb', '--skip-tests-reason', '--allow-dirty', '--restart', '--no-wait', '--dry-run'],
    resume: ['--run-dir', '--restart', '--defer', '--no-wait'], status: ['--run-dir'], worker: ['--run-dir'], help: [],
  };
  const valued = new Map([['--commit', 'commit'], ['--run-dir', 'runDir'], ['--defer', 'defer'], ['--port', 'port'], ['--heap-mb', 'heapMb'], ['--skip-tests-reason', 'skipReason']]);
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (!allowed[options.command].includes(arg)) throw new Error(`Unsupported option for ${options.command}: ${arg}`);
    if (arg === '--restart') options.restart = true;
    else if (arg === '--no-wait') options.noWait = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--allow-dirty') options.allowDirty = true;
    else if (valued.has(arg)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      options[valued.get(arg)] = value;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  for (const [key, min, max] of [['defer', 0, 3600], ['port', 1, 65535], ['heapMb', 1024, 16384]]) {
    options[key] = Number(options[key]);
    if (!Number.isInteger(options[key]) || options[key] < min || options[key] > max) throw new Error(`Invalid ${key}`);
  }
  if (options.defer && !options.restart) throw new Error('--defer requires --restart');
  if (options.noWait && !options.restart) throw new Error('--no-wait requires --restart');
  if (options.skipReason !== undefined) {
    if (!options.skipReason.trim()) throw new Error('A non-empty test-skip reason is required');
    options.skipTests = true;
  }
  if (['resume', 'worker'].includes(options.command) && !options.runDir) throw new Error(`${options.command} requires --run-dir`);
  if (options.command !== 'run' && (options.commit !== 'HEAD' || options.skipTests || options.heapMb !== 4096)) throw new Error('Source, heap and test options are fixed by the original run');
  return options;
}

export function commandEnvironment(environment) {
  const env = { ...environment };
  delete env.NODE_OPTIONS;
  delete env.TURBOPACK;
  return env;
}

export function restartEnvironment(environment) {
  const env = { ...environment };
  for (const name of ['NODE_OPTIONS', 'TURBOPACK']) {
    const inherited = `PI_WEB_INSTALL_RUNTIME_${name}`;
    if (Object.hasOwn(env, inherited)) env[name] = env[inherited];
    delete env[inherited];
  }
  return env;
}

export function workerEnvironment(environment) {
  return { ...environment, NODE_OPTIONS: '', TURBOPACK: '',
    PI_WEB_INSTALL_RUNTIME_NODE_OPTIONS: environment.NODE_OPTIONS ?? '',
    PI_WEB_INSTALL_RUNTIME_TURBOPACK: environment.TURBOPACK ?? '' };
}

export function buildEnvironment(environment, runDir, heapMb, platform = process.platform) {
  // Never mutate the restart/install environment or place runtime data beneath build/.
  const env = commandEnvironment(environment);
  const home = path.join(runDir, 'build-home');
  // Windows OS temp normally lives inside the real profile. With HOME isolated,
  // the SDK would treat that profile's .agents resources as project resources.
  let temp = os.tmpdir();
  if (platform === 'win32') {
    temp = path.win32.join(runDir, 'build-temp');
    const originalHome = environment.USERPROFILE || environment.HOME;
    if (originalHome) {
      const relative = path.win32.relative(originalHome, temp);
      if (!relative || (!relative.startsWith(`..${path.win32.sep}`) && relative !== '..' && !path.win32.isAbsolute(relative))) {
        temp = path.win32.join(environment.SystemRoot || environment.WINDIR || 'C:\\Windows', 'Temp', 'pi-web-build', path.win32.basename(runDir));
      }
    }
  }
  return { ...env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: path.join(home, '.pi', 'agent'), TMP: temp, TEMP: temp, TMPDIR: temp, NODE_OPTIONS: `--max-old-space-size=${heapMb}` };
}

export function samePath(a, b) {
  const left = path.resolve(a), right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

export function sameProcess(a, b) {
  return !!a && !!b && a.pid === b.pid && a.parentPid === b.parentPid && a.command === b.command && a.created === b.created;
}

export function assertVersions(pkg, lock) {
  if (pkg.name !== PACKAGE || !pkg.version || pkg.version !== lock.version || pkg.version !== lock.packages?.['']?.version) throw new Error('Package/lockfile version mismatch');
}

export function inspectPack(result, version) {
  if (!Array.isArray(result) || result.length !== 1) throw new Error('Unexpected npm pack response');
  const pack = result[0];
  const files = pack.files?.map(f => f.path) ?? [];
  if (pack.name !== PACKAGE || pack.version !== version || !/^[^/\\]+\.tgz$/.test(pack.filename ?? '')) throw new Error('Unexpected package identity');
  for (const required of ['package.json', 'bin/pi-web.js', '.next/BUILD_ID']) {
    if (!files.includes(required)) throw new Error(`Package missing ${required}`);
  }
  if (!files.some(p => p.startsWith('.next/server/')) || !files.some(p => p.startsWith('.next/static/'))) throw new Error('Missing production output');
  if (files.some(p => /(^|\/)\.env($|\.)/.test(p) || /^\.next\/(dev|cache)\//.test(p) || p.endsWith('.log'))) throw new Error('Development data or secrets in package');
  return pack;
}

export function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function atomicJson(file, value) {
  // Sibling temp + rename is the publication. On Windows rename replaces an existing file,
  // so a crash before rename leaves the previous lease (or no lease) readable.
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  try { fs.renameSync(temporary, file); } finally { fs.rmSync(temporary, { force: true }); }
}

export function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

export function validatePlan(plan, runDir) {
  if (plan.schema !== 1 || plan.package !== PACKAGE || !samePath(plan.runDir, runDir) ||
      !/^[a-f0-9]{40,64}$/.test(plan.commit ?? '') || typeof plan.version !== 'string' ||
      !path.isAbsolute(plan.repo ?? '') || !path.isAbsolute(plan.prefix ?? '') ||
      !Number.isInteger(plan.port) || plan.port < 1 || plan.port > 65535 ||
      !Number.isInteger(plan.heapMb) || plan.heapMb < 1024 || plan.heapMb > 16384 ||
      (plan.platform !== undefined && !['win32', 'darwin'].includes(plan.platform)) ||
      (plan.noWait !== undefined && typeof plan.noWait !== 'boolean') || (plan.noWait && !plan.restart)) throw new Error('Invalid installation plan');
  if (samePath(plan.repo, runDir) || path.relative(plan.repo, runDir).split(path.sep)[0] !== '..') throw new Error('Run directory must be outside the checkout');
  for (const artifact of [plan.artifact, plan.fallback].filter(Boolean)) {
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256 ?? '') || typeof artifact.buildId !== 'string' || typeof artifact.version !== 'string' ||
        !samePath(path.dirname(artifact.file), path.join(runDir, artifact === plan.artifact ? 'archives' : 'fallback'))) throw new Error('Invalid artifact reference');
  }
  return plan;
}

function mutateLock(file, action, lockfile = require('proper-lockfile')) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Reuse the project's proven lock primitive for the short mutation, not a permanent ownerless mkdir.
  // Its stale/mtime protocol recovers a guard abandoned by an OS crash. The durable owner lease below
  // still requires explicit same-run resume and a dead process identity.
  let release;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      release = lockfile.lockSync(file, { realpath: false, lockfilePath: `${file}.guard`, stale: 120_000 });
      break;
    } catch (error) {
      if (error.code !== 'ELOCKED') throw error;
      if (attempt === 49) throw new Error(`Lock operation in progress; a crashed guard expires after two minutes: ${file}.guard`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  try { return action(); } finally { release(); }
}

export function acquireLock(file, runDir, owner, isAlive, resume = false, lockfile) {
  return mutateLock(file, () => {
    if (fs.existsSync(file)) {
      let existing;
      try { existing = readJson(file); } catch { throw new Error(`Corrupt lease requires manual inspection before recovery: ${file}`); }
      if (!resume || !samePath(existing.runDir, runDir) || isAlive(existing.owner)) throw new Error(`Installation locked. Inspect or resume: ${existing.runDir}`);
      fs.unlinkSync(file); // Explicit recovery of this same abandoned run only.
    }
    // Publish complete JSON atomically while the short guard serializes all lease mutations.
    // A crash before rename leaves no empty/truncated durable lease.
    atomicJson(file, { runDir, owner });
  }, lockfile);
}

export function releaseLock(file, runDir, owner, lockfile) {
  return mutateLock(file, () => {
    if (!fs.existsSync(file)) return;
    const lock = readJson(file);
    if (samePath(lock.runDir, runDir) && sameProcess(lock.owner, owner)) fs.unlinkSync(file);
  }, lockfile);
}

export function handoffLock(file, runDir, owner, worker, lockfile) {
  return mutateLock(file, () => {
    const lock = readJson(file);
    if (!samePath(lock.runDir, runDir) || !sameProcess(lock.owner, owner)) throw new Error('Lock changed during worker handoff');
    atomicJson(file, { runDir, owner: worker });
  }, lockfile);
}

export function lockKey(prefix) {
  const canonical = path.resolve(prefix);
  return crypto.createHash('sha256').update(`${process.platform === 'win32' ? canonical.toLowerCase() : canonical}|${PACKAGE}`).digest('hex').slice(0, 24);
}

export function assertArtifact(artifact) {
  if (!artifact || hashFile(artifact.file) !== artifact.sha256) throw new Error('Archive missing or integrity mismatch');
}

export function assertBuildOwned(plan, gitTop, gitHead, realBuild) {
  const build = path.join(plan.runDir, 'build');
  if (!samePath(build, gitTop) || !samePath(build, realBuild) || gitHead.trim() !== plan.commit || samePath(build, plan.repo)) throw new Error('Refusing cleanup of an unrecognized worktree');
}

/** Testable direct-overwrite transaction: interrupted failures require recovery, never rollback. */
export async function cutoverTransaction(actions) {
  await actions.preflight();
  await actions.idle();
  await actions.preflight();
  let interrupted = false;
  let installedService;
  try {
    // stop() owns its partial-stop recovery flag: a second kill can fail after the first succeeds.
    await actions.stop(() => { interrupted = true; });
    interrupted = true; // Package mutation is risky even when no service was initially running.
    await actions.install();
    await actions.verify();
    installedService = await actions.launch();
    await actions.health(installedService);
    await actions.success(installedService);
  } catch (error) {
    if (!interrupted) throw error;
    await actions.failure(error, installedService);
    throw error;
  }
}
