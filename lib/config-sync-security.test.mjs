import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { applySyncFiles, checkSyncTargets, collectSyncFiles, decodeSyncConfig, json } = await jiti.import("./config-sync-data.ts");
const { readSyncTree, syncGit, validateSyncFiles } = await jiti.import("./config-sync-git.ts");
function setup(t) {
  const root = fs.mkdtempSync(join(tmpdir(), "pi-web-config-sync-security-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = { agentDir: join(root, "agent"), userSkillsDir: join(root, "agent-skills") };
  fs.mkdirSync(paths.agentDir);
  return { root, paths };
}
function files(settings = {}, models = {}) {
  return new Map([["settings.json", { data: Buffer.from(json(settings)), mode: "100644" }], ["models.json", { data: Buffer.from(json(models)), mode: "100644" }]]);
}

test("atomic apply restores resource/model bytes if the final settings replacement fails", async (t) => {
  const { paths } = setup(t);
  fs.writeFileSync(join(paths.agentDir, "settings.json"), JSON.stringify({ defaultModel: "old", shellPath: "local" }));
  fs.writeFileSync(join(paths.agentDir, "models.json"), '{"providers":{"p":{"apiKey":"local-key","models":[]}}}');
  fs.writeFileSync(join(paths.agentDir, "AGENTS.md"), "old instructions");
  const before = Object.fromEntries(["settings.json", "models.json", "AGENTS.md"].map(name => [name, fs.readFileSync(join(paths.agentDir, name))]));
  const incoming = files({ defaultModel: "new" }, { providers: { p: { models: [{ id: "new" }] } } });
  incoming.set("AGENTS.md", { data: Buffer.from("new instructions"), mode: "100644" });
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === join(paths.agentDir, "settings.json")) throw Object.assign(new Error("controlled final-write failure"), { code: "EACCES" });
    return rename(from, to);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(applySyncFiles(paths, incoming, ["models.json", "settings.json", "AGENTS.md"], json({ defaultModel: "old" })), /controlled/);
  } finally { fs.renameSync = rename; syncBuiltinESMExports(); }
  for (const [name, bytes] of Object.entries(before)) assert.deepEqual(fs.readFileSync(join(paths.agentDir, name)), bytes, name);
});

