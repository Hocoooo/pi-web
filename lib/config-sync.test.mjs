import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { getConfigSyncStatus, saveConfigSyncBinding, syncConfiguration } = await jiti.import("./config-sync.ts");
const { collectSyncFiles, decodeSyncConfig, digest } = await jiti.import("./config-sync-data.ts");
const { validateRepository, validateBranch, validateSyncFiles } = await jiti.import("./config-sync-git.ts");
const root = mkdtempSync(join(tmpdir(), "pi-web-config-sync-"));
const config = join(root, "gitconfig");
const previous = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
process.env.GIT_CONFIG_GLOBAL = config;
process.env.GIT_CONFIG_NOSYSTEM = "1";
writeFileSync(config, "");
function git(cwd, args, options = {}) {
  return execFileSync("git", ["-c", "user.name=Sync Test", "-c", "user.email=sync@example.invalid", "-C", cwd, ...args], { encoding: "utf8", ...options }).trim();
}
function write(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value));
}
function machine(name, installPackages = async () => {}) {
  const agentDir = join(root, name);
  mkdirSync(agentDir, { recursive: true });
  return { agentDir, userSkillsDir: join(root, `${name}-agent-skills`), installPackages };
}
let repositoryNumber = 0;
function repository() {
  const n = ++repositoryNumber;
  const bare = join(root, `remote-${n}.git`);
  mkdirSync(bare);
  git(bare, ["init", "--bare", "--initial-branch=main"]);
  const url = `https://sync.invalid/repo-${n}.git`;
  git(root, ["config", "--file", config, `url.${bare.replaceAll("\\", "/")}.insteadOf`, url]);
  return { url, bare };
}
async function bind(env, remote, branch = "main") {
  await saveConfigSyncBinding({ repository: remote.url, branch, trusted: true }, env.agentDir);
}
test.after(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

test("binding/status is local-only, requires trust and excludes embedded credentials and unsafe refs", async () => {
  const env = machine("binding");
  assert.deepEqual(getConfigSyncStatus(env.agentDir), { repository: "", branch: "main", lastSync: null });
  assert.equal(existsSync(join(env.agentDir, "config-sync.json")), false);
  for (const url of ["https://token@example.com/repo", "https://example.com/repo?token=x", "file:///tmp/repo", "ext::evil", "-upload-pack=x", "http://example.com/repo"]) {
    assert.throws(() => validateRepository(url));
  }
  for (const branch of ["../x", "-x", "foo.lock", "a//b", "a@{b", "a:b"]) assert.throws(() => validateBranch(branch));
  await assert.rejects(saveConfigSyncBinding({ repository: "https://example.invalid/repo.git", branch: "main" }, env.agentDir));
  await saveConfigSyncBinding({ repository: "git@example.invalid:team/config.git", branch: "team/main", trusted: true }, env.agentDir);
  assert.equal(getConfigSyncStatus(env.agentDir).branch, "team/main");
});

test("real Git push/pull round trip preserves local secrets, paths, resources, binary assets and managed deletion", async () => {
  const remote = repository();
  const a = machine("round-a");
  const installed = [];
  const b = machine("round-b", async (settings) => { installed.push(settings.packages); });
  write(join(a.agentDir, "settings.json"), { defaultProvider: "test", defaultModel: "m", shellPath: "C:/host-only/bash.exe", defaultTools: ["powershell"], packages: ["npm:example-plugin@1.2.3"] });
  write(join(a.agentDir, "models.json"), { providers: { test: { baseUrl: "https://example.invalid/v1", apiKey: "source-private-key", headers: { Authorization: "Bearer source-secret", "x-env": "${PROVIDER_HEADER}" }, models: [{ id: "m" }] } } });
  write(join(a.agentDir, "skills/demo/SKILL.md"), "---\nname: demo\ndescription: demo\n---\nUse it.\n");
  const binary = Buffer.from([0, 255, 128, 1, 0]);
  write(join(a.agentDir, "skills/demo/assets/data.bin"), binary);
  write(join(a.agentDir, "skills/demo/scripts/run.sh"), "#!/bin/sh\necho hello\n");
  if (process.platform !== "win32") chmodSync(join(a.agentDir, "skills/demo/scripts/run.sh"), 0o700);
  write(join(a.userSkillsDir, "shared/SKILL.md"), "---\nname: shared\ndescription: common root\n---\nShared.");
  write(join(a.agentDir, "agents/settings.json"), { builtInEnabled: true, disabledBuiltIns: ["plan"], maxConcurrent: 3 });
  write(join(a.agentDir, "AGENTS.md"), "Personal instructions\n");
  write(join(a.agentDir, "auth.json"), "do-not-transfer-auth");
  write(join(a.agentDir, "skills/demo/.env"), "do-not-transfer-env");
  await bind(a, remote);
  const pushed = await syncConfiguration("push", a);
  assert.equal(pushed.changed, true);
  const provider = JSON.parse(git(remote.bare, ["show", "main:models.json"])).providers.test;
  assert.equal(provider.apiKey, undefined);
  assert.deepEqual(provider.headers, { "x-env": "${PROVIDER_HEADER}" });
  assert.doesNotMatch(git(remote.bare, ["ls-tree", "-r", "--name-only", "main"]), /auth\.json|\.env/);
  assert.equal(JSON.parse(git(remote.bare, ["show", "main:settings.json"])).shellPath, undefined);
  const unchanged = await syncConfiguration("push", a);
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.lastSync.commit, pushed.lastSync.commit);

  write(join(b.agentDir, "settings.json"), { defaultModel: "old", shellPath: "/local/bash", skills: ["/local/skills"], packages: ["./local-plugin"], custom: 7 });
  write(join(b.agentDir, "models.json"), { providers: { test: { apiKey: "target-private-key", headers: { Authorization: "Bearer target-secret" }, models: [{ id: "old" }] } } });
  write(join(b.agentDir, "auth.json"), "target-auth-bytes");
  write(join(b.agentDir, "agents/settings.json"), { maxConcurrent: 11, custom: true });
  write(join(b.agentDir, "skills/local/SKILL.md"), "Local-only skill");
  await bind(b, remote);
  const pulled = await syncConfiguration("pull", b);
  assert.equal(pulled.reloadRequired, true);
  assert.equal(pulled.packages, 1);
  assert.equal(installed.length, 1);
  const settings = JSON.parse(readFileSync(join(b.agentDir, "settings.json"), "utf8"));
  assert.equal(settings.defaultModel, "m");
  assert.equal(settings.shellPath, "/local/bash");
  assert.deepEqual(settings.skills, ["/local/skills"]);
  assert.deepEqual(settings.packages, ["npm:example-plugin@1.2.3", "./local-plugin"]);
  assert.equal(settings.custom, 7);
  const localProvider = JSON.parse(readFileSync(join(b.agentDir, "models.json"), "utf8")).providers.test;
  assert.equal(localProvider.apiKey, "target-private-key");
  assert.equal(localProvider.headers.Authorization, "Bearer target-secret");
  assert.equal(readFileSync(join(b.agentDir, "auth.json"), "utf8"), "target-auth-bytes");
  assert.deepEqual(readFileSync(join(b.agentDir, "skills/demo/assets/data.bin")), binary);
  assert.equal(existsSync(join(b.userSkillsDir, "shared/SKILL.md")), true);
  assert.deepEqual(JSON.parse(readFileSync(join(b.agentDir, "agents/settings.json"), "utf8")), { builtInEnabled: true, disabledBuiltIns: ["plan"], maxConcurrent: 11, custom: true });

  rmSync(join(a.agentDir, "skills/demo"), { recursive: true });
  await syncConfiguration("push", a);
  await syncConfiguration("pull", b);
  assert.equal(existsSync(join(b.agentDir, "skills/demo/SKILL.md")), false);
  assert.equal(existsSync(join(b.agentDir, "skills/local/SKILL.md")), true);
});

