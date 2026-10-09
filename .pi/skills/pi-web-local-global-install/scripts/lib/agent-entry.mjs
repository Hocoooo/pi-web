#!/usr/bin/env node
import path from 'node:path';
import cp from 'node:child_process';
import { readPrivateJson, readLaunchEnvironment } from './mac-launchagent.mjs';

try {
  if (process.platform !== 'darwin' || process.getuid() === 0) throw new Error('User LaunchAgent only');
  const config = readPrivateJson(process.argv[2]);
  const env = readLaunchEnvironment(config.envFile, config.home);
  const child = cp.spawn(config.node, [path.join(config.packageDir, 'bin/pi-web.js'), '--port', String(config.port),
    '--hostname', config.hostname, '--no-open'], { cwd: config.packageDir, env, stdio: 'inherit' });
  let timer;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
    child.kill(signal);
    timer ??= setTimeout(() => child.kill('SIGKILL'), 10_000);
    timer.unref();
  });
  child.once('error', () => { console.error('Pi Web LaunchAgent could not start the CLI'); process.exitCode = 1; });
  child.once('exit', (code, signal) => {
    clearTimeout(timer);
    process.exitCode = code ?? (signal === 'SIGTERM' ? 0 : 1);
  });
} catch {
  // JSON errors can quote secrets; never print the original error or environment.
  console.error('Pi Web LaunchAgent configuration unavailable or invalid');
  process.exitCode = 1;
}
