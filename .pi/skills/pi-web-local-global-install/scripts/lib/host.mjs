import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { PACKAGE, samePath, sameProcess } from './policy.mjs';
import { LocalHost, sleep } from './local-host.mjs';
export { sleep } from './local-host.mjs';

const quotePS = value => `'${String(value).replaceAll("'", "''")}'`;
const argv = command => [...command.matchAll(/"([^"]*)"|(\S+)/g)].map(m => m[1] ?? m[2]);

export class WindowsHost extends LocalHost {
  constructor(options = {}) {
    super(options);
    if (process.platform !== 'win32') throw new Error('WindowsHost requires Windows');
    this.npmCli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
    this.tar = path.join(this.env.SystemRoot ?? 'C:\\Windows', 'System32/tar.exe');
    if (!fs.existsSync(this.npmCli) || !fs.existsSync(this.tar)) throw new Error('Node-bundled npm and Windows tar.exe are required');
  }
  ps(script) { return this.capture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]).replace(/^\uFEFF/, ''); }
  packageDir(prefix) { return path.join(prefix, 'node_modules', PACKAGE); }
  terminateCommand(pid) { cp.spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); }
  processInfo(pid) {
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid PID');
    const value = this.ps(`Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object @{n='pid';e={$_.ProcessId}},@{n='parentPid';e={$_.ParentProcessId}},@{n='command';e={$_.CommandLine}},@{n='created';e={$_.CreationDate.ToString('o')}} | ConvertTo-Json -Compress`);
    return value ? JSON.parse(value) : null;
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
  async stopNew(plan, launcher) {
    if (!launcher) return;
    if (launcher.unverifiedStartup) throw new Error('Startup process ownership could not be verified; stop it manually before recovery');
    const current = this.processInfo(launcher.pid);
    if (current && !sameProcess(current, launcher)) throw new Error('Startup launcher PID was reused; refusing recovery');
    const raw = this.ps(`@(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${Number(launcher.pid)}' | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress`);
    const childPids = raw ? JSON.parse(raw) : [];
    const children = (Array.isArray(childPids) ? childPids : [childPids]).map(pid => this.processInfo(pid)).filter(Boolean);
    if (!current && children.length) throw new Error('Orphaned startup children require manual recovery; do not overwrite their package');
    if (current) {
      if (!this.alive(launcher)) throw new Error('Startup launcher changed before tree shutdown; recovery refused');
      await this.run('taskkill.exe', ['/PID', String(launcher.pid), '/T', '/F'], { timeout: 20_000 });
    }
    for (let i = 0; i < 20; i++) {
      if (![launcher, ...children].some(identity => this.alive(identity))) break;
      if (i === 19) throw new Error('Owned startup processes did not exit; recovery refused');
      await sleep(250);
    }
    await this.waitFree(plan.port);
  }
  removeJunction(junction) { this.ps(`[System.IO.Directory]::Delete(${quotePS(junction)})`); }
}
