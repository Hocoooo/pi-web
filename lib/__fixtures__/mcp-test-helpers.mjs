import { rm, symlink } from "node:fs/promises";

// One hook per test: a failed cwd removal must not skip another session's shutdown.
const sessionCleanups = new WeakMap();
export function registerMcpSessionCleanup(t, wrapper, cwd) {
  let sessions = sessionCleanups.get(t);
  if (!sessions) {
    sessions = [];
    sessionCleanups.set(t, sessions);
    t.after(async () => {
      const results = await Promise.allSettled(sessions.map(async (session) => {
        try {
          await session.wrapper.shutdown();
        } finally {
          // Windows retains a child's cwd until it exits, including a late handshake.
          // Retry delays total at most 5.5 s; do not turn a persistent lock into a suite hang.
          await rm(session.cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        }
      }));
      const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
      if (errors.length) throw new AggregateError(errors, "MCP fixture cleanup failed");
    });
  }
  sessions.push({ wrapper, cwd });
}

// SDK 1.0 uses Git Bash on Windows. Quote paths and retain spaces/backslashes as data.
export function markerCommand(path, output) {
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const shellPath = process.platform === "win32" ? path.replaceAll("\\", "/") : path;
  return `!touch ${quote(shellPath)} && echo ${quote(output)}`;
}

// A file link cannot be replaced by a junction. Skip only this link-specific test
// when Windows denies symlink creation; unexpected fixture errors still fail.
export async function fileSymlinkOrSkip(t, target, path) {
  try {
    await symlink(target, path, "file");
    return true;
  } catch (error) {
    if (process.platform !== "win32" || !["EPERM", "EACCES", "ENOTSUP", "ENOSYS"].includes(error.code)) throw error;
    t.skip(`File symlinks unavailable on this filesystem (${error.code})`);
    return false;
  }
}
