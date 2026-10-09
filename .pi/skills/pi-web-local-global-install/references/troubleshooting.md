# Installer recovery and operational boundaries

Commands below are relative to the repository root. Supports Windows and macOS; Linux is refused. Never execute a recovery command until current package and process identities are understood.

## Commands

```bash
node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs --help
node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs run --dry-run
node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs restart --dry-run
node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs restart --defer 90
node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs run --restart --defer 90
node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs run --restart --no-wait
node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs status --run-dir "RUN"
node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs resume --run-dir "RUN" --restart --defer 90
```

`--no-wait` requires explicit authorization to interrupt active sessions, and also requires `--restart`. It skips idle checks, not build or verification. The external worker starts with zero delay unless `--defer` was separately supplied. Ordinary restarts still wait for idle, and self-hosted ordinary restarts require deferral.

`run --dry-run` is read-only and reports dirty/untracked source. Real runs still use committed source. Resume cannot accept new source, heap, test-skip settings or `--dry-run`; it only reuses integrity-checked pre-cutover work. Restart/no-wait permissions must be confirmed for that resume.

`restart` only restarts the installed package, with no global npm install or build; it still verifies package/CLI/native/service health. macOS launch modes and their authorization are specified in [the lifecycle contract](../../../../docs/branch-features/macos-service-lifecycle.md). All macOS maintenance transactions currently use a Terminal worker, including LaunchAgent updates; the LaunchAgent service itself has an independent lifetime.

Default installation tests are the full `npm test`. A documented test gap needs explicit acceptance before `--skip-tests-reason`. There is no automatic bypass.

## Direct overwrite, states and artifacts

**There is no old-package backup and no automatic rollback on either platform.** Only the new verified archive is created. Existing historic backups from earlier installers are not deleted.

- `building`, `built`, `packed`: global installation is untouched.
- `scheduled`: external worker owns the lease; pending, never success. Normal mode observes delay and then waits for idle; `--no-wait` skips the idle wait.
- `stopping`, `installing`, `starting`: service interruption/package mutation may have begun. A crash requires diagnosis, not forward resume.
- `degraded`: service startup/identity passed but macOS runtime checks failed or were unavailable (including old packages without `/api/service/health`). The service is retained for diagnosis, not automatically restarted. This is not verified and cannot be resumed. `status` includes fresh `currentRuntimeHealth` when the service is recognized.
- `verified`: requested version/BUILD_ID and required CLI/native/service checks passed. Compare the record against the current installation and listener.
- `failed`: a pre-interruption failure; no global cutover started.
- `recovery_required`: interrupted overwrite or failed startup needs manual recovery. The package may be partial and the old service may be stopped. There is no automatic restoration of a prior archive.

`plan.json` stores commit, platform, version, old package/process **identity metadata**, the new archive/hash, build settings and test-skip reason. Identity metadata is not an old-package backup. Credentials/environment dumps never belong in plan files. Same version numbers do not imply the same build: compare BUILD_ID and SHA-256.

Status can still display legacy `rolling_back` / `rolled_back` records, but the current flow never creates a fallback archive or performs rollback. Resume refuses interrupted legacy phases too.

## Prefix locks and handoff

The durable lease lives below the canonical default npm prefix in `.pi-web-installer/`, shared across checkouts and TEMP settings. Resolve existing ancestors before first prefix creation: on macOS `/var` can alias `/private/var`, and the lease must not change its key when the directory appears.

`proper-lockfile` serializes lease mutations. The runner has its own copied package/dependency graph; a dependency-free checkout bootstraps only `proper-lockfile@4.1.2` with no save/lockfile/scripts. Resolve module paths canonically before accepting a runner-local dependency. The updater never imports locking code from the installed package it replaces.

Lease publication is a complete atomic JSON rename. Unreadable leases fail closed. Only the same run and a confirmed dead owner can use explicit pre-cutover resume. A stale guard expires after two minutes; do not delete a live owner's lease/guard to force progress.

`worker-ready.json` acknowledges handoff. Inspect status, plan, worker identity and updater.log if acknowledgement fails; do not launch a second installer merely because a controller returned an error. Immediate self-hosted cutover can disconnect the controller after handoff.

## macOS dependencies and identity

macOS requires Node/Git plus executable `npm`, `python3`, `/bin/ps`, `/usr/sbin/lsof`, `/usr/bin/tar`, `/usr/bin/osascript` and `/bin/launchctl`. A logged-in GUI user and Terminal Automation permission are required for maintenance delegation; root is refused for restart. `npm` on PATH must resolve to `npm-cli.js`. The package lives at `<default-prefix>/lib/node_modules/@agegr/pi-web`, unlike Windows's `<prefix>/node_modules` layout.

