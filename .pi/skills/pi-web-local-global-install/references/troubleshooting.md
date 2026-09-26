# Installer recovery and operational boundaries

Paths and commands below are relative to the source repository root. Replace `RUN` with the absolute directory printed by the installer. No manual recovery command should be executed until the current process and package identities are understood.

## Commands

```bash
node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs --help
node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs run --dry-run
node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs status --run-dir "RUN"
node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs resume --run-dir "RUN" --restart --defer 90
```

`run --dry-run` is read-only; it reports tracked changes but does not accept them for an actual installation. `resume` intentionally does not accept `--dry-run`, new source references, heap/test settings, or a new port. It retains the original source/validation contract and rechecks restart authorization and current service identity. It may reuse an integrity-checked archive; incomplete build output is discarded and rebuilt. To change source or the original build options, start a new run after resolving any lock/recovery state.

The default test command is the repository's full `npm test`. Current local/platform-specific failures may block it. Investigate or obtain explicit acceptance of a test gap before starting a new run with `--skip-tests-reason`. There is no automatic bypass and no implicit test skipping in resume.

## States and artifacts

- `building`, `built`, `packed`, `backing_up`: global installation is untouched.
- `scheduled`: copied worker owns the prefix lease, waits the requested delay, then waits up to ten minutes for running sessions to finish. The API check supports the application's `pi` Basic Auth username if `PI_WEB_PASSWORD` is present in the inherited environment.
- `stopping`, `installing`, `starting`: global mutation may have begun. A hard crash here requires manual diagnosis, not forward resume.
- `verified`: requested BUILD_ID was installed and required checks passed. `status` also reports the currently installed build and current listener; investigate any mismatch.
- `rolled_back`: the requested upgrade failed; the previous archive and, if originally running, service were restored and checked. Explicit resume can retry after confirming the old build still matches.
- `failed`: a pre-interruption check failed, and this process had not yet stopped or replaced the service. Inspect `run.log` and the error before retrying. A detached worker uses the same rule: it does not relabel `stopping`, `installing`, `starting`, or `rolling_back` as `failed`.
- `recovery_required`: automatic restoration could not be completed safely, or this process already interrupted the installation and could not persist a more specific phase. Preserve all archives and logs. Do not repeatedly run install commands over possibly live processes. Resume refuses this phase.

`plan.json` records source commit, package version, original installation and process identity, artifact hashes, build options and test-skip reason if any. It does not store credentials or an environment dump. New and fallback archives live in separate directories even if both versions have the same number. Identify builds by BUILD_ID and SHA-256, not filename/version alone.

## Locks and interrupted workers

The durable lease lives under the **canonical default npm prefix** in `.pi-web-installer/`. It is not tied to the caller's TEMP directory or checkout. A second installer cannot proceed for the same prefix/package. The lease records the run and owner process identity. Explicit resume can recover only the same abandoned run after the owner is no longer alive; PID reuse is checked using creation time, parent and command.

Short file mutations use `proper-lockfile`. The runner copies that package and its dependency graph from the checkout when present. A checkout without `node_modules` bootstraps only `proper-lockfile@4.1.2` into the external runner (`npm install --prefix`, `--ignore-scripts`, no save, no lockfile write, no change to the source tree or global package). The updater never loads the guard from the global installation it is replacing. The short guard has bounded contention waiting and a two-minute stale expiry for hard crashes. If a crash abandoned the guard, wait for expiry and retry status/resume rather than deleting a live lock.

The durable lease is published by writing a complete sibling temp file and renaming it over the lease while the short guard is held. A crash before that rename does not leave a truncated lease. A lease that is already unreadable fails closed: resume reports `Corrupt lease requires manual inspection` and does not invent an owner. Inspect the run directory, confirm the owner is dead, and only then remove that lease by hand.

A worker handoff is acknowledged in `worker-ready.json`. If handoff fails or its controller disappears, inspect owner identity, `status.json`, and `updater.log` before taking action. Do not start a second run simply because the first command returned an error; a detached worker may already own the lease.

