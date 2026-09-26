---
name: pi-web-local-global-install
description: Build this Pi Web checkout into a verified local npm tarball and install it into the default global npm prefix on Windows. Use for requests to install a local Pi Web version globally, optionally bump its personal version first, or replace/restart the running global service. Uses the bundled installer; never npm publish.
---

# Local Pi Web → global npm

Use the bundled script, not a newly improvised build/cutover script. This version supports **Windows only** and requires Node, Git, PowerShell, and Windows `tar.exe`. Work from the source repository root. A fresh checkout does not need `npm install` first: the installer copies `proper-lockfile` when the checkout already has it, and otherwise installs only that pinned guard into the external run directory.

## Decide what the user authorized

- Default source is **committed HEAD**. Tracked changes must be committed first; do not commit unrelated work or silently omit intended changes. Untracked files are reported and excluded. `--commit REF` selects another committed version.
- Installation does **not** imply permission to stop a running service. Use `--restart` only when interruption/restart is explicitly authorized; it also starts a service if none is running.
- If this Pi Web hosts the current conversation, use `--restart --defer 90`. The script refuses an identified self-hosted foreground cutover, but do not rely on ancestry detection alone: use delayed mode whenever the hosting relationship is uncertain.
- Version bumps are separate, explicit work. If requested, update package.json and both root lockfile version fields, validate, then commit before invoking the installer. The script never bumps versions, commits, tags, or publishes.

## Run

Read-only inspection, including source, uncommitted changes, npm prefix and listener identity:

```bash
node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs run --dry-run
```

From an independent terminal, when restart is authorized:

```bash
node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs run --restart
```

From the service being replaced, when restart is authorized:

```bash
node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs run --restart --defer 90
```

Omit `--restart` for an installation that must not stop or start a service; it refuses if the chosen port has an active global Pi Web. Default port is 30141; use `--port PORT` for a different service. An existing service's hostname is preserved. Unknown listeners are never stopped.

Default checks are `tsc --noEmit`, `npm test` (five-minute deadline), and a production build. A failure stops before global changes. If the user explicitly accepts a documented test gap, `--skip-tests-reason "REASON"` skips only `npm test`; typecheck, build and install verification remain mandatory. Never add this option just to make an install proceed.

## What the script guarantees

1. A unique detached worktree outside the active checkout; no build in its `.next`. Separate `npm ci --include=dev` dependencies rather than an unverified shared Junction.
2. **Build-only** HOME/USERPROFILE and TEMP/TMP point at empty directories outside the worktree on the same drive. This prevents Next/NFT from expanding runtime user-directory discovery across drives. Dependency installation retains real npm credentials/cache. Build heap defaults to 4096 MB; `--heap-mb` is an explicit bounded override, not an automatic OOM retry.
3. Build must succeed and produce BUILD_ID before packing. npm manifests and actual tarball identity/BUILD_ID are checked. Archives receive SHA-256 hashes; cache/dev output, `.env` files and logs are rejected. Normal `.next/diagnostics` output is allowed.
4. The default npm prefix and package share a lock across checkouts and TEMP settings. An existing global installation is archived for rollback. PID, creation time, parent and command identity are rechecked after waiting for active sessions to finish.
5. Delayed cutover runs from a copied runner whose lock dependency lives in that runner, independently of this session, the source checkout, and the global package being replaced. Secrets remain in inherited process environment, not plan files. The real runtime home and Node options are restored for service launch.
6. Verify installed version **and BUILD_ID**, `npm ls`, CLI help and native `node-pty`; if starting a service, verify the original endpoint, process identity and runtime home. Only then mark `verified` and clean the owned worktree. Failed installation attempts restore the prior archive when safe; unknown startup-process ownership fails closed instead of overwriting files in use.

## Report and reconnect

The script prints a run directory under the repository's sibling `.pi-web-installs/<repo-key>/`. It contains `plan.json`, `status.json`, `run.log`, archives and, for delayed execution, `updater.log` and `service.log`.

```bash
node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs status
node .pi/skills/pi-web-local-global-install/scripts/install-global.mjs status --run-dir "ABSOLUTE_RUN_DIRECTORY"
```

- `scheduled` means **pending**, never installation success. Deliver the reply before cutover and ask the user not to start new tasks. Delay is followed by an idle-session wait, not a forced interruption of active work.
- After reconnect, inspect status and the current installation/service. Report commit, version, BUILD_ID, default prefix, endpoint and validation gaps. An old `verified` record alone does not prove the current service still matches it.
- `rolled_back` means the upgrade failed and the old package was restored, not successful installation of the requested version.
- For recoverable pre-cutover failures, read [troubleshooting](references/troubleshooting.md) before using `resume`. Never blindly restart from `stopping`, `installing`, `starting`, `rolling_back`, or `recovery_required`.

## Boundaries

Do not use `npm install -g .` from the dev checkout, `npm --force` for EBUSY, or silently alter npm's allow-scripts policy. Tarball rollback restores the app package, **not a byte-for-byte dependency snapshot**. Do not delete unknown processes, locks or directories to force progress. The installer supports bounded pre-cutover resume, not unattended recovery from every possible OS crash.

For implementation details, OOM diagnosis, retention and manual recovery, read [troubleshooting](references/troubleshooting.md). Run `node --experimental-strip-types --test lib/local-global-install.test.mjs` after changes to the script; it uses isolated fixtures and does not install or restart the global service.
