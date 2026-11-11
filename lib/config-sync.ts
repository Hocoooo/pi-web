import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { applySyncFiles, checkSyncTargets, collectSyncFiles, decodeSyncConfig, digest, installSyncPackages, isRecord, json, parseObject, readObject, sharedSettings, type SyncPaths } from "./config-sync-data";
import { ConfigSyncError, fetchSyncHead, pushSyncTree, readSyncTree, validateBranch, validateRepository, validateSyncFiles } from "./config-sync-git";
import { invalidateModelsCache } from "./models-cache";
import type { ConfigSyncResult, ConfigSyncStatus } from "./config-sync-types";

export { ConfigSyncError };

interface SyncState extends ConfigSyncStatus {
  baseline: string | null;
  managed: string[];
  modes: Record<string, string>;
}
interface SyncEnvironment extends SyncPaths {
  installPackages?: typeof installSyncPackages;
}
function environment(): SyncEnvironment {
  return { agentDir: getAgentDir(), userSkillsDir: join(homedir(), ".agents", "skills") };
}
function statePath(agentDir: string): string { return join(agentDir, "config-sync.json"); }
function initialState(): SyncState {
  return { repository: "", branch: "main", lastSync: null, baseline: null, managed: [], modes: {} };
}
function readState(agentDir: string): SyncState {
  const path = statePath(agentDir);
  if (!existsSync(path)) return initialState();
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new ConfigSyncError("Sync binding must be a regular file");
  const value = parseObject(readFileSync(path, "utf8"), "config-sync.json");
  if (!value.repository) return initialState();
  validateRepository(value.repository);
  validateBranch(value.branch);
  if (!Array.isArray(value.managed) || value.managed.some((v) => typeof v !== "string")
    || !isRecord(value.modes) || (value.baseline !== null && typeof value.baseline !== "string")
    || (value.lastSync !== null && (!isRecord(value.lastSync) || !["push", "pull"].includes(value.lastSync.action as string)
      || typeof value.lastSync.commit !== "string" || !/^[a-f0-9]{40}$/.test(value.lastSync.commit) || typeof value.lastSync.at !== "string"))) {
    throw new ConfigSyncError("Invalid local sync binding");
  }
  validateSyncFiles(new Map((value.managed as string[]).map((name) => [name, { data: Buffer.alloc(0), mode: "100644" }])));
  return value as unknown as SyncState;
}
function status(state: SyncState): ConfigSyncStatus {
  return { repository: state.repository, branch: state.branch, lastSync: state.lastSync };
}
export function getConfigSyncStatus(agentDir = getAgentDir()): ConfigSyncStatus {
  return status(readState(agentDir));
}
async function withSyncLock<T>(agentDir: string, work: () => Promise<T>): Promise<T> {
  mkdirSync(agentDir, { recursive: true });
  const path = statePath(agentDir);
  try { writeFileSync(path, json(initialState()), { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  readState(agentDir);
  let release: () => Promise<void>;
  try { release = await lockfile.lock(path, { realpath: false, retries: 0 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOCKED") throw new ConfigSyncError("Configuration sync is already running", "busy", 409);
    throw error;
  }
  try { return await work(); } finally { await release(); }
}
export async function saveConfigSyncBinding(input: unknown, agentDir = getAgentDir()): Promise<ConfigSyncStatus> {
  if (!isRecord(input) || input.trusted !== true) throw new ConfigSyncError("Confirm that you trust this repository before binding it");
  const repository = validateRepository(input.repository);
  const branch = validateBranch(input.branch);
  return withSyncLock(agentDir, async () => {
    let state = readState(agentDir);
    if (state.repository !== repository || state.branch !== branch) state = { ...initialState(), repository, branch };
    writePrivateFileAtomicSync(statePath(agentDir), json(state));
    return status(state);
  });
}
export async function syncConfiguration(action: "push" | "pull", env: SyncEnvironment = environment()): Promise<ConfigSyncResult> {
  if (action !== "push" && action !== "pull") throw new ConfigSyncError("Choose push or pull");
  return withSyncLock(env.agentDir, async () => {
    const state = readState(env.agentDir);
    if (!state.repository) throw new ConfigSyncError("Save a trusted repository binding first", "not-configured", 409);
    const local = await collectSyncFiles(env, state.modes, false);
    if (action === "pull" && state.baseline !== null && state.baseline !== digest(local)) {
      throw new ConfigSyncError("Local shared configuration has unpublished changes. Push them first or reconcile them manually before pulling.", "local-conflict", 409);
    }
    const expectedSettings = json(sharedSettings(readObject(join(env.agentDir, "settings.json"))));
    const repo = mkdtempSync(join(env.agentDir, ".config-sync-"));
    let applied = false;
    try {
      const head = await fetchSyncHead(repo, state.repository, state.branch);
      const remote = head ? await readSyncTree(repo, head) : new Map();
      let commit: string;
      let changed: boolean;
      let files: number;
      let packages: number;
      if (action === "push") {
        if (head !== (state.lastSync?.commit ?? null) && (state.lastSync !== null || remote.size > 0)) {
          throw new ConfigSyncError("Remote configuration changed or has not been pulled on this machine. Pull first; no history was overwritten.", "remote-conflict", 409);
        }
        const exported = await collectSyncFiles(env, state.modes);
        const decoded = decodeSyncConfig(exported);
        if (digest(local) !== digest(await collectSyncFiles(env, state.modes, false))) {
          throw new ConfigSyncError("Local configuration changed during export; retry", "local-conflict", 409);
        }
        commit = await pushSyncTree(repo, state.branch, head, remote, exported);
        applied = commit !== head;
        state.managed = [...exported.keys()];
        state.modes = Object.fromEntries([...exported].map(([name, file]) => [name, file.mode]));
        state.baseline = digest(local);
        changed = commit !== head;
        files = exported.size;
        packages = (decoded.settings.packages as unknown[] | undefined)?.length ?? 0;
      } else {
        if (!head) throw new ConfigSyncError("The selected remote branch has no configuration yet. Push from the configured machine first.", "empty-remote", 409);
        const decoded = decodeSyncConfig(remote);
        checkSyncTargets(env, remote, state.managed);
        try { await (env.installPackages ?? installSyncPackages)(decoded.settings, env); }
        catch { throw new ConfigSyncError("Plugin installation failed; local configuration was not applied. Already installed package files may remain. Retry after fixing package access.", "install-failed", 502); }
        if (digest(local) !== digest(await collectSyncFiles(env, state.modes, false))) {
          throw new ConfigSyncError("Local configuration changed during pull; nothing was applied. Retry after reviewing local changes.", "local-conflict", 409);
        }
        await applySyncFiles(env, remote, state.managed, expectedSettings);
        applied = true;
        invalidateModelsCache();
        state.modes = Object.fromEntries([...remote].map(([name, file]) => [name, file.mode]));
        const after = await collectSyncFiles(env, state.modes, false);
        state.baseline = digest(after);
        state.managed = [...remote.keys()];
        commit = head;
        changed = digest(local) !== digest(after);
        files = remote.size;
        packages = (decoded.settings.packages as unknown[] | undefined)?.length ?? 0;
      }
      state.lastSync = { action, commit, at: new Date().toISOString() };
      writePrivateFileAtomicSync(statePath(env.agentDir), json(state));
      return { ...status(state), changed, files, packages, reloadRequired: action === "pull" };
    } catch (error) {
      if (applied) throw new ConfigSyncError("Configuration transfer finished, but its local sync receipt could not be saved. Inspect local and remote state before retrying.", "receipt-failed", 500, true);
      throw error;
    } finally { await rm(repo, { recursive: true, force: true }); }
  });
}