test("unmanaged collisions and destination junctions are refused before any write", async (t) => {
  const { root, paths } = setup(t);
  const incoming = files();
  incoming.set("skills/shared/SKILL.md", { data: Buffer.from("remote"), mode: "100644" });
  fs.mkdirSync(join(paths.agentDir, "skills/shared"), { recursive: true });
  fs.writeFileSync(join(paths.agentDir, "skills/shared/SKILL.md"), "local");
  assert.throws(() => checkSyncTargets(paths, incoming, []), { code: "local-conflict" });
  fs.rmSync(join(paths.agentDir, "skills/shared"), { recursive: true });
  const outside = join(root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(join(outside, "SKILL.md"), "outside-data");
  fs.symlinkSync(outside, join(paths.agentDir, "skills/shared"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => checkSyncTargets(paths, incoming, ["skills/shared/SKILL.md"]), { code: "invalid-path" });
  assert.equal(fs.readFileSync(join(outside, "SKILL.md"), "utf8"), "outside-data");
});

test("shared environment references never overwrite matching machine-private credential values", async (t) => {
  const { paths } = setup(t);
  fs.writeFileSync(join(paths.agentDir, "models.json"), JSON.stringify({ providers: { p: { apiKey: "machine-key", headers: { Authorization: "machine-header" }, models: [{ id: "m", apiKey: "machine-model-key" }] } } }));
  const incoming = files({}, { providers: { p: { apiKey: "${REMOTE_KEY}", headers: { Authorization: "Bearer ${REMOTE_HEADER}" }, models: [{ id: "m", apiKey: "${REMOTE_MODEL_KEY}" }] } } });
  await applySyncFiles(paths, incoming, [], json({}));
  const p = JSON.parse(fs.readFileSync(join(paths.agentDir, "models.json"), "utf8")).providers.p;
  assert.equal(p.apiKey, "machine-key");
  assert.equal(p.headers.Authorization, "machine-header");
  assert.equal(p.models[0].apiKey, "machine-model-key");
});

test("case-only managed renames are rejected before apply, including identical bytes", (t) => {
  const { paths } = setup(t);
  const incoming = files();
  incoming.set("skills/demo/readme.md", { data: Buffer.from("same"), mode: "100644" });
  fs.mkdirSync(join(paths.agentDir, "skills/demo"), { recursive: true });
  fs.writeFileSync(join(paths.agentDir, "skills/demo/Readme.md"), "same");
  assert.throws(() => checkSyncTargets(paths, incoming, ["skills/demo/Readme.md"]), { code: "local-conflict" });
  assert.equal(fs.readFileSync(join(paths.agentDir, "skills/demo/Readme.md"), "utf8"), "same");
});

test("innocuously named file links cannot export auth bytes", async (t) => {
  const { paths } = setup(t);
  fs.writeFileSync(join(paths.agentDir, "auth.json"), "synthetic-private-auth");
  fs.mkdirSync(join(paths.agentDir, "skills"));
  try { fs.symlinkSync(join(paths.agentDir, "auth.json"), join(paths.agentDir, "skills/harmless.md"), "file"); }
  catch (error) { if (error.code === "EPERM" || error.code === "EACCES") { t.skip("File symlinks are unavailable; directory junction checks still run separately"); return; } throw error; }
  await assert.rejects(collectSyncFiles(paths), { code: "invalid-path" });
});

test("Git blobs with link modes are rejected without checkout", async (t) => {
  const { root } = setup(t);
  const repo = join(root, "repo"); fs.mkdirSync(repo);
  await syncGit(repo, ["init", "--template=", "--initial-branch=main"]);
  const object = (await syncGit(repo, ["hash-object", "-w", "--stdin"], "/outside/secret")).toString().trim();
  await syncGit(repo, ["update-index", "--add", "--cacheinfo", `120000,${object},skills/linked`]);
  const tree = (await syncGit(repo, ["write-tree"])).toString().trim();
  const commit = (await syncGit(repo, ["commit-tree", tree, "-m", "malicious link"])).toString().trim();
  await assert.rejects(readSyncTree(repo, commit), { code: "invalid-path" });
  assert.equal(fs.existsSync(join(repo, "skills")), false);
});

test("import rejects credential commands, unsafe model keys, conflicting case and byte limits", (t) => {
  setup(t);
  for (const model of [
    { providers: { p: { apiKey: "!echo secret" } } },
    { providers: { p: { apiKey: "!${SYNC_COMMAND}" } } },
    { providers: { p: { headers: { Authorization: "!${SYNC_COMMAND}" } } } },
    { providers: { p: { baseUrl: "https://example.invalid/v1?pw=synthetic-private-secret" } } },
    { providers: { p: { baseUrl: "https://example.invalid/v1#token=synthetic-private-secret" } } },
    { providers: { p: { baseUrl: `https://example.invalid/sk-${"a".repeat(32)}/v1` } } },
    { providers: { p: { baseUrl: "not a URL" } } },
    { providers: { p: { apiKey: "${PI_WEB_PASSWORD}" } } },
    { providers: { p: { baseUrl: "https://user:password@example.invalid" } } },
    { providers: { p: { baseUrl: "https://example.invalid?api_key=x" } } },
    { providers: { p: { headers: { Authorization: "Bearer literal" } } } },
  ]) assert.throws(() => decodeSyncConfig(files({}, model)));
  const proto = files(); proto.set("models.json", { data: Buffer.from('{"__proto__":{"unsafe":true}}'), mode: "100644" });
  assert.throws(() => decodeSyncConfig(proto));
  const caseConflict = files();
  caseConflict.set("skills/Foo.md", { data: Buffer.alloc(0), mode: "100644" });
  caseConflict.set("skills/foo.md", { data: Buffer.alloc(0), mode: "100644" });
  assert.throws(() => validateSyncFiles(caseConflict));
  assert.throws(() => validateSyncFiles(new Map([["skills/large.bin", { data: Buffer.alloc(10 * 1024 * 1024 + 1), mode: "100644" }]])), { code: "size-limit" });
});

test("unversioned npm package declarations are exported at the installed version, without installing", async (t) => {
  const { paths } = setup(t);
  fs.writeFileSync(join(paths.agentDir, "settings.json"), JSON.stringify({ packages: ["npm:sync-fixture-plugin"] }));
  const installed = join(paths.agentDir, "npm/node_modules/sync-fixture-plugin");
  fs.mkdirSync(installed, { recursive: true });
  fs.writeFileSync(join(installed, "package.json"), JSON.stringify({ name: "sync-fixture-plugin", version: "1.2.3" }));
  const snapshot = await collectSyncFiles(paths);
  assert.deepEqual(JSON.parse(snapshot.get("settings.json").data.toString()).packages, ["npm:sync-fixture-plugin@1.2.3"]);
});
