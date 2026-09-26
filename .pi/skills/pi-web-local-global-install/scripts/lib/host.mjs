import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import cp from 'node:child_process';
import { PACKAGE, commandEnvironment, restartEnvironment, samePath, sameProcess } from './policy.mjs';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const quotePS = value => `'${String(value).replaceAll("'", "''")}'`;
const argv = command => [...command.matchAll(/"([^"]*)"|(\S+)/g)].map(m => m[1] ?? m[2]);

export class WindowsHost {
  constructor({ env = process.env, logFile } = {}) {
    if (process.platform !== 'win32') throw new Error('This installer currently supports Windows only');
    this.runtimeEnv = restartEnvironment(env);
    this.env = commandEnvironment(this.runtimeEnv);
    this.logFile = logFile;
    this.npmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    this.tar = path.join(this.env.SystemRoot ?? 'C:\\Windows', 'System32/tar.exe');
    if (!fs.existsSync(this.npmCli) || !fs.existsSync(this.tar)) throw new Error('Node-bundled npm and Windows tar.exe are required');
  }
  log(message) {
    if (this.logFile) fs.appendFileSync(this.logFile, `${new Date().toISOString()} ${message}\n`);
  }
  capture(command, args, options = {}) {
    return cp.execFileSync(command, args, { env: this.env, encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 16 * 1024 * 1024, ...options }).trim();
  }
  ps(script) { return this.capture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]).replace(/^\uFEFF/, ''); }
  git(repo, ...args) { return this.capture('git', ['-C', repo, ...args]); }
  npm(args, options = {}) { return this.capture(process.execPath, [this.npmCli, ...args], options); }
  prefix() { return this.npm(['prefix', '-g']); }
  packageDir(prefix) { return path.join(prefix, 'node_modules', PACKAGE); }
  async run(command, args, { cwd, env = this.env, timeout = 600_000 } = {}) {
    this.log(`Run ${path.basename(command)} ${args[0] ?? ''}`);
    const fd = this.logFile ? fs.openSync(this.logFile, 'a') : undefined;
    try {
      await new Promise((resolve, reject) => {
        const child = cp.spawn(command, args, { cwd, env, windowsHide: true, stdio: fd === undefined ? 'inherit' : ['ignore', fd, fd] });
        let expired = false;
        const timer = setTimeout(() => {
          expired = true;
          // Our exact spawned command tree only, never a listener selected by name.
          cp.spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        }, timeout);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('close', code => { clearTimeout(timer); if (code === 0 && !expired) resolve(); else reject(new Error(expired ? 'Command timed out; inspect run.log' : `Command failed (${code}); inspect run.log`)); });
      });
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  processInfo(pid) {
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid PID');
    const value = this.ps(`Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object @{n='pid';e={$_.ProcessId}},@{n='parentPid';e={$_.ParentProcessId}},@{n='command';e={$_.CommandLine}},@{n='created';e={$_.CreationDate.ToString('o')}} | ConvertTo-Json -Compress`);
    return value ? JSON.parse(value) : null;
  }
  alive(identity) { return !!identity && sameProcess(this.processInfo(identity.pid), identity); }
  hostsCurrentProcess(service) {
    if (!service) return false;
    let processInfo = this.processInfo(process.pid);
    for (let depth = 0; processInfo && depth < 32; depth++) {
      if (sameProcess(processInfo, service.server) || sameProcess(processInfo, service.launcher)) return true;
      if (!processInfo.parentPid || processInfo.parentPid === processInfo.pid) return false;
      processInfo = this.processInfo(processInfo.parentPid);
    }
    return false;
  }
  listeners(port) {
    const raw = this.ps(`@(Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique) | ConvertTo-Json -Compress`);
    const value = raw ? JSON.parse(raw) : [];
    return Array.isArray(value) ? value : [value];
  }
  service(prefix, port) {
    const ids = this.listeners(port);
    if (!ids.length) return null;
    if (ids.length !== 1) throw new Error('Multiple port owners; refusing automatic cutover');
    const server = this.processInfo(ids[0]);
    if (!server) throw new Error('Listener disappeared');
    const launcher = this.processInfo(server.parentPid);
    const serverArgs = argv(server.command ?? '');
    const launcherArgs = argv(launcher?.command ?? '');
    const pkg = this.packageDir(prefix);
    if (!serverArgs.some(a => samePath(a, path.join(pkg, 'node_modules/next/dist/bin/next'))) || !serverArgs.includes('start') ||
        !launcherArgs.some(a => samePath(a, path.join(pkg, 'bin/pi-web.js')))) throw new Error('Port is not owned by a recognized default-global Pi Web launcher');
    const hostIndex = serverArgs.findIndex(a => a === '-H' || a === '--hostname');
    const portIndex = serverArgs.findIndex(a => a === '-p' || a === '--port');
    if (hostIndex < 0 || portIndex < 0 || Number(serverArgs[portIndex + 1]) !== port || !serverArgs[hostIndex + 1]) throw new Error('Cannot determine original host/port');
    return { server, launcher, host: serverArgs[hostIndex + 1] };
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
    const headers = this.env.PI_WEB_PASSWORD ? { Authorization: `Basic ${Buffer.from(`pi:${this.env.PI_WEB_PASSWORD}`).toString('base64')}` } : {};
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
      // Preserve ownership even if process inspection fails after a successful spawn.
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
          if (current && sameProcess(current.launcher, launcher) && samePath(data.home, os.homedir())) return current;
        } else await response.body?.cancel();
      } catch { /* Wait for readiness, but never claim an unrelated listener is healthy. */ }
      await sleep(1000);
    }
    throw new Error('New service failed runtime-home/HTTP/identity validation');
  }
  async stopNew(plan, launcher) {
    if (!launcher) return;
    if (launcher.unverifiedStartup) throw new Error('Startup process ownership could not be verified; stop it manually before rollback');
    const current = this.processInfo(launcher.pid);
    if (current && !sameProcess(current, launcher)) throw new Error('Startup launcher PID was reused; refusing rollback');
    const raw = this.ps(`@(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${Number(launcher.pid)}' | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress`);
    const childPids = raw ? JSON.parse(raw) : [];
    const children = (Array.isArray(childPids) ? childPids : [childPids]).map(pid => this.processInfo(pid)).filter(Boolean);
    if (!current && children.length) throw new Error('Orphaned startup children require manual recovery; do not overwrite their package');
    if (current) {
      // Windows SIGTERM on the launcher does not run its JS forwarding handler. Kill its verified
      // process tree, including a Next child that has not opened the port yet.
      if (!this.alive(launcher)) throw new Error('Startup launcher changed before tree shutdown; rollback refused');
      await this.run('taskkill.exe', ['/PID', String(launcher.pid), '/T', '/F'], { timeout: 20_000 });
    }
    for (let i = 0; i < 20; i++) {
      if (![launcher, ...children].some(identity => this.alive(identity))) break;
      if (i === 19) throw new Error('Owned startup processes did not exit; rollback refused');
      await sleep(250);
    }
    await this.waitFree(plan.port);
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
    const test = `const pty=require(require.resolve('node-pty',{paths:[${JSON.stringify(pkg)}]}));const p=pty.spawn(process.env.ComSpec||'cmd.exe',['/d','/c','echo pi-web-pty-ok'],{name:'xterm-color',cols:80,rows:24,env:process.env});let out='';const t=setTimeout(()=>{p.kill();process.exit(2)},10000);p.onData(d=>out+=d);p.onExit(e=>{clearTimeout(t);process.exit(e.exitCode===0&&out.includes('pi-web-pty-ok')?0:1)});`;
    await this.run(process.execPath, ['-e', test], { cwd: plan.runDir, timeout: 20_000 });
  }
  removeJunction(junction) { this.ps(`[System.IO.Directory]::Delete(${quotePS(junction)})`); }
}
