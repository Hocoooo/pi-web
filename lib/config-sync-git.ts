import { execFile } from "node:child_process";

export class ConfigSyncError extends Error {
  constructor(message: string, public code = "invalid-config", public status = 400, public applied = false) {
    super(message);
    this.name = "ConfigSyncError";
  }
}

export interface SyncFile {
  data: Buffer;
  mode: "100644" | "100755";
}
export type SyncFiles = Map<string, SyncFile>;

export const RESOURCE_DIRS = ["skills", "agent-skills", "agents", "extensions", "prompts", "themes"] as const;
export const ROOT_FILES = ["models.json", "settings.json", "AGENTS.md", "SYSTEM.md", "APPEND_SYSTEM.md"] as const;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 3000;

export function isSyncPath(path: string): boolean {
  return (ROOT_FILES as readonly string[]).includes(path) || RESOURCE_DIRS.some((dir) => path.startsWith(`${dir}/`));
}

export function validateSyncFiles(files: SyncFiles): void {
  let total = 0;
  const names = new Set<string>();
  for (const [path, file] of files) {
    if (!isSyncPath(path) || path.length > 512 || path.split("/").some((part) => (
      !part || part === "." || part === ".." || /[\\:\x00-\x1f]/.test(part) || /[. ]$/.test(part)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
      || /^(?:\.git|node_modules|\.env(?:\..*)?|auth\.json|mcp-auth\.json)$/i.test(part)
    ))) throw new ConfigSyncError(`Unsupported sync path: ${path}`, "invalid-path");
    if (names.has(path.toLowerCase())) throw new ConfigSyncError(`Case-conflicting sync path: ${path}`, "invalid-path");
    names.add(path.toLowerCase());
    total += file.data.length;
    if (file.data.length > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES || files.size > MAX_FILES) {
      throw new ConfigSyncError("Configuration exceeds 3,000 files, 10 MiB per file, or 50 MiB total", "size-limit");
    }
  }
}

export function validateRepository(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048 || /[\s\x00-\x1f]/.test(value)) {
    throw new ConfigSyncError("Use an HTTPS or SSH Git repository without embedded credentials");
  }
  if (/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+:[a-zA-Z0-9_./-]+$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (!["https:", "ssh:"].includes(url.protocol) || !url.hostname || !url.pathname || url.pathname === "/"
      || url.password || (url.protocol === "https:" && url.username) || url.search || url.hash) throw new Error();
    return value;
  } catch {
    throw new ConfigSyncError("Use an HTTPS or SSH Git repository without embedded credentials");
  }
}

export function validateBranch(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 200 || value.startsWith("-")
    || value.startsWith("/") || value.endsWith("/") || value.endsWith(".") || value.includes("..")
    || value.includes("@{") || /[\s~^:?*\[\\\x00-\x1f]/.test(value)
    || value.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))) {
    throw new ConfigSyncError("Invalid Git branch name");
  }
  return value;
}

