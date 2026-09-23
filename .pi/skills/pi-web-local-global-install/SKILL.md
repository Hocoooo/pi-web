---
name: pi-web-local-global-install
description: Build this Pi Web checkout into a local npm tarball and install it into the machine's global npm prefix. Use for requests to package/install a local Pi Web version globally, bump its personal version before installation, or replace a running global Pi Web instance. This is not an npm publish workflow.
---

# Local Pi Web → global npm

Use the **isolated build → verified tarball → safe cutover → verified runtime** sequence. Work from the repo root (`git rev-parse --show-toplevel`). Report each completed gate; a staged install in another prefix is not a completed default-global upgrade.

## 1. Pin the source

- Check `git status --short`, `git log -1`, `package.json`, and the root `package-lock.json` version. Decide which changes the user intends to install. A detached worktree contains **committed** content only: handle intended uncommitted changes before creating it; leave unrelated logs/notes out.
- If asked to bump the version, run `npm version <version> --no-git-tag-version` and confirm all three version fields (`package.json`, lockfile top-level, lockfile `packages[""]`) agree. Commit the intended version change if building from HEAD; do not create a release tag or publish.
- Run the appropriate focused tests and `node_modules/.bin/tsc --noEmit`; record failures before packaging. Check `package.json` scripts and `bin/pi-web.js`: the global CLI uses `next start` and needs production `.next/BUILD_ID`.

**Gate:** the version and source commit to be packaged are unambiguous, and the checkout's `.next/dev` will remain untouched.

## 2. Build outside the checkout

Create a uniquely named temporary **git worktree outside this checkout** at the chosen commit: `git worktree add --detach <build-dir> <commit>`. On Windows, link the already-installed dependencies with `New-Item -ItemType Junction -Path <build-dir>\node_modules -Target <repo>\node_modules`; on Unix, use a symlink. Verify the target first. Run the repository's `npm run build` **from the worktree**, never from the active dev checkout.

Sanitize inherited build variables: `TURBOPACK=1` conflicts with this repo's `--webpack` build script, and a relative `NODE_OPTIONS=--require ./bin/stdio-guard.js` breaks npm lifecycle commands outside the checkout. Clear those inherited values for build/install commands; if webpack hits Node heap OOM, increase **only the build command's** `NODE_OPTIONS=--max-old-space-size=...` after checking available RAM. A previous Windows build required 16384 MB; it is not a universal default.

**Gate:** build exits successfully and `<build-dir>/.next/BUILD_ID` exists. If build fails, stop: do not pack stale artifacts.

## 3. Pack and inspect

Run `npm pack --dry-run --json` inside the built worktree. Verify its `version` is the requested version and its `files` include `.next/BUILD_ID` and the needed build output (this repo excludes `.next/dev`). Then run `npm pack --pack-destination <external-archive-dir>` and record the actual `.tgz` filename. Keep the tarball outside the repo until installation is verified. `npm install -g .` from the dev checkout is **not** a substitute for a production build.

**Gate:** the archive has the correct version and production build, with no unintended files.

## 4. Safe default-global cutover

- Inspect `npm prefix -g`, `npm ls -g --depth=0 @agegr/pi-web`, and the process listening on port 30141. On Windows use `netstat -ano`/`Get-NetTCPConnection` plus `Get-CimInstance Win32_Process` to check the **exact PID, parent PID, and command path**; on Unix use `lsof -nP -iTCP:30141 -sTCP:LISTEN`.
- If the old **global** Pi Web is running, get explicit permission to interrupt it. If it hosts the current conversation, arrange an independently running, logged cutover **after the response is delivered**, with enough delay for the user to read it. The cutover must verify process identity again before stopping the exact old server/launcher, install the tarball, and restore the original host/port and relevant environment. Prepare a known-good fallback and a way to inspect its log. Never kill an unidentified listener or use `npm --force` as an EBUSY workaround.
- Once the default global package is no longer in use, clear inherited relative `NODE_OPTIONS`/`TURBOPACK` and run `npm install -g <archive.tgz> --no-audit --no-fund`. A custom `--prefix` can stage/verify the package before cutover, but does **not** replace the normal `pi-web` command. With npm script-policy warnings, test functionality rather than changing the user's global policy without need.

**Gate:** the *default* `npm prefix -g` contains the newly installed version. If cutover was merely scheduled or only staged under another prefix, report it as pending.

## 5. Verify, then clean up

Check `npm ls -g --depth=0 @agegr/pi-web`, the installed `package.json` version, installed `.next/BUILD_ID`, `pi-web --help`, and native `node-pty` loading. If a running service was replaced, check that the original port is healthy **from the new global package**. A detached updater's success must be verified on reconnection; do not infer success from scheduling it. Report test gaps separately from installation status.

Remove the temporary worktree only after the archive is secure. On Windows delete the **junction itself, not its target** (`[System.IO.Directory]::Delete('<build-dir>\node_modules')` without recursion); confirm the original `<repo>\node_modules` still exists, then `git worktree remove --force <build-dir>` for generated build files. Preserve the tarball until the default-global upgrade succeeds; leave unrelated checkout files alone.
