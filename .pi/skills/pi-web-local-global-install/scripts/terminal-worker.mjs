#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import { receiveEnvironment } from './lib/mac-terminal.mjs';
import { MacOSHost } from './lib/macos-host.mjs';
import { worker } from './lib/workflow.mjs';
import { readJson } from './lib/policy.mjs';

try {
  if (process.platform !== 'darwin' || process.getuid() === 0) throw new Error('A logged-in macOS user is required');
  // Check the newly delegated context BEFORE accepting any stop/install authority.
  if (os.userInfo().uid !== process.getuid()) throw new Error('Terminal user lookup failed');
  const { env, runDir } = await receiveEnvironment(process.argv[2]);
  const host = new MacOSHost({ env, logFile: path.join(runDir, 'run.log') });
  host.terminalDelegated = true;
  host.capture('/bin/launchctl', ['print', `gui/${process.getuid()}`]);
  await worker(host, runDir);
  const status = readJson(path.join(runDir, 'status.json'));
  console.log(`Pi Web operation: ${status.phase}. Status: ${path.join(runDir, 'status.json')}`);
  if (status.phase === 'degraded') {
    console.error('Service retained for diagnosis: runtime checks failed or are unavailable. Not verified.');
    process.exitCode = 1;
  }
  // Terminal-mode CLI is an attached child: this worker remains alive until it exits.
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
