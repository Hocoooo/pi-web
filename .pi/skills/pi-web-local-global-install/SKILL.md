---
name: pi-web-local-global-install
description: Build this Pi Web checkout into a verified local npm tarball and directly overwrite the default global npm installation on Windows or macOS. Use for requests to install a local Pi Web version globally, optionally bump its personal version first, or replace/restart the running global service. No old-package backup or automatic rollback; uses the bundled installer and never npm publish.
compatibility: Requires Node and Git; Windows also requires PowerShell and tar.exe; macOS requires python3, ps, lsof, and BSD tar.
---

# Local Pi Web → global npm (Windows / macOS)

Use the bundled script, not a newly improvised build/cutover script. Work from the source repository root. Windows uses its Node-bundled npm CLI; macOS resolves `npm` on PATH to `npm-cli.js` and uses the default prefix's `lib/node_modules` directory. The macOS `python3` helper reads the owned launcher's NUL-delimited argv/environment without shell tokenization or saving credentials.

This is **direct overwrite only**: do not pack, retain, or reinstall an old-package backup. Only the verified **new** tarball and run evidence are produced. Failure after interruption may leave the package partially installed or the service stopped; recovery is manual, not an automatic rollback. Existing historical backups are not deleted by this skill.

## Decide what the user authorized

- For installation, default source is **committed HEAD**. Tracked changes must be committed first; do not commit unrelated work or silently omit intended changes. Untracked files are reported and excluded. `--commit REF` selects another committed version. Platform support does not implicitly authorize a dirty working-tree snapshot. **Only when the user explicitly accepts it**, `--allow-dirty` bypasses the tracked-changes refusal; the build still uses the committed ref, so those edits are not installed, and the plan records the dirty `trackedChanges`.
- Installation does **not** imply permission to stop a running service. Use `--restart` only when interruption/restart is explicitly authorized; it also starts a service if none is running.
- Normally a restart waits for active sessions to finish. If this Pi Web hosts the current conversation, use `--restart --defer 90` so the response can finish; use delayed mode when the hosting relationship is uncertain.
- For **restart only**, use `restart --defer 90` (no `run --restart` rebuild). It restarts the installed package, not checkout edits; dirty checkout is allowed. `restart --dry-run` is read-only.
- **macOS** defaults to Terminal delegation; it never falls back to detached/nohup/sudo. Automation permission may be required. An existing owned LaunchAgent retains its mode. Use `--macos-launch terminal` to explicitly migrate back; use `--macos-launch launchagent --macos-env-file /absolute/private-env.json` only after approval to register a persistent per-user login service and use an explicitly prepared 0600 JSON environment file. Never dump process.env or write credentials into the plist/command line. Read [the macOS lifecycle contract](../../../docs/branch-features/macos-service-lifecycle.md) before first registration. LaunchAgent does not inherit Terminal's TCC permissions. Maintenance currently still delegates its transaction to Terminal; the resulting LaunchAgent service is independent of that worker.
- **Only when the user explicitly asks not to wait / accepts immediate interruption**, use `--restart --no-wait`. It skips session-idle checks and launches the external worker immediately, even for self-hosted cutover. Do not silently add this flag to ordinary restart requests. A separately requested `--defer N` can be combined with `--no-wait` to delay the worker but still skip idle waiting.
- Version bumps are separate, explicit work. If requested, update package.json and both root lockfile version fields, validate, then commit before invoking the installer. The script never bumps versions, commits, tags, or publishes.

## Run

Read-only inspection on either supported platform:

```bash
node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs run --dry-run
node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs restart --dry-run
```

Restart the installed package without building/installing (with restart authorization):

```bash
node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs restart --defer 90
```

From an independent terminal, with an authorized ordinary restart:

```bash
node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs run --restart
```

From the service being replaced, with an authorized delayed restart:

```bash
node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs run --restart --defer 90
```

With explicit authorization to interrupt immediately, without waiting for idle:

```bash
node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs run --restart --no-wait
```

Omit `--restart` for an installation that must not stop or start a service; it refuses if the chosen port has an active global Pi Web. Default port is 30141; use `--port PORT` for a different service. An existing service's hostname is preserved. Unknown listeners are never stopped.

Installation checks are `tsc --noEmit`, `npm test` (five-minute deadline), and a production build. A failure stops before global changes. If the user explicitly accepts a documented test gap, `--skip-tests-reason "REASON"` skips only `npm test`; typecheck, build and install verification remain mandatory. Never add this option merely to make an install proceed.