test("local changes and remote advances refuse destructive pull/push; malformed imports do not mutate config", async () => {
  const remote = repository();
  const a = machine("conflict-a");
  const b = machine("conflict-b");
  write(join(a.agentDir, "settings.json"), { defaultModel: "one" });
  await bind(a, remote); await syncConfiguration("push", a);
  await bind(b, remote); await syncConfiguration("pull", b);
  write(join(b.agentDir, "settings.json"), { defaultModel: "local-edit" });
  await assert.rejects(syncConfiguration("pull", b), { code: "local-conflict" });
  write(join(a.agentDir, "settings.json"), { defaultModel: "remote-edit" });
  await syncConfiguration("push", a);
  const head = git(remote.bare, ["rev-parse", "main"]);
  await assert.rejects(syncConfiguration("push", b), { code: "remote-conflict" });
  assert.equal(git(remote.bare, ["rev-parse", "main"]), head);
  const foreign = machine("never-pulled");
  await bind(foreign, remote);
  await assert.rejects(syncConfiguration("push", foreign), { code: "remote-conflict" });

  const bad = new Map([["settings.json", { data: Buffer.from('{"shellPath":"/evil"}'), mode: "100644" }], ["models.json", { data: Buffer.from("{}"), mode: "100644" }]]);
  assert.throws(() => decodeSyncConfig(bad), /not portable/);
  bad.set("settings.json", { data: Buffer.from("{}"), mode: "100644" });
  bad.set("models.json", { data: Buffer.from('{"providers":{"p":{"apiKey":"secret","models":[]}}}'), mode: "100644" });
  assert.throws(() => decodeSyncConfig(bad), /environment-variable/);
  for (const name of ["skills/../auth.json", "skills/.env", "skills/a:stream", "skills/CON.md"]) {
    assert.throws(() => validateSyncFiles(new Map([[name, { data: Buffer.from("x"), mode: "100644" }]])));
  }
});