The native Python helper reads `KERN_PROCARGS2` over an anonymous pipe. Argv values are NUL-delimited, so paths with spaces are not split using `ps` text. Only after cwd, launcher and Next identity are recognized is the original launch environment read; it stays in memory and is inherited by the external worker/service, never persisted. Lack of inspection permission is a blocker, not permission to guess process ownership.

Terminal delegation denial/timeout leaves the old service untouched. Do not bypass it with `nohup`, detached spawning, sudo, permission broadening, or credential dumps. If the calling context already cannot reach GUI launchd/Automation, initiate the same authorized command from a healthy Terminal instead.

LaunchAgent mode must be explicitly authorized on first use. Its user-supplied environment JSON must be an absolute, owner-only 0600 regular file with the original HOME and explicit PATH; never paste real secrets in chat. Plist/config contain paths only, not environment values. Existing password/agent-home/required provider credential must not silently change. Do not auto-copy Terminal's entire environment or grant general Node Full Disk Access. A LaunchAgent has its own TCC context; test needed folders/automation explicitly.

The installer refuses unknown jobs or modified plists. Owned jobs are booted out before replacement; KeepAlive is disabled, so crashes and diagnostic failures do not loop. The login registration persists in `~/Library/LaunchAgents/`; private helpers/config/logs are under `~/Library/Application Support/Pi Web/`. To migrate back, explicitly use `restart --macos-launch terminal --defer 90`; this removes the confirmed owned registration, not the user's env file. Changing an existing env-file path is a manual migration, not a silent rewrite.

A listener must be the recognized Next server, have a recognized global Pi Web CLI parent, and have the correct package cwd. PID, creation time, parent and command are rechecked. SIGTERM is followed by a bounded, identity-checked SIGKILL only for the already authorized exact process. A brief zombie (`Z`, `<defunct>`) is already exited, not a live reused PID. After SIGTERM, macOS can briefly return `?E` (trying to exit) with a shortened `(node)` command. The updater only waits through that state for the same PID/creation time; it never uses that shortened command to authorize an additional signal. Unknown/reused processes are never stopped.

## Build environment

Compilation/typecheck/tests isolate HOME, USERPROFILE, PI_CODING_AGENT_DIR, TEMP, TMP and TMPDIR outside the worktree. macOS uses OS temp. Windows OS temp is normally under the original user profile, which makes the SDK's ancestor scan find the operator's `.agents/skills` after HOME is isolated. Windows therefore uses `<runDir>/build-temp` outside the original profile, or `<SystemRoot>/Temp/pi-web-build/<run-name>` for a profile-nested run directory. The runner creates HOME and TEMP before checks; permission errors are pre-cutover failures, not a reason to fall back to the original profile. Explicit agent-dir overrides must not pull real user configuration into build tracing. Dependency installation keeps real npm auth/cache; install commands strip inherited NODE_OPTIONS/TURBOPACK, while the service retains the original runtime values.

Build heap defaults to 4096 MB. If a build fails/OOMs, preserve run.log and inspect isolation before requesting a larger bounded heap. Never build in the active checkout's `.next` or pack a failed/stale build. Never substitute `next dev --webpack`.

## Interrupted installation and manual recovery

1. Inspect status, actual package version/BUILD_ID, listener, launcher and creation/command identity. Do not infer completion from an archive filename or scheduled status.
2. Stop only a positively identified process with explicit authorization. A failed new startup may be stopped by the updater when owned; unknown ownership remains a manual blocker.
3. Verify the **new** archive's SHA-256 from the plan. With the original default prefix and port free, retry its global install only after understanding the failure. Alternatively select a release separately with owner authorization; the installer has no prior-package archive to restore.
4. Do not use npm `--force`, disable script policy or overwrite files used by unknown processes. Restore the real runtime home, hostname/port and credentials from the owner environment, never from logs.
5. Recheck package BUILD_ID, `npm ls`, CLI/native terminal and HTTP/process identity. Resolve abandoned locks only after confirming the worker is dead. Record recovery; do not silently label an interrupted run verified.

Failures while saving status must not relabel interrupted mutation as a harmless pre-install failure. `installing`/`starting` may remain the last durable state if `recovery_required` could not be written; they still refuse resume.

## Cleanup and validation scope

A verified run removes only its owned Git worktree after checking path, commit, clean tracked content and non-symlink node_modules. Cleanup failure is logged and does not undo a healthy install. New archive/status/logs are retained; there is no automatic deletion of old run directories.

```bash
node --experimental-strip-types --test lib/local-global-install.test.mjs lib/local-global-install.macos.test.mjs lib/macos-service.test.mjs lib/service-health.test.mjs
```

Fixtures cover options, leases, handoff, dependency bootstrapping, canonical macOS paths, archive checks, overwrite ordering, failure states and owned startup cleanup. The native macOS probe inspects/stops only its own disposable Node process. A real macOS `run --dry-run` checks discovery without installing or restarting. Windows native live cutover and actual macOS global replacement through this new script require separate owner authorization; fixture success alone does not prove deployment.
