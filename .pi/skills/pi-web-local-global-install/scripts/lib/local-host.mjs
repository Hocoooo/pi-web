import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { PACKAGE, commandEnvironment, restartEnvironment, samePath, sameProcess } from './policy.mjs';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Shared build/install and service lifecycle; platform hosts own process discovery/termination. */
export class LocalHost {
  constructor({ env = process.env, logFile, platform = process.platform } = {}) {
    this.platform = platform;
    this.runtimeEnv = restartEnvironment(env);
    this.env = commandEnvironment(this.runtimeEnv);
    this.logFile = logFile;
  }
  log(message) { if (this.logFile) fs.appendFileSync(this.logFile, `${new Date().toISOString()} ${message}\n`); }
  capture(command, args, options = {}) {
    return cp.execFileSync(command, args, { env: this.env, encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 16 * 1024 * 1024, ...options }).trim();
  }
  git(repo, ...args) { return this.capture('git', ['-C', repo, ...args]); }
  npm(args, options = {}) { return this.capture(process.execPath, [this.npmCli, ...args], options); }
  prefix() { return this.npm(['prefix', '-g']); }
  async run(command, args, { cwd, env = this.env, timeout = 600_000 } = {}) {
    this.log(`Run ${path.basename(command)} ${args[0] ?? ''}`);
    const fd = this.logFile ? fs.openSync(this.logFile, 'a') : undefined;
    try {
      await new Promise((resolve, reject) => {
        const child = cp.spawn(command, args, { cwd, env, detached: this.platform === 'darwin', windowsHide: true, stdio: fd === undefined ? 'inherit' : ['ignore', fd, fd] });
        let expired = false;
        const timer = setTimeout(() => { expired = true; this.terminateCommand(child.pid); }, timeout);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', code => { clearTimeout(timer); if (code === 0 && !expired) resolve(); else reject(new Error(expired ? 'Command timed out; inspect run.log' : `Command failed (${code}); inspect run.log`)); });
      });
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  alive(identity) { return !!identity && sameProcess(this.processInfo(identity.pid), identity); }
  hostsCurrentProcess(service) {
    if (!service) return false;
    let info = this.processInfo(process.pid);
    for (let depth = 0; info && depth < 32; depth++) {
      if (sameProcess(info, service.server) || sameProcess(info, service.launcher)) return true;
      if (!info.parentPid || info.parentPid === info.pid) return false;
      info = this.processInfo(info.parentPid);
    }
    return false;
  }
  assertService(prefix, port, expected) {
    const current = this.service(prefix, port);
    if (expected ? !current || !sameProcess(current.server, expected.server) || !sameProcess(current.launcher, expected.launcher) || current.host !== expected.host : current !== null) throw new Error('Service identity changed; no interruption permitted');
  }
  kill(identity) {
    const current = this.processInfo(identity.pid);
    if (!current) return;
    if (!sameProcess(current, identity)) throw new Error('Refusing to stop a reused or changed PID');
    process.kill(identity.pid, 'SIGTERM');
  }
  async waitFree(port) {
    for (let i = 0; i < 20; i++) { if (!this.listeners(port).length) return; await sleep(500); }
    throw new Error('Port remains occupied');
  }
  url(host, port) {
    const local = ['0.0.0.0', '::', '[::]'].includes(host) ? '127.0.0.1' : host;
    return `http://${local.includes(':') && !local.startsWith('[') ? `[${local}]` : local}:${port}`;
  }
  requestOptions() {
    const headers = this.runtimeEnv.PI_WEB_PASSWORD ? { Authorization: `Basic ${Buffer.from(`pi:${this.runtimeEnv.PI_WEB_PASSWORD}`).toString('base64')}` } : {};
    return { headers, signal: AbortSignal.timeout(5000), redirect: 'error' };
  }
  async waitIdle(service, port) {
    if (!service) return;
    for (let i = 0; i < 60; i++) {
      const response = await fetch(`${this.url(service.host, port)}/api/agent/running`, this.requestOptions());
      if (!response.ok) throw new Error('Cannot verify idle sessions; refusing interruption');
      const body = await response.json();
      if (!Array.isArray(body.runningSessionIds)) throw new Error('Unexpected running-session response');
      if (!body.runningSessionIds.length) return;
      if (i % 6 === 0) this.log('Waiting for active sessions to finish');
      await sleep(10_000);
    }
    throw new Error('Sessions still active after ten minutes; no interruption performed');
  }
  async launch(plan, onSpawn = () => {}) {
    if (this.listeners(plan.port).length) throw new Error('Port occupied before launch');
    const fd = fs.openSync(path.join(plan.runDir, 'service.log'), 'a');
    try {
      const child = cp.spawn(process.execPath, [path.join(this.packageDir(plan.prefix), 'bin/pi-web.js'), '--port', String(plan.port), '--hostname', plan.host, '--no-open'], {
        cwd: this.packageDir(plan.prefix), env: this.runtimeEnv, detached: true, windowsHide: true, stdio: ['ignore', fd, fd],
      });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
      onSpawn({ pid: child.pid, unverifiedStartup: true });
      const identity = this.processInfo(child.pid);
      if (!identity || identity.parentPid !== process.pid) throw new Error('Launcher exited during startup');
      onSpawn(identity);
      return identity;
    } finally { fs.closeSync(fd); }
  }
  async health(plan, launcher) {
    if (!launcher) return null;
    for (let i = 0; i < 45; i++) {
      if (!this.alive(launcher)) throw new Error('New launcher exited');
      try {
        const response = await fetch(`${this.url(plan.host, plan.port)}/api/home`, this.requestOptions());
        if (response.ok) {
          const data = await response.json();
          const current = this.service(plan.prefix, plan.port);
          if (current && sameProcess(current.launcher, launcher) && samePath(data.home, plan.runtimeHome)) return current;
        } else await response.body?.cancel();
      } catch { /* Readiness never legitimizes an unrelated listener. */ }
      await sleep(1000);
    }
    throw new Error('New service failed runtime-home/HTTP/identity validation');
  }
  installed(prefix) {
    const pkg = this.packageDir(prefix);
    if (!fs.existsSync(path.join(pkg, 'package.json'))) return null;
    return { version: JSON.parse(fs.readFileSync(path.join(pkg, 'package.json'), 'utf8')).version, buildId: fs.readFileSync(path.join(pkg, '.next/BUILD_ID'), 'utf8').trim() };
  }
  async verify(plan, expected) {
    const installed = this.installed(plan.prefix);
    if (!installed || installed.version !== expected.version || installed.buildId !== expected.buildId) throw new Error('Installed version/BUILD_ID mismatch');
    await this.run(process.execPath, [this.npmCli, 'ls', '-g', '--depth=0', PACKAGE], { cwd: plan.runDir, timeout: 60_000 });
    const pkg = this.packageDir(plan.prefix);
    await this.run(process.execPath, [path.join(pkg, 'bin/pi-web.js'), '--help'], { cwd: plan.runDir, timeout: 30_000 });
    const shell = this.platform === 'darwin' ? "'/bin/sh',['-c','printf pi-web-pty-ok']" : "process.env.ComSpec||'cmd.exe',['/d','/c','echo pi-web-pty-ok']";
    const probe = `const pty=require(require.resolve('node-pty',{paths:[${JSON.stringify(pkg)}]}));const p=pty.spawn(${shell},{name:'xterm-color',cols:80,rows:24,env:process.env});let out='';const t=setTimeout(()=>{p.kill();process.exit(2)},10000);p.onData(d=>out+=d);p.onExit(e=>{clearTimeout(t);process.exit(e.exitCode===0&&out.includes('pi-web-pty-ok')?0:1)});`;
    await this.run(process.execPath, ['-e', probe], { cwd: plan.runDir, timeout: 20_000 });
  }
}