test("failed installation leaves configuration and sync receipt untouched and concurrent operations are refused", async () => {
  const remote = repository();
  const a = machine("install-a");
  write(join(a.agentDir, "settings.json"), { defaultModel: "new", packages: ["npm:example-plugin@1.2.3"] });
  await bind(a, remote); await syncConfiguration("push", a);
  let unlock;
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  const b = machine("install-b", async () => { started(); await new Promise((resolve) => { unlock = resolve; }); throw new Error("private token from installer"); });
  write(join(b.agentDir, "settings.json"), { defaultModel: "old" });
  await bind(b, remote);
  const before = readFileSync(join(b.agentDir, "settings.json"), "utf8");
  const receipt = readFileSync(join(b.agentDir, "config-sync.json"), "utf8");
  const operation = syncConfiguration("pull", b);
  const failed = assert.rejects(operation, (error) => error.code === "install-failed" && !error.message.includes("private token"));
  await running;
  await assert.rejects(syncConfiguration("push", b), { code: "busy" });
  await assert.rejects(saveConfigSyncBinding({ repository: remote.url, branch: "other", trusted: true }, b.agentDir), { code: "busy" });
  unlock(); await failed;
  assert.equal(readFileSync(join(b.agentDir, "settings.json"), "utf8"), before);
  assert.equal(readFileSync(join(b.agentDir, "config-sync.json"), "utf8"), receipt);
});

test("pull refuses to remove local provider/model secrets before installing or writing", async () => {
  const remote = repository();
  const a = machine("credential-removal-a");
  write(join(a.agentDir, "models.json"), { providers: { shared: { models: [{ id: "kept" }] } } });
  await bind(a, remote); await syncConfiguration("push", a);
  for (const [suffix, providers] of [
    ["provider", { omitted: { apiKey: "synthetic-provider-key", models: [{ id: "m" }] } }],
    ["model", { shared: { models: [{ id: "omitted", apiKey: "synthetic-model-key" }] } }],
  ]) {
    let installs = 0;
    const b = machine(`credential-removal-${suffix}`, async () => { installs++; });
    write(join(b.agentDir, "models.json"), { providers });
    write(join(b.agentDir, "settings.json"), { defaultModel: "local" });
    await bind(b, remote);
    const before = ["models.json", "settings.json", "config-sync.json"].map(name => readFileSync(join(b.agentDir, name), "utf8"));
    await assert.rejects(syncConfiguration("pull", b), { code: "local-conflict" });
    assert.equal(installs, 0);
    assert.deepEqual(["models.json", "settings.json", "config-sync.json"].map(name => readFileSync(join(b.agentDir, name), "utf8")), before);
  }
});

test("offline SDK resolution cannot report a missing plugin as a successful pull", async () => {
  const remote = repository();
  const a = machine("offline-a");
  write(join(a.agentDir, "settings.json"), { packages: ["npm:absent-sync-fixture@1.2.3"] });
  await bind(a, remote); await syncConfiguration("push", a);
  const b = machine("offline-b");
  delete b.installPackages;
  write(join(b.agentDir, "settings.json"), { defaultModel: "keep-local" });
  await bind(b, remote);
  const before = readFileSync(join(b.agentDir, "settings.json"), "utf8");
  const receipt = readFileSync(join(b.agentDir, "config-sync.json"), "utf8");
  const offline = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "1";
  try { await assert.rejects(syncConfiguration("pull", b), { code: "install-failed" }); }
  finally { if (offline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = offline; }
  assert.equal(readFileSync(join(b.agentDir, "settings.json"), "utf8"), before);
  assert.equal(readFileSync(join(b.agentDir, "config-sync.json"), "utf8"), receipt);
  assert.equal(existsSync(join(b.agentDir, "npm/node_modules/absent-sync-fixture")), false);
});

test("a pushed commit with a failed local receipt is reported as applied, never retried with force", async () => {
  const remote = repository();
  const env = machine("receipt-failure");
  write(join(env.agentDir, "settings.json"), { defaultModel: "published" });
  await bind(env, remote);
  const receiptPath = join(env.agentDir, "config-sync.json");
  const original = readFileSync(receiptPath, "utf8");
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === receiptPath) throw Object.assign(new Error("controlled receipt failure"), { code: "EACCES" });
    return rename(from, to);
  };
  syncBuiltinESMExports();
  try {
    const isolated = createJiti(import.meta.url, { moduleCache: false, fsCache: false });
    const { syncConfiguration: syncWithFailure } = await isolated.import("./config-sync.ts");
    await assert.rejects(syncWithFailure("push", env), (error) => error.code === "receipt-failed" && error.applied === true);
  } finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  assert.equal(readFileSync(receiptPath, "utf8"), original);
  assert.equal(JSON.parse(git(remote.bare, ["show", "main:settings.json"])).defaultModel, "published");
  await assert.rejects(syncConfiguration("push", env), { code: "remote-conflict" });
});

test("source skill directory links export as regular files", async () => {
  const env = machine("links");
  const resource = join(root, "linked-skill");
  write(join(resource, "SKILL.md"), "Linked skill");
  mkdirSync(join(env.agentDir, "skills"));
  symlinkSync(resource, join(env.agentDir, "skills/linked"), process.platform === "win32" ? "junction" : "dir");
  const files = await collectSyncFiles(env);
  assert.equal(files.get("skills/linked/SKILL.md").data.toString(), "Linked skill");
  assert.equal(digest(files).length, 64);
});
