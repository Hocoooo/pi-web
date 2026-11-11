import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { DefaultPackageManager, SettingsManager, type PackageSource } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { updateGlobalSettings } from "./global-settings-file";
import { isReferenceOnly, isSecretName, urlSecretParts } from "./mcp-secrets";
import { normalizeModelsConfigCosts, readModelsConfig } from "./models-config-store";
import { ConfigSyncError, RESOURCE_DIRS, ROOT_FILES, syncGit, validateRepository, validateSyncFiles, type SyncFiles } from "./config-sync-git";

// The single allowlist for both export and import. Paths, shell commands, trust and host tool selection stay local.
const SHARED_SETTINGS = {
  defaultProvider: "string", defaultModel: "string", defaultThinkingLevel: "string",
  modelThinkingLevels: "object", enabledModels: "strings", thinkingBudgets: "object",
  compaction: "object", branchSummary: "object", retry: "object", images: "object",
  enableSkillCommands: "boolean", codemode: "object", taskArchiveReport: "object", packages: "packages",
} as const;
const SKIP = /^(?:\.git|node_modules|__pycache__|\.DS_Store|\.env(?:\..*)?|auth\.json|mcp-auth\.json)$/i;

export interface SyncPaths { agentDir: string; userSkillsDir: string }
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function json(value: unknown): string {
  return JSON.stringify(value, (_key, item) => isRecord(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item, 2) + "\n";
}
export function parseObject(data: string, label: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(data, (key, item) => {
      if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error();
      return item;
    });
    if (isRecord(value)) return value;
  } catch { /* Report the filename, never source bytes or JSON parser excerpts. */ }
  throw new ConfigSyncError(`Invalid JSON object in ${label}`);
}
export function readObject(path: string): Record<string, unknown> {
  return existsSync(path) ? parseObject(readFileSync(path, "utf8"), "local configuration") : {};
}
export function sharedSettings(value: Record<string, unknown>, importing = false): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const kind = SHARED_SETTINGS[key as keyof typeof SHARED_SETTINGS];
    if (!kind) {
      if (importing) throw new ConfigSyncError(`Setting ${key} is not portable and cannot be imported`);
      continue;
    }
    const valid = kind === "object" ? isRecord(item) : kind === "strings" ? Array.isArray(item) && item.every((v) => typeof v === "string")
      : kind === "packages" ? Array.isArray(item) : typeof item === kind;
    if (!valid) throw new ConfigSyncError(`Invalid shared setting: ${key}`);
    result[key] = item;
  }
  return result;
}
export function packageSource(value: unknown): string {
  const source = typeof value === "string" ? value : isRecord(value) ? value.source : undefined;
  if (typeof source !== "string") throw new ConfigSyncError("Invalid package declaration");
  return source;
}
export function isRemotePackage(source: string): boolean {
  return /^(?:npm:|git:|https:\/\/|ssh:\/\/)/.test(source);
}
function validatePackage(entry: unknown): void {
  const source = packageSource(entry);
  if (source.startsWith("npm:")) {
    if (!/^npm:(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+@\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/.test(source)) {
      throw new ConfigSyncError("Shared npm plugins must use an exact version");
    }
  } else {
    const match = /^git:(.+)@([a-f0-9]{40})$/.exec(source);
    if (!match) throw new ConfigSyncError("Shared Git plugins must use a full commit hash");
    validateRepository(match[1]);
  }
  if (isRecord(entry)) {
    for (const [key, value] of Object.entries(entry)) {
      if (key === "source") continue;
      if (key === "autoload" ? typeof value !== "boolean" : !["extensions", "skills", "prompts", "themes"].includes(key)
        || !Array.isArray(value) || value.some((v) => typeof v !== "string" || isAbsolute(v.replace(/^[!+-]/, "")) || /^[!+-]?[A-Za-z]:/.test(v))) {
        throw new ConfigSyncError("Package filters must be relative portable resource patterns");
      }
    }
  }
}
async function pinPackages(entries: unknown[], paths: SyncPaths): Promise<unknown[]> {
  const manager = new DefaultPackageManager({ cwd: paths.agentDir, agentDir: paths.agentDir, settingsManager: SettingsManager.inMemory() });
  const result: unknown[] = [];
  for (const entry of entries) {
    const source = packageSource(entry);
    if (!isRemotePackage(source)) continue;
    let pinned = source;
    try { validatePackage(entry); } catch {
      const installed = manager.getInstalledPath(source, "user");
      if (!installed) throw new ConfigSyncError("Install configured plugins locally before pushing, or pin their exact versions");
      if (source.startsWith("npm:")) {
        const manifest = readObject(join(installed, "package.json"));
        pinned = `npm:${manifest.name}@${manifest.version}`;
      } else {
        const repo = (await syncGit(installed, ["remote", "get-url", "origin"])).toString().trim();
        const commit = (await syncGit(installed, ["rev-parse", "HEAD"])).toString().trim();
        pinned = `git:${validateRepository(repo)}@${commit}`;
      }
    }
    const next = typeof entry === "string" ? pinned : { ...entry as object, source: pinned };
    validatePackage(next);
    result.push(next);
  }
  return result;
}
function reference(value: unknown): boolean {
  return typeof value === "string" && !value.trimStart().startsWith("!") && isReferenceOnly(value)
    && !value.toUpperCase().includes("PI_WEB_PASSWORD");
}
function portableModels(value: Record<string, unknown>, importing = false): Record<string, unknown> {
  if (value.providers !== undefined && !isRecord(value.providers)) throw new ConfigSyncError("models.json providers must be an object");
  const clean = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(clean);
    if (!isRecord(node)) return node;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(node)) {
      if (key === "apiKey" || (isSecretName(key) && typeof item === "string")) {
        if (reference(item)) result[key] = item;
        else if (importing) throw new ConfigSyncError("Shared API keys must be environment-variable references; literal keys and commands stay local");
      } else if (key === "headers") {
        if (!isRecord(item)) throw new ConfigSyncError("Model headers must be an object");
        const headers = Object.fromEntries(Object.entries(item).filter(([, v]) => reference(v)));
        if (importing && Object.keys(headers).length !== Object.keys(item).length) {
          throw new ConfigSyncError("Shared headers must be environment-variable references");
        }
        if (Object.keys(headers).length) result[key] = headers;
      } else {
        if (key === "baseUrl" && typeof item === "string") {
          try {
            const url = new URL(item);
            if (!["https:", "http:"].includes(url.protocol) || url.hash || urlSecretParts(item).length) {
              throw new ConfigSyncError("Use an HTTP(S) model endpoint without embedded credentials or fragments");
            }
          } catch { throw new ConfigSyncError("Use an HTTP(S) model endpoint without embedded credentials or fragments"); }
        }
        result[key] = clean(item);
      }
    }
    return result;
  };
  for (const provider of Object.values(value.providers ?? {})) {
    if (!isRecord(provider) || (provider.models !== undefined && (!Array.isArray(provider.models)
      || provider.models.some((model) => !isRecord(model) || typeof model.id !== "string" || !model.id.trim())))) {
      throw new ConfigSyncError("Invalid model provider definition");
    }
  }
  return normalizeModelsConfigCosts(clean(value) as Record<string, unknown>);
}
function privateCredential(key: string, value: unknown): boolean {
  return typeof value === "string" && (key === "apiKey" || isSecretName(key)) && !reference(value);
}
function hasPrivateCredentials(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasPrivateCredentials);
  return isRecord(value) && Object.entries(value).some(([key, item]) => privateCredential(key, item)
    || (key === "headers" && isRecord(item) && Object.values(item).some((v) => !reference(v))) || hasPrivateCredentials(item));
}
function checkCredentialRetention(incoming: unknown, current: unknown): void {
  if (!hasPrivateCredentials(current)) return;
  if (Array.isArray(current) && Array.isArray(incoming)) {
    for (const item of current) checkCredentialRetention(isRecord(item)
      ? incoming.find((next) => isRecord(next) && next.id === item.id) : undefined, item);
    return;
  }
  if (!isRecord(incoming) || !isRecord(current)) {
    throw new ConfigSyncError("Pull would remove an entry containing local credentials. Reconcile those provider/model credentials before pulling; nothing was applied.", "local-conflict", 409);
  }
  for (const [key, item] of Object.entries(current)) {
    if (key !== "headers" && !privateCredential(key, item)) checkCredentialRetention(incoming[key], item);
  }
}
function mergeCredentials(incoming: unknown, current: unknown): unknown {
  if (Array.isArray(incoming)) return incoming.map((item) => mergeCredentials(item,
    Array.isArray(current) && isRecord(item) ? current.find((old) => isRecord(old) && old.id === item.id) : undefined));
  if (!isRecord(incoming)) return incoming;
  const result: Record<string, unknown> = {};
  if (isRecord(current)) {
    for (const [key, item] of Object.entries(current)) {
      if (privateCredential(key, item)) result[key] = item;
      if (key === "headers" && isRecord(item)) result.headers = Object.fromEntries(Object.entries(item).filter(([, v]) => !reference(v)));
    }
  }
  for (const [key, item] of Object.entries(incoming)) {
    if (isRecord(current) && privateCredential(key, current[key])) continue;
    result[key] = key === "headers" && isRecord(item)
      ? { ...item, ...(isRecord(result.headers) ? result.headers : {}) } : mergeCredentials(item, isRecord(current) ? current[key] : undefined);
  }
  return result;
}
export function targetPath(paths: SyncPaths, path: string): string {
  return path.startsWith("agent-skills/") ? join(paths.userSkillsDir, path.slice("agent-skills/".length)) : join(paths.agentDir, path);
}
export async function collectSyncFiles(paths: SyncPaths, modes: Record<string, string> = {}, pin = true): Promise<SyncFiles> {
  const files: SyncFiles = new Map();
  const add = (name: string, data: Buffer, executable = false) => {
    files.set(name, { data, mode: executable || (process.platform === "win32" && modes[name] === "100755") ? "100755" : "100644" });
    validateSyncFiles(files);
  };
  const settings = sharedSettings(readObject(join(paths.agentDir, "settings.json")));
  if (Array.isArray(settings.packages)) settings.packages = pin
    ? await pinPackages(settings.packages, paths) : settings.packages.filter((p) => isRemotePackage(packageSource(p)));
  add("settings.json", Buffer.from(json(settings)));
  add("models.json", Buffer.from(json(portableModels(readModelsConfig(join(paths.agentDir, "models.json"))))));
  const walk = (disk: string, name: string, boundary: string, ancestors: Set<string>) => {
    if (SKIP.test(name.split("/").at(-1)!)) return;
    const real = realpathSync(disk);
    const rel = relative(boundary, real);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || ancestors.has(real)) {
      throw new ConfigSyncError(`Resource link leaves its resource root or contains a cycle: ${name}`, "invalid-path");
    }
    const stat = lstatSync(real);
    if (lstatSync(disk).isSymbolicLink() && !stat.isDirectory()) {
      throw new ConfigSyncError(`File links cannot be exported: ${name}`, "invalid-path");
    }
    if (stat.isDirectory()) {
      for (const child of readdirSync(real).sort()) walk(join(real, child), `${name}/${child}`, boundary, new Set([...ancestors, real]));
    } else if (stat.isFile()) {
      if (stat.size > 10 * 1024 * 1024) throw new ConfigSyncError(`Resource exceeds 10 MiB: ${name}`, "size-limit");
      add(name, readFileSync(real), Boolean(stat.mode & 0o111));
    } else throw new ConfigSyncError(`Not a regular resource file: ${name}`, "invalid-path");
  };
  for (const name of ROOT_FILES.filter((name) => !["settings.json", "models.json"].includes(name))) {
    const disk = join(paths.agentDir, name);
    if (existsSync(disk)) walk(disk, name, realpathSync(disk), new Set());
  }
  for (const dir of RESOURCE_DIRS) {
    const root = dir === "agent-skills" ? paths.userSkillsDir : join(paths.agentDir, dir);
    if (!existsSync(root)) continue;
    for (const child of readdirSync(root).sort()) {
      if (dir === "agents" && child === "settings.json") continue;
      const disk = join(root, child);
      walk(disk, `${dir}/${child}`, realpathSync(disk), new Set());
    }
  }
  const agents = readObject(join(paths.agentDir, "agents", "settings.json"));
  const sharedAgents = Object.fromEntries(["builtInEnabled", "disabledBuiltIns"].filter((key) => key in agents).map((key) => [key, agents[key]]));
  if (Object.keys(sharedAgents).length) add("agents/settings.json", Buffer.from(json(sharedAgents)));
  return files;
}
export function digest(files: SyncFiles): string {
  const hash = createHash("sha256");
  for (const [name, file] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(name).update("\0").update(file.mode).update("\0").update(String(file.data.length)).update("\0").update(file.data);
  }
  return hash.digest("hex");
}
export function decodeSyncConfig(files: SyncFiles): { settings: Record<string, unknown>; models: Record<string, unknown> } {
  validateSyncFiles(files);
  if (!files.has("settings.json") || !files.has("models.json")) throw new ConfigSyncError("Repository must contain settings.json and models.json at its root");
  const settings = sharedSettings(parseObject(files.get("settings.json")!.data.toString(), "settings.json"), true);
  if (Array.isArray(settings.packages)) settings.packages.forEach(validatePackage);
  const models = portableModels(parseObject(files.get("models.json")!.data.toString(), "models.json"), true);
  const agents = files.get("agents/settings.json");
  if (agents) {
    const value = parseObject(agents.data.toString(), "agents/settings.json");
    if (Object.entries(value).some(([k, v]) => k === "builtInEnabled" ? typeof v !== "boolean"
      : k !== "disabledBuiltIns" || !Array.isArray(v) || v.some((name) => typeof name !== "string"))) {
      throw new ConfigSyncError("Only builtInEnabled and disabledBuiltIns may be shared in agents/settings.json");
    }
  }
  return { settings, models };
}
function assertDestination(paths: SyncPaths, path: string): void {
  const target = targetPath(paths, path);
  const root = path.startsWith("agent-skills/") ? paths.userSkillsDir : paths.agentDir;
  for (let current = target; ; current = dirname(current)) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || (current !== target && !stat.isDirectory()) || (current === target && !stat.isFile())) {
        throw new ConfigSyncError(`Sync destination is not a regular file path: ${path}`, "invalid-path");
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (current === root || dirname(current) === current) break;
  }
}
export function checkSyncTargets(paths: SyncPaths, files: SyncFiles, managed: string[]) {
  if (files.has("models.json")) checkCredentialRetention(parseObject(files.get("models.json")!.data.toString(), "models.json"), readModelsConfig(join(paths.agentDir, "models.json")));
  const before = new Map<string, { data: Buffer; mode: number } | null>();
  const folded = new Map<string, string>();
  for (const name of new Set([...files.keys(), ...managed])) {
    const alias = folded.get(name.toLowerCase());
    if (alias && alias !== name) throw new ConfigSyncError("Case-only resource renames must be reconciled manually before pulling", "local-conflict", 409);
    folded.set(name.toLowerCase(), name);
    assertDestination(paths, name);
    if (name === "settings.json") continue;
    const target = targetPath(paths, name);
    const old = existsSync(target) ? { data: readFileSync(target), mode: lstatSync(target).mode & 0o777 } : null;
    if (old && !managed.includes(name) && !["models.json", "agents/settings.json"].includes(name)
      && (!files.has(name) || !old.data.equals(files.get(name)!.data))) {
      throw new ConfigSyncError(`Local resource already exists outside this binding: ${name}. Move it or publish it before pulling.`, "local-conflict", 409);
    }
    before.set(name, old);
  }
  return before;
}
/** Per-file atomic writes plus in-process restoration; never follows destination links. */
export async function applySyncFiles(paths: SyncPaths, files: SyncFiles, managed: string[], expectedSettings: string): Promise<void> {
  const { settings, models } = decodeSyncConfig(files);
  const modelsPath = join(paths.agentDir, "models.json");
  const expectedModels = json(portableModels(readModelsConfig(modelsPath)));
  const before = checkSyncTargets(paths, files, managed);
  const writes = new Map([...files].map(([path, file]) => [path, file.data]));
  let writing = false;
  try {
    await updateGlobalSettings(join(paths.agentDir, "settings.json"), (current) => {
      if (json(sharedSettings(current)) !== expectedSettings) throw new ConfigSyncError("Shared settings changed during sync; retry", "local-conflict", 409);
      const currentModels = readModelsConfig(modelsPath);
      checkCredentialRetention(models, currentModels);
      if (json(portableModels(currentModels)) !== expectedModels) throw new ConfigSyncError("Model definitions changed during sync; retry", "local-conflict", 409);
      for (const [name, old] of before) {
        if (["models.json", "agents/settings.json"].includes(name)) continue;
        assertDestination(paths, name);
        const target = targetPath(paths, name);
        if (old ? !existsSync(target) || !readFileSync(target).equals(old.data) : existsSync(target)) {
          throw new ConfigSyncError(`Resource changed during sync: ${name}`, "local-conflict", 409);
        }
      }
      writes.set("models.json", Buffer.from(json(mergeCredentials(models, currentModels))));
      if (before.has("agents/settings.json")) {
        const value = readObject(join(paths.agentDir, "agents", "settings.json"));
        delete value.builtInEnabled;
        delete value.disabledBuiltIns;
        Object.assign(value, files.has("agents/settings.json") ? parseObject(files.get("agents/settings.json")!.data.toString(), "agents/settings.json") : {});
        writes.set("agents/settings.json", Buffer.from(json(value)));
      }
      const localPackages = Array.isArray(current.packages) ? current.packages.filter((entry) => !isRemotePackage(packageSource(entry))) : [];
      for (const key of Object.keys(SHARED_SETTINGS)) delete current[key];
      Object.assign(current, settings);
      if (localPackages.length) current.packages = [...(settings.packages as unknown[] ?? []), ...localPackages];
      writing = true;
      for (const name of before.keys()) {
        const target = targetPath(paths, name);
        if (!writes.has(name)) { if (existsSync(target)) unlinkSync(target); continue; }
        mkdirSync(dirname(target), { recursive: true });
        writePrivateFileAtomicSync(target, writes.get(name)!);
        if (process.platform !== "win32") chmodSync(target, files.get(name)?.mode === "100755" ? 0o700 : 0o600);
      }
    });
  } catch (error) {
    if (writing) {
      try {
        for (const [name, old] of before) {
          const target = targetPath(paths, name);
          if (old) { writePrivateFileAtomicSync(target, old.data); chmodSync(target, old.mode); }
          else if (existsSync(target)) unlinkSync(target);
        }
      } catch { throw new ConfigSyncError("Configuration apply failed and restoration was incomplete. Inspect local resources before retrying.", "apply-failed", 500, true); }
    }
    throw error;
  }
}

export async function installSyncPackages(settings: Record<string, unknown>, paths: SyncPaths): Promise<void> {
  const packages = settings.packages as PackageSource[] | undefined;
  if (!packages?.length) return;
  const manager = new DefaultPackageManager({ cwd: paths.agentDir, agentDir: paths.agentDir,
    settingsManager: SettingsManager.inMemory({ packages }, { projectTrusted: false }) });
  await manager.resolve(async () => "install");
  for (const entry of packages) {
    const source = packageSource(entry);
    const installed = manager.getInstalledPath(source, "user");
    const expected = source.slice(source.lastIndexOf("@") + 1);
    const actual = !installed ? null : source.startsWith("npm:") ? readObject(join(installed, "package.json")).version
      : (await syncGit(installed, ["rev-parse", "HEAD"])).toString().trim();
    if (actual !== expected) throw new ConfigSyncError("A pinned plugin is missing or at the wrong revision. Check offline mode and package access.", "install-failed", 502);
  }
}
