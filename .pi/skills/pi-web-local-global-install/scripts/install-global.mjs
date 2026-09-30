#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, readJson, validatePlan } from './lib/policy.mjs';
import { WindowsHost } from './lib/host.mjs';
import { MacOSHost } from './lib/macos-host.mjs';

export function createHost(options, platform = process.platform) {
  if (platform === 'win32') return new WindowsHost(options);
  if (platform === 'darwin') return new MacOSHost(options);
  throw new Error('This installer supports Windows and macOS only');
}
import { inspectSource, createPlan, execute, worker, runsRoot } from './lib/workflow.mjs';

export const HELP = `Local Pi Web -> default-global npm (Windows/macOS, direct overwrite only)

  node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs run --restart
  node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs run --restart --defer 90
  node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs run --restart --no-wait
  node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs run --allow-dirty --restart --defer 90
  node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs run --dry-run
  node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs status [--run-dir PATH]
  node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs resume --run-dir PATH --restart --defer 90

Options for run:
  --commit REF                 Committed source (default HEAD); tracked edits must be committed first
  --allow-dirty                Owner opt-in: proceed with uncommitted tracked edits (not built; the build uses the committed ref)
  --restart                    Authorize service interruption/restart, or start if stopped
  --no-wait                    Explicitly skip idle wait; detached immediate cutover, requires --restart
  --defer SECONDS               Detached cutover delay, 1..3600; requires --restart
  --port PORT                  Service port (default 30141); existing hostname is preserved
  --heap-mb MB                  Build-only heap budget (default 4096, range 1024..16384)
  --skip-tests-reason REASON    Explicitly skip npm test; typecheck/build checks remain mandatory
  --dry-run                    Read-only source/service inspection; no files or packages are changed

Always uses an isolated worktree and npm ci; never builds in the checkout, publishes,
bumps versions, commits, tags, changes npm script policy, or kills unknown listeners.
No old-package backup or automatic rollback is performed. Failures after interruption
require manual recovery from the verified NEW archive; never blindly resume.
A scheduled update is NOT complete. Check status after reconnecting.
Run directories/logs/archives live in ../.pi-web-installs/. Credentials are not saved.
Interrupted cutover/recovery_required requires manual recovery, not blind resume.
`;

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv);
  if (options.command === 'help') { console.log(HELP); return; }
  const host = dependencies.host ?? createHost();
  let plan;
  if (options.command === 'run') {
    const source = inspectSource(host, options);
    if (options.dryRun) { console.log(JSON.stringify({ dryRun: true, ...source }, null, 2)); return; }
    plan = await (dependencies.createPlan ?? createPlan)(host, options, source);
  } else {
    let runDir = options.runDir;
    if (!runDir) {
      const repo = host.git(process.cwd(), 'rev-parse', '--show-toplevel');
      runDir = readJson(path.join(runsRoot(repo), 'latest.json')).runDir;
    }
    runDir = path.resolve(runDir);
    plan = validatePlan(readJson(path.join(runDir, 'plan.json')), runDir);
    if (plan.platform && host.platform && plan.platform !== host.platform) throw new Error('Run belongs to a different platform');
  }
  host.logFile = path.join(plan.runDir, 'run.log');
  console.log(`Run directory: ${plan.runDir}`);
  if (options.command === 'status') {
    const file = path.join(plan.runDir, 'status.json');
    const status = fs.existsSync(file) ? readJson(file) : { phase: 'prepared' };
    let installed;
    try { installed = host.installed(plan.prefix); } catch (error) { installed = { error: error.message }; }
    let service;
    try { service = host.service(plan.prefix, plan.port); } catch (error) { service = { error: error.message }; }
    const matches = !!plan.artifact && installed?.buildId === plan.artifact.buildId && installed?.version === plan.artifact.version;
    console.log(JSON.stringify({ ...status, installed, installedMatchesArtifact: matches, currentService: service }, null, 2));
    return;
  }
  if (options.command === 'worker') await worker(host, plan.runDir);
  else await (dependencies.execute ?? execute)(host, plan, options, options.command === 'resume');
  const status = readJson(path.join(plan.runDir, 'status.json'));
  console.log(JSON.stringify(status, null, 2));
  if (status.phase === 'scheduled') console.log('Cutover scheduled, NOT verified. Reconnect and run status.');
  if (['rolled_back', 'failed', 'recovery_required'].includes(status.phase)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
