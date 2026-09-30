import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { LocalHost, sleep } from './local-host.mjs';
import { PACKAGE, restartEnvironment, samePath, sameProcess } from './policy.mjs';

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
    return { pid, parentPid: Number(match[1]), created: match[2], command: match[4] };
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
    for (let i = 0; i < 20; i++) {
      const info = this.processInfo(identity.pid);
      if (!info) return;
      if (!sameStartedProcess(info, identity)) throw new Error('PID changed during shutdown');
      await sleep(250);
    }
    // Parent may have exited/reparented the known child; creation and command still must match.
    if (!sameStartedProcess(this.processInfo(identity.pid), identity)) throw new Error('PID changed before forced shutdown');
    process.kill(identity.pid, 'SIGKILL');
    for (let i = 0; i < 20; i++) {
      const info = this.processInfo(identity.pid);
      if (!info) return;
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
