import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { LocalHost, sleep } from './local-host.mjs';
import { PACKAGE, restartEnvironment, samePath, sameProcess } from './policy.mjs';
import { delegateTerminal } from './mac-terminal.mjs';
import { LaunchAgent } from './mac-launchagent.mjs';

export function executableOnPath(name, env) {
  for (const directory of (env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    const file = path.join(directory, name);
    try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return fs.realpathSync(file); } catch { /* Try next directory. */ }
  }
  throw new Error(`${name} is required on PATH`);
}
export function macLaunchOptions(args, env = {}) {
  const { values } = parseArgs({ args, strict: true, options: {
    port: { type: 'string', short: 'p' }, hostname: { type: 'string', short: 'H' }, 'no-open': { type: 'boolean' },
  } });
  const rawPort = values.port ?? env.PORT ?? '30141';
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) throw new Error('Cannot determine original host/port');
  return { port: Number(rawPort), host: values.hostname ?? env.PI_WEB_HOSTNAME ?? '127.0.0.1' };
}
function sameStartedProcess(a, b) { return !!a && !!b && a.pid === b.pid && a.created === b.created && a.command === b.command; }

export class MacOSHost extends LocalHost {
  constructor(options = {}) {
    super(options);
    if (process.platform !== 'darwin') throw new Error('MacOSHost requires macOS');
    this.npmCli = executableOnPath('npm', this.env);
    if (path.basename(this.npmCli) !== 'npm-cli.js') throw new Error('npm must resolve to its JavaScript CLI');
    this.python = executableOnPath('python3', this.env);
    this.tar = '/usr/bin/tar';
    for (const file of [this.tar, '/bin/ps', '/usr/sbin/lsof']) fs.accessSync(file, fs.constants.X_OK);
  }
  packageDir(prefix) { return path.join(prefix, 'lib', 'node_modules', PACKAGE); }
  launchctl(args) {
    return cp.spawnSync('/bin/launchctl', args, { encoding: 'utf8', env: this.env, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
  }
  restartOptions(options, source) {
    if (!options.restart) {
      if (options.macosLaunch || options.macosEnvFile) throw new Error('macOS launch options require --restart');
      if (new LaunchAgent(this, { prefix: source.prefix, port: options.port, runtimeHome: this.runtimeEnv.HOME }).existing()) throw new Error('Registered LaunchAgent requires --restart for package replacement');
      return {};
    }
    if (process.getuid() === 0) throw new Error('macOS restart requires the logged-in user, not root');
    const plan = { prefix: source.prefix, port: options.port, runtimeHome: this.runtimeEnv.HOME };
    const agent = new LaunchAgent(this, plan);
    const existing = agent.existing();
    plan.macosLaunch = options.macosLaunch ?? (existing ? 'launchagent' : 'terminal');
    if (options.macosEnvFile && !path.isAbsolute(options.macosEnvFile)) throw new Error('--macos-env-file must be absolute');
    plan.macosEnvFile = options.macosEnvFile ?? existing?.envFile;
    agent.preflight();
    return { macosLaunch: plan.macosLaunch, ...(plan.macosEnvFile ? { macosEnvFile: plan.macosEnvFile } : {}) };
  }
  preflightRestart(plan) {
    if (!plan.restart) {
      if (new LaunchAgent(this, plan).existing()) throw new Error('Registered LaunchAgent requires --restart for package replacement');
      return;
    }
    if (!['terminal', 'launchagent'].includes(plan.macosLaunch)) throw new Error('Legacy macOS restart plan: create a fresh Terminal/LaunchAgent plan');
    new LaunchAgent(this, plan).preflight();
  }
  startWorker(plan) { return delegateTerminal(this, plan); }
  async stopService(plan) {
    if (!plan.restart) return;
    const agent = new LaunchAgent(this, plan);
    agent.stop(); // bootout first: launchd must not race package replacement or restart.
    if (plan.service) {
      await this.kill(plan.service.server);
      await this.kill(plan.service.launcher);
    }
    await this.waitFree(plan.port);
    if (plan.macosLaunch === 'terminal') agent.disableRegistration();
  }
  async launch(plan, onSpawn = () => {}) {
    if (!this.terminalDelegated) throw new Error('macOS launch must run in the acknowledged Terminal worker');
    if (this.listeners(plan.port).length) throw new Error('Port occupied before launch');
    if (plan.macosLaunch === 'launchagent') {
      const agent = new LaunchAgent(this, plan);
      this.agentStartAttempted = true;
      agent.start();
      for (let i = 0; i < 45; i++) {
        const current = this.service(plan.prefix, plan.port);
        if (current) {
          const job = agent.loaded();
          if (!job?.pid || current.launcher.parentPid !== job.pid) throw new Error('Listener does not belong to the LaunchAgent');
          onSpawn(current.launcher);
          return current.launcher;
        }
        await sleep(1000);
      }
      throw new Error('LaunchAgent did not start a recognized service');
    }
    const fd = fs.openSync(path.join(plan.runDir, 'service.log'), 'a', 0o600);
    try {
      // Attached to the delegated Terminal worker, never detached back into an updater context.
      const child = cp.spawn(process.execPath, [path.join(this.packageDir(plan.prefix), 'bin/pi-web.js'), '--port', String(plan.port), '--hostname', plan.host, '--no-open'], {
        cwd: this.packageDir(plan.prefix), env: this.runtimeEnv, stdio: ['inherit', fd, fd],
      });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      onSpawn({ pid: child.pid, unverifiedStartup: true });
      const identity = this.processInfo(child.pid);
      if (!identity || identity.parentPid !== process.pid) throw new Error('Terminal launcher exited during startup');
      onSpawn(identity);
      return identity;
    } finally { fs.closeSync(fd); }
  }
  async diagnose(plan) {
    try {
      const response = await fetch(`${this.url(plan.host, plan.port)}/api/service/health`, this.requestOptions());
      const data = await response.json();
      const names = ['user', 'dns', 'childUser', 'childDns', 'paths'];
      if ([200, 503].includes(response.status) && names.every(name => typeof data.checks?.[name] === 'boolean')) {
        const checks = Object.fromEntries(names.map(name => [name, data.checks[name]]));
        return { status: Object.values(checks).every(Boolean) ? 'healthy' : 'degraded', checks };
      }
    } catch { /* Missing endpoint in older installations is not a passing runtime check. */ }
    return { status: 'unavailable' };
  }
  async health(plan, launcher) {
    const current = await super.health(plan, launcher);
    if (!current) return null;
    let runtimeHealth = await this.diagnose(plan);
    if (runtimeHealth.status === 'healthy') {
      await sleep(5500); // Past the endpoint's five-second coalescing cache.
      runtimeHealth = await this.diagnose(plan);
    }
    this.assertService(plan.prefix, plan.port, current);
    // Diagnostic failures retain the service for investigation, but never mark the run verified.
    return { ...current, runtimeHealth };
  }
  terminateCommand(pid) {
    // run() creates a new process group; only its exact owned command tree is terminated.
    try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  processInfo(pid) {
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid PID');
    const result = cp.spawnSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'ppid=', '-o', 'lstart=', '-o', 'stat=', '-o', 'command='], { encoding: 'utf8', env: { ...this.env, LC_ALL: 'C' } });
    if (result.status === 1 && !result.stdout.trim()) return null;
    if (result.error || result.status !== 0) throw new Error('Cannot inspect macOS process identity');
    const match = result.stdout.trim().match(/^(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(\S+)\s+(.+)$/);
    if (!match) throw new Error('Unexpected macOS ps identity output');
    // A terminated child may briefly be <defunct> until its parent reaps it. It is not a live reused PID.
    if (match[3].startsWith('Z')) return null;
    return { pid, parentPid: Number(match[1]), created: match[2], command: match[4], ...(match[3].includes('E') ? { exiting: true } : {}) };
  }
  processDetails(pid, environment = false) {
    const helper = fileURLToPath(new URL('./mac-process.py', import.meta.url));
    // No shell/tokenization of ps output: paths and environment values may contain spaces.
    return JSON.parse(this.capture(this.python, [helper, String(pid), ...(environment ? ['--environment'] : [])]));
  }
  processCwd(pid) {
    const output = this.capture('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
    const cwd = output.split('\n').find(line => line.startsWith('n'))?.slice(1);
    if (!cwd) throw new Error('Cannot inspect service cwd');
    return fs.realpathSync(cwd);
  }
  listeners(port) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
    const result = cp.spawnSync('/usr/sbin/lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', env: this.env });
    if (result.status === 1 && !result.stdout.trim()) return [];
    if (result.error || result.status !== 0) throw new Error('Cannot inspect port ownership');
    const pids = [...new Set(result.stdout.trim().split(/\s+/).map(Number))];
    if (pids.some(pid => !Number.isInteger(pid) || pid <= 0)) throw new Error('Unexpected lsof port ownership');
    return pids;
  }
  service(prefix, port) {
    const ids = this.listeners(port);
    if (!ids.length) return null;
    if (ids.length !== 1) throw new Error('Multiple port owners; refusing automatic cutover');
    const server = this.processInfo(ids[0]);
    const launcher = server && this.processInfo(server.parentPid);
    if (!launcher) throw new Error('Listener has no recognized launcher');
    const pkg = fs.realpathSync(this.packageDir(prefix));
    if (this.processCwd(server.pid) !== pkg) throw new Error('Port is not owned by the default-global Pi Web package');
    const details = this.processDetails(launcher.pid);
    const cli = fs.realpathSync(path.join(pkg, 'bin/pi-web.js'));
    const cliIndex = details.argv.findIndex((arg, index) => {
      if (index === 0 || !path.isAbsolute(arg)) return false;
      try { return fs.realpathSync(arg) === cli; } catch { return false; }
    });
    if (cliIndex < 0 || path.basename(details.executable) !== 'node') throw new Error('Port is not owned by a recognized default-global Pi Web launcher');
    const serverDetails = this.processDetails(server.pid);
    const next = path.join(pkg, 'node_modules/next/dist/bin/next');
    const isNext = /^next-server(?:\s|$)/.test(server.command)
      || serverDetails.argv.some(arg => samePath(arg, next)) && serverDetails.argv.includes('start');
    if (!isNext) throw new Error('Listener is not a recognized Next server');
    const runtime = this.processDetails(launcher.pid, true);
    // Recheck after reading process data; a race/PID reuse never legitimizes a stop.
    if (!sameProcess(this.processInfo(server.pid), server) || !sameProcess(this.processInfo(launcher.pid), launcher)) throw new Error('Service identity changed during discovery');
    const options = macLaunchOptions(runtime.argv.slice(cliIndex + 1), runtime.env);
    if (options.port !== port || !options.host || !runtime.env.HOME) throw new Error('Cannot determine original host/port/runtime home');
    this.runtimeEnv = restartEnvironment(runtime.env);
    return { server, launcher, host: options.host };
  }
  async kill(identity) {
    const current = this.processInfo(identity.pid);
    if (!current) return;
    if (!sameProcess(current, identity)) throw new Error('Refusing to stop a reused or changed PID');
    process.kill(identity.pid, 'SIGTERM');
    // macOS briefly reports ?E (trying to exit) and '(node)' instead of the argv.
    // Only wait in that kernel state for the already-signalled creation identity;
    // never use a shortened command as authority to send another signal.
    const exiting = info => info?.exiting === true && info.pid === identity.pid && info.created === identity.created;
    for (let i = 0; i < 20; i++) {
      const info = this.processInfo(identity.pid);
      if (!info) return;
      if (exiting(info)) { await sleep(250); continue; }
      if (!sameStartedProcess(info, identity)) throw new Error('PID changed during shutdown');
      await sleep(250);
    }
    // Parent may have exited/reparented the known child; creation and command still must match.
    if (!sameStartedProcess(this.processInfo(identity.pid), identity)) throw new Error('PID changed before forced shutdown');
    process.kill(identity.pid, 'SIGKILL');
    for (let i = 0; i < 20; i++) {
      const info = this.processInfo(identity.pid);
      if (!info) return;
      if (exiting(info)) { await sleep(250); continue; }
      if (!sameStartedProcess(info, identity)) throw new Error('PID changed after shutdown');
      await sleep(250);
    }
    throw new Error('Identified process did not exit');
  }
  children(pid) {
    const rows = this.capture('/bin/ps', ['-axo', 'pid=,ppid=']).split('\n');
    return rows.map(row => row.trim().split(/\s+/).map(Number)).filter(([, parent]) => parent === pid).map(([child]) => this.processInfo(child)).filter(Boolean);
  }
  async stopNew(plan, launcher) {
    if (this.agentStartAttempted) {
      new LaunchAgent(this, plan).stop();
      await this.waitFree(plan.port);
      return;
    }
    if (!launcher) return;
    if (launcher.unverifiedStartup) throw new Error('Startup process ownership could not be verified; stop it manually before recovery');
    const current = this.processInfo(launcher.pid);
    if (current && !sameProcess(current, launcher)) throw new Error('Startup launcher PID was reused; refusing recovery');
    const children = this.children(launcher.pid);
    if (!current && children.length) throw new Error('Orphaned startup children require manual recovery');
    // Stop the recorded Next child first; the CLI's child-exit handler then exits the launcher.
    for (const child of children) await this.kill(child);
    if (this.processInfo(launcher.pid)) await this.kill(launcher);
    await this.waitFree(plan.port);
  }
}
