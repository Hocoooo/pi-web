import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import cp from 'node:child_process';

export function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }
export function terminalCommand(node, script, socket, cwd) {
  return `cd ${shellQuote(cwd)} && exec /usr/bin/env -u NODE_OPTIONS -u TURBOPACK ${[node, script, socket].map(shellQuote).join(' ')}`;
}
export const TERMINAL_SCRIPT = 'on run argv\n tell application "Terminal"\n  do script (item 1 of argv)\n end tell\nend run';

/** Handoff only: no credentials on disk, in AppleScript, or on the command line. */
export async function delegateTerminal(host, plan, { open = openTerminal, timeout = 30_000 } = {}) {
  // Unix socket paths are short on macOS. A private directory prevents other users connecting.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-'));
  fs.chmodSync(directory, 0o700);
  const socketPath = path.join(directory, 's');
  const script = path.join(plan.runDir, 'runner', 'terminal-worker.mjs');
  const connections = new Set();
  const server = net.createServer(socket => { connections.add(socket); socket.on('close', () => connections.delete(socket)); });
  let timer;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    fs.chmodSync(socketPath, 0o600);
    return await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Terminal handoff timed out; old service was not stopped')), timeout);
      server.on('error', reject);
      server.on('connection', socket => {
        let data = '';
        socket.setEncoding('utf8');
        socket.on('error', () => {});
        socket.on('data', chunk => {
          data += chunk;
          if (data.length > 4096) { socket.destroy(); return; }
          if (!data.includes('\n')) return;
          socket.removeAllListeners('data');
          try {
            const hello = JSON.parse(data.slice(0, data.indexOf('\n')));
            if (!Number.isInteger(hello.pid)) throw new Error('Invalid handoff');
            const identity = host.processInfo(hello.pid);
            const details = host.processDetails(hello.pid);
            if (!identity || !details.argv.includes(script) || !details.argv.includes(socketPath)
              || host.processCwd(hello.pid) !== fs.realpathSync(plan.runDir)) throw new Error('Terminal worker identity mismatch');
            // The worker must acknowledge receiving the environment before lease publication.
            let acknowledgement = '';
            socket.on('data', chunk => {
              acknowledgement += chunk;
              if (acknowledgement.length > 64) reject(new Error('Invalid Terminal acknowledgement'));
              else if (acknowledgement.includes('\n')) {
                if (acknowledgement.trim() === 'ready') resolve(identity);
                else reject(new Error('Terminal worker did not acknowledge handoff'));
              }
            });
            socket.write(JSON.stringify({ runDir: plan.runDir, env: host.runtimeEnv }) + '\n');
          } catch { reject(new Error('Terminal worker handoff could not be verified')); }
        });
      });
      Promise.resolve(open(terminalCommand(process.execPath, script, socketPath, plan.runDir))).catch(reject);
    });
  } finally {
    clearTimeout(timer);
    for (const socket of connections) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function openTerminal(command) {
  return new Promise((resolve, reject) => {
    cp.execFile('/usr/bin/osascript', ['-e', TERMINAL_SCRIPT, command], { timeout: 25_000 }, error => {
      // Do not include AppleScript command or host output in errors.
      if (error) reject(new Error('Terminal delegation refused or unavailable; allow Automation access or run from Terminal'));
      else resolve();
    });
  });
}

export function receiveEnvironment(socketPath) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let data = '';
    const timer = setTimeout(() => socket.destroy(new Error('Terminal handoff expired')), 30_000);
    socket.setEncoding('utf8');
    socket.on('error', reject);
    socket.on('close', () => { clearTimeout(timer); reject(new Error('Terminal handoff closed')); });
    socket.on('connect', () => socket.write(JSON.stringify({ pid: process.pid }) + '\n'));
    socket.on('data', chunk => {
      data += chunk;
      if (data.length > 1024 * 1024) { socket.destroy(new Error('Handoff too large')); return; }
      if (!data.includes('\n')) return;
      try {
        const payload = JSON.parse(data.slice(0, data.indexOf('\n')));
        if (!payload.env || typeof payload.runDir !== 'string') throw new Error();
        socket.end('ready\n', () => { clearTimeout(timer); resolve(payload); });
      } catch { socket.destroy(new Error('Invalid Terminal handoff')); }
    });
  });
}