## What remains verified

1. A unique detached worktree outside the active checkout; no build in its `.next`. Separate `npm ci --include=dev` dependencies, not a shared Junction/symlink. A checkout without node_modules bootstraps only the pinned lock guard into the external runner.
2. **Build-only** HOME/USERPROFILE and the agent directory point at empty directories outside the worktree; TEMP/TMP/TMPDIR stay outside the real home tree so the SDK's project-trust ancestor scan cannot mistake the operator's `~/.agents/skills` for a project resource. macOS uses OS temp; Windows uses `<runDir>/build-temp`, or `<SystemRoot>/Temp/pi-web-build/<run-name>` when the run directory is inside the original user profile. The runner creates these directories before checks; an unwritable location fails before cutover. Dependency installation retains real npm credentials/cache. Build heap defaults to 4096 MB; `--heap-mb` is an explicit bounded override.
3. Build must succeed and produce BUILD_ID before packing. Tarball manifest, actual version/BUILD_ID and SHA-256 are checked; cache/dev output, `.env` files and logs are rejected. Normal `.next/diagnostics` output is allowed.
4. The default npm prefix/package share a canonical lock across checkouts and TEMP settings. PID, creation time, parent, command and host/port are rechecked before stopping; macOS also requires the correct package cwd. macOS resolves `/var` aliases consistently even before a new prefix exists.
5. Cutovers use a copied external runner and runner-local lock dependencies. Windows delayed/no-wait workers remain detached. All macOS transactions use an acknowledged Terminal worker with private Unix-socket environment handoff before lease transfer/stopping. Terminal-mode service remains attached to it; LaunchAgent-mode service is started by GUI launchd after bootout. Original service environment stays in memory; LaunchAgent instead uses the owner's explicit private environment file (never an automatic environment dump). Temporary build home/options never reach the restarted service.
6. Verify installed version **and BUILD_ID**, `npm ls`, CLI help and native node-pty (`cmd.exe` on Windows, `/bin/sh` on macOS). Service checks require the correct endpoint, owned process identity and original runtime home. macOS also checks `/api/service/health` for user lookup, system DNS, real child-process probes and configured read-only paths. Only healthy checks mark `verified`; missing diagnostics in older packages or failed checks produce `degraded`, retain the running service for diagnosis and never trigger a restart loop. Only installation runs have a worktree to clean.
7. Failed interruption/install/startup is recorded as `recovery_required`. The updater may stop its own positively identified failed startup, but **never restores the old package**, overwrites files under an unknown process, or claims success after a failed install.

## Report and reconnect

The script prints a run directory under the repository's sibling `.pi-web-installs/<repo-key>/`. It contains `plan.json`, `status.json`, `run.log`, the new archive, and detached-worker `updater.log` / `service.log`.

```bash
node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs status
node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs status --run-dir "ABSOLUTE_RUN_DIRECTORY"
```

- `scheduled` means **pending**, not installation success. For normal deferred mode, deliver the response before cutover and ask the user not to start new tasks. For `--no-wait`, the session may disconnect immediately; use the durable status after reconnecting.
- After reconnect, inspect status **and current installation/service**. Report commit, version, BUILD_ID, prefix, endpoint and validation gaps; an old `verified` record alone is insufficient.
- `degraded` means startup/identity passed but runtime capabilities failed or could not be checked. This is not verified. Inspect `currentRuntimeHealth` from status; old installed packages without the endpoint report unavailable. Diagnose before another restart; do not resume or automatically loop.
- `recovery_required` means the update did not complete safely. There is no old-package backup. Read [troubleshooting](references/troubleshooting.md), verify process ownership, and recover from a verified new archive or a separately selected release only with owner authorization.
- Resume is limited to pre-cutover failures. Never blindly resume `stopping`, `installing`, `starting` or `recovery_required`.

## Boundaries

Do not use `npm install -g .` from the dev checkout, `npm --force` for file-in-use errors, or silently alter npm script policy. Do not delete unknown processes, locks, old artifacts or directories to force progress. A successful fixture/dry-run is not evidence of a live replacement.

Run these after changing the installer:

```bash
node --experimental-strip-types --test lib/local-global-install.test.mjs lib/local-global-install.macos.test.mjs lib/macos-service.test.mjs lib/service-health.test.mjs
```

The tests use isolated fixtures; the native macOS probe only creates/stops its own disposable Node process. They do not replace or restart the actual global service. Source changes to the skill do not themselves authorize another live install.