/** Never return Git stderr: credential helpers and remote errors may echo tokens. */
export function syncGit(cwd: string, args: string[], input?: string | Buffer): Promise<Buffer> {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === "PI_WEB_PASSWORD" || key === "PORT" || key === "NODE_ENV" || key.startsWith("NEXT_")
      || ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"].includes(key)) delete env[key];
  }
  Object.assign(env, { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", LC_ALL: "C" });
  env.GIT_SSH_COMMAND ??= "ssh -oBatchMode=yes";
  return new Promise((resolve, reject) => {
    const child = execFile("git", [
      "-c", "core.hooksPath=", "-c", "commit.gpgSign=false", "-c", "protocol.ext.allow=never",
      "-c", "user.name=Pi Web Config Sync", "-c", "user.email=config-sync@localhost", "-C", cwd, ...args,
    ], { env, windowsHide: true, encoding: "buffer", timeout: 90_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(new ConfigSyncError(
        `Git ${args[0]} failed. Check Git availability, repository access, credentials and branch; retry after resolving any remote change.`,
        "git-failed", 502,
      ));
      else resolve(stdout);
    });
    child.stdin?.on("error", () => { /* Git's exit status reports a closed input pipe. */ });
    child.stdin?.end(input);
  });
}

export async function fetchSyncHead(cwd: string, repository: string, branch: string): Promise<string | null> {
  await syncGit(cwd, ["init", "--template=", `--initial-branch=${branch}`]);
  await syncGit(cwd, ["remote", "add", "origin", repository]);
  const heads = (await syncGit(cwd, ["ls-remote", "origin", `refs/heads/${branch}`])).toString().trim();
  if (!heads) return null;
  await syncGit(cwd, ["fetch", "--depth=1", "--no-tags", "origin", `refs/heads/${branch}`]);
  return (await syncGit(cwd, ["rev-parse", "FETCH_HEAD"])).toString().trim();
}

/** Read blobs without checkout: repo attributes, filters, symlinks and submodules never execute. */
export async function readSyncTree(cwd: string, commit: string): Promise<SyncFiles> {
  const entries = (await syncGit(cwd, ["ls-tree", "-r", "-l", "-z", commit])).toString().split("\0").filter(Boolean);
  const files: SyncFiles = new Map();
  const objects: string[] = [];
  const paths: string[] = [];
  let total = 0;
  for (const entry of entries) {
    const tab = entry.indexOf("\t");
    const path = entry.slice(tab + 1);
    if (!isSyncPath(path)) continue;
    const [mode, type, object, size] = entry.slice(0, tab).trim().split(/\s+/);
    if (type !== "blob" || !["100644", "100755"].includes(mode)) {
      throw new ConfigSyncError(`Symlinks and submodules cannot be imported: ${path}`, "invalid-path");
    }
    total += Number(size);
    if (Number(size) > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES || paths.length >= MAX_FILES) {
      throw new ConfigSyncError("Repository configuration exceeds the sync size limit", "size-limit");
    }
    files.set(path, { data: Buffer.alloc(0), mode: mode as SyncFile["mode"] });
    paths.push(path);
    objects.push(object);
  }
  validateSyncFiles(files);
  if (!objects.length) return files;
  const blobs = await syncGit(cwd, ["cat-file", "--batch"], `${objects.join("\n")}\n`);
  let offset = 0;
  for (const path of paths) {
    const end = blobs.indexOf(10, offset);
    const length = Number(blobs.subarray(offset, end).toString().split(" ")[2]);
    files.get(path)!.data = blobs.subarray(end + 1, end + 1 + length);
    offset = end + 2 + length;
  }
  return files;
}

export async function pushSyncTree(cwd: string, branch: string, head: string | null, remote: SyncFiles, local: SyncFiles): Promise<string> {
  await syncGit(cwd, head ? ["read-tree", head] : ["read-tree", "--empty"]);
  const index: string[] = [];
  for (const path of remote.keys()) {
    if (!local.has(path)) index.push(`0 ${"0".repeat(40)}\t${path}\0`);
  }
  for (const [path, file] of local) {
    const object = (await syncGit(cwd, ["hash-object", "-w", "--stdin", "--no-filters"], file.data)).toString().trim();
    index.push(`${file.mode} ${object}\t${path}\0`);
  }
  await syncGit(cwd, ["update-index", "-z", "--index-info"], index.join(""));
  const tree = (await syncGit(cwd, ["write-tree"])).toString().trim();
  if (head && tree === (await syncGit(cwd, ["rev-parse", `${head}^{tree}`])).toString().trim()) return head;
  const commit = (await syncGit(cwd, ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", "Sync Pi Web configuration"])).toString().trim();
  // A normal push refuses a concurrent update; never force-push configuration history.
  await syncGit(cwd, ["push", "origin", `${commit}:refs/heads/${branch}`]);
  return commit;
}