## Build environment and OOM

The observed Windows failure was not fixed by increasing heap from 4 to 16 GiB. Next's bundled NFT tracer expanded runtime directory operations into `C:/Users/<user>/**/*`. Its parent-path test did not exclude a different drive's absolute path. With a same-drive empty build home outside the worktree, the same application compiled successfully with a 4 GiB heap.

The installer therefore isolates HOME, USERPROFILE, TEMP, TMP and TMPDIR **only for typecheck/tests/build**. It does not change persistent user environment variables. npm dependency installation uses real npm configuration/auth/cache and explicitly includes dev dependencies. Install and helper commands strip inherited NODE_OPTIONS/TURBOPACK; service startup retains the original runtime values. A detached worker transports those two runtime values in its inherited environment, never in a JSON plan.

If a build still runs out of memory, preserve `run.log`, confirm it is building in its own worktree, and investigate before increasing `--heap-mb`. A failed build cannot be packed. Do not run `next build` in the active checkout and do not substitute `next dev --webpack`.

## Installation and runtime failures

The script verifies the default npm prefix immediately before global mutation. It never uses an alternate prefix and claims the default command was upgraded. Existing global files in use are handled by stopping the authorized, identified service, not by npm `--force`.

After installation, checks cover package version/BUILD_ID, global npm listing, CLI help, native `node-pty` spawning and, when launching, HTTP `/api/home` plus process identity and real runtime home. The temporary build home must not reach the running service.

A launcher's Windows termination does not reliably execute its JavaScript signal-forwarding handlers. Rollback stops the verified startup **process tree**, including children that never listened. If ownership cannot be established, a launcher PID was reused, or orphaned startup children cannot safely be attributed, the script refuses to overwrite the package and reports `recovery_required`.

For manual restoration:

1. Inspect the current listener, launcher, creation times and command paths against the run manifest and status. Stop only processes you have positively identified and are authorized to interrupt.
2. Verify fallback archive SHA-256 against the manifest and confirm the port is free.
3. With inherited build-only variables removed, install the fallback archive into the original default prefix. Do not change npm's global script policy simply to silence warnings.
4. Restore the original host/port and relevant real runtime environment. Credentials must come from the operator's environment, not a log or plan file.
5. Recheck installed BUILD_ID, CLI/native terminal and HTTP health. Record recovery; resolve the abandoned lease only after the owner is confirmed dead.

The fallback tarball is an app-package backup, not an exact snapshot of every transitive dependency. npm ranges can resolve differently. On a first installation there is no previous archive; a failure after package mutation needs manual cleanup/recovery rather than a claimed rollback.

## Cleanup and retention

A verified run removes only its own detached worktree after checking its path, commit, clean tracked content and real directory identity. It refuses to recurse through an unexpected dependency Junction. A cleanup failure is logged and must not roll back a healthy installation.

Successful archives, status and logs are retained for rollback/inspection. No automatic retention deletion is performed in this version. Remove old run directories only after confirming they own no running updater, contain no worktree still registered with Git, and are no longer needed for recovery. Never recursively delete a dependency Junction's target.

## Testing scope

`lib/local-global-install.test.mjs` exercises argument safety, environment separation, archive checks, prefix leases, atomic lease publication, corrupt-lease refusal, stale-guard recovery, worker ownership handoff, process identity, startup-tree cleanup, transaction/rollback ordering, failed status writes during rollback, failed-build behavior, source/cleanup boundaries, runner-local locking, and bootstrapping the guard into a checkout that has no `node_modules`. Most operations use fixtures or injected adapters; they do not perform a global installation or interrupt the running service.

A real `run --dry-run` can verify platform discovery without mutating the install. Passing fixture tests is not evidence that a new script version has completed a live cutover. Live installation/restart remains a separate, explicitly authorized operation.
