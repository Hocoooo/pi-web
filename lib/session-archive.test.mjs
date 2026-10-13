import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import lockfile from "proper-lockfile";
import { createJiti } from "jiti";

const exec = promisify(execFile);
const sandbox = await mkdtemp(join(tmpdir(), "pi-web-session-archive-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = join(sandbox, "default-agent");
test.after(async () => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previous;
  await rm(sandbox, { recursive: true, force: true });
});
const jiti = createJiti(import.meta.url, { moduleCache: false });
const archive = await jiti.import("./session-archive.ts");
const { getSessionArchivePath, readArchivedSessionIds, setSessionArchived, isSessionArchiveError, isSessionArchiveId, SESSION_ARCHIVE_MAX_BYTES } = archive;
const sourceUrl = new URL("./session-archive.ts", import.meta.url).href;
const idA = randomUUID(), idB = randomUUID(), idC = randomUUID();

async function fixture(t) {
  const root = await mkdtemp(join(sandbox, "case-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, file: getSessionArchivePath(root) };
}
async function refused(promise, code) {
  await assert.rejects(promise, error => {
    assert.ok(isSessionArchiveError(error), String(error));
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /PRIVATE|session-archive-.*case-|\{.*version/);
    return true;
  });
}
async function child(root, operation) {
  const script = `import { createJiti } from "jiti";
    const a = await createJiti(import.meta.url, { moduleCache: false }).import(${JSON.stringify(sourceUrl)});
    const root = ${JSON.stringify(root)};
    ${operation}`;
  return exec(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...process.env, PI_CODING_AGENT_DIR: root }, timeout: 30_000,
  });
}

test("missing reads are empty without creating directories or files; default path is sandboxed", async t => {
  const { root } = await fixture(t);
  const missing = join(root, "not-created", "agent");
  assert.deepEqual([...await readArchivedSessionIds(missing)], []);
  await assert.rejects(stat(join(root, "not-created")), { code: "ENOENT" });
  assert.equal(getSessionArchivePath(), join(process.env.PI_CODING_AGENT_DIR, "session-archive.json"));
  assert.deepEqual([...await readArchivedSessionIds()], []);
  await assert.rejects(stat(process.env.PI_CODING_AGENT_DIR), { code: "ENOENT" });
});

test("archive/restore are idempotent, preserve others, and write private v1 metadata only", async t => {
  const { root, file } = await fixture(t);
  await setSessionArchived(idA, false, root);
  await assert.rejects(stat(file), { code: "ENOENT" });
  await setSessionArchived(idA, true, root);
  await setSessionArchived(idB, true, root);
  const bytes = await readFile(file);
  const inode = (await stat(file)).ino;
  await setSessionArchived(idA, true, root);
  assert.deepEqual(await readFile(file), bytes);
  assert.equal((await stat(file)).ino, inode);
  const document = JSON.parse(bytes);
  assert.deepEqual(document, { version: 1, archivedSessionIds: [idA, idB].sort() });
  if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);
  await setSessionArchived(idA, false, root);
  assert.deepEqual([...await readArchivedSessionIds(root)], [idB]);
  await setSessionArchived(idA, false, root);
  await setSessionArchived(idB, false, root);
  assert.deepEqual([...await readArchivedSessionIds(root)], []);
  assert.deepEqual(await readdir(root), ["session-archive.json"]);
});

test("fresh module and restarted process read the persisted archive; sets returned are independent", async t => {
  const { root } = await fixture(t);
  await setSessionArchived(idA, true, root);
  const fresh = await createJiti(import.meta.url, { moduleCache: false }).import("./session-archive.ts");
  const ids = await fresh.readArchivedSessionIds(root);
  assert.deepEqual([...ids], [idA]);
  ids.add(idC);
  assert.deepEqual([...await readArchivedSessionIds(root)], [idA]);
  const { stdout } = await child(root, "console.log(JSON.stringify([...await a.readArchivedSessionIds(root)]));");
  assert.deepEqual(JSON.parse(stdout), [idA]);
});

test("concurrent archive and restore requests preserve independent IDs", async t => {
  const { root } = await fixture(t);
  const ids = Array.from({ length: 40 }, () => randomUUID());
  await Promise.all(ids.map(id => setSessionArchived(id, true, root)));
  assert.deepEqual([...await readArchivedSessionIds(root)].sort(), ids.sort());
  await Promise.all(ids.map((id, index) => setSessionArchived(id, index % 2 === 0, root)));
  assert.deepEqual([...await readArchivedSessionIds(root)].sort(), ids.filter((_, index) => index % 2 === 0).sort());
});

test("independent processes perform serialized RMW without losing records", async t => {
  const { root } = await fixture(t);
  await setSessionArchived(idA, true, root);
  const groups = Array.from({ length: 4 }, () => Array.from({ length: 5 }, () => randomUUID()));
  await Promise.all(groups.map(ids => child(root,
    `await Promise.all(${JSON.stringify(ids)}.map(id => a.setSessionArchived(id, true, root)));`)));
  assert.deepEqual([...await readArchivedSessionIds(root)].sort(), [idA, ...groups.flat()].sort());
});

test("safe native UUID validation rejects traversal, prototype keys, and nonboolean sets before IO", async t => {
  const { root } = await fixture(t);
  const missing = join(root, "missing");
  assert.equal(isSessionArchiveId(idA), true);
  for (const id of ["__proto__", "constructor", "../escape", "/tmp/file", "a/b", "a\\b", "a..b", "entry123", "", null, 1, idA + "\n", idA.toUpperCase()]) {
    assert.equal(isSessionArchiveId(id), false, String(id));
    await refused(setSessionArchived(id, true, missing), "invalid-input");
  }
  for (const archived of ["true", 1, null, undefined]) await refused(setSessionArchived(idA, archived, missing), "invalid-input");
  assert.deepEqual(await readdir(root), []);
});

for (const [name, text, code] of [
  ["malformed private JSON", '{"PRIVATE":"do not disclose",', "invalid-storage"],
  ["null", "null", "invalid-storage"],
  ["array", "[]", "invalid-storage"],
  ["missing version", JSON.stringify({ archivedSessionIds: [idA] }), "invalid-storage"],
  ["future schema", JSON.stringify({ version: 3, archivedSessionIds: [idA], PRIVATE: "preserve" }), "unsupported-version"],
  ["unknown field", JSON.stringify({ version: 1, archivedSessionIds: [idA], PRIVATE: "preserve" }), "invalid-storage"],
  ["missing records", '{"version":1}', "invalid-storage"],
  ["wrong records", '{"version":1,"archivedSessionIds":{}}', "invalid-storage"],
  ["bad ID", '{"version":1,"archivedSessionIds":["__proto__"]}', "invalid-storage"],
  ["duplicate ID", JSON.stringify({ version: 1, archivedSessionIds: [idA, idA] }), "invalid-storage"],
]) {
  test(`refuses ${name} on read and even an idempotent write, preserving original bytes`, async t => {
    const { root, file } = await fixture(t);
    await writeFile(file, text);
    await refused(readArchivedSessionIds(root), code);
    await refused(setSessionArchived(idA, true, root), code);
    await refused(setSessionArchived(idB, false, root), code);
    assert.equal(await readFile(file, "utf8"), text);
    assert.deepEqual(await readdir(root), ["session-archive.json"]);
  });
}

test("symlinks (including dangling), directories and FIFOs are refused without overwriting", async t => {
  const { root, file } = await fixture(t);
  const target = join(root, "target");
  await writeFile(target, JSON.stringify({ version: 1, archivedSessionIds: [idA] }));
  const bytes = await readFile(target);
  try { await symlink(target, file); }
  catch (error) { if (process.platform === "win32" && error.code === "EPERM") { t.skip("symlink privilege unavailable"); return; } throw error; }
  await refused(readArchivedSessionIds(root), "invalid-storage");
  await refused(setSessionArchived(idB, true, root), "invalid-storage");
  assert.equal((await lstat(file)).isSymbolicLink(), true);
  assert.deepEqual(await readFile(target), bytes);
  await rm(target);
  await refused(readArchivedSessionIds(root), "invalid-storage");
  await refused(setSessionArchived(idB, true, root), "invalid-storage");
  assert.equal((await lstat(file)).isSymbolicLink(), true);
  await rm(file);
  await mkdir(file);
  await refused(readArchivedSessionIds(root), "invalid-storage");
  await refused(setSessionArchived(idB, true, root), "invalid-storage");
  assert.equal((await stat(file)).isDirectory(), true);
  await rm(file, { recursive: true });
  if (process.platform !== "win32") {
    await exec("mkfifo", [file]);
    await refused(readArchivedSessionIds(root), "invalid-storage");
    await refused(setSessionArchived(idB, true, root), "invalid-storage");
    assert.equal((await lstat(file)).isFIFO(), true);
  }
});

test("bounded reads and oversized commits refuse without losing the original records", async t => {
  const { root, file } = await fixture(t);
  await writeFile(file, " ".repeat(SESSION_ARCHIVE_MAX_BYTES + 1));
  await refused(readArchivedSessionIds(root), "invalid-storage");
  await refused(setSessionArchived(idA, true, root), "invalid-storage");
  assert.equal((await stat(file)).size, SESSION_ARCHIVE_MAX_BYTES + 1);
  const overhead = Buffer.byteLength(`${JSON.stringify({ version: 1, archivedSessionIds: [] })}\n`);
  const count = Math.floor((SESSION_ARCHIVE_MAX_BYTES - overhead + 1) / 39);
  const ids = Array.from({ length: count }, (_, index) => `00000000-0000-0000-0000-${index.toString(16).padStart(12, "0")}`);
  const text = `${JSON.stringify({ version: 1, archivedSessionIds: ids })}\n`;
  assert.ok(Buffer.byteLength(text) <= SESSION_ARCHIVE_MAX_BYTES);
  await writeFile(file, text);
  await refused(setSessionArchived(idA, true, root), "invalid-storage");
  assert.equal(await readFile(file, "utf8"), text);
});

test("held cross-process lock produces a typed refusal, then a retry succeeds", async t => {
  const { root, file } = await fixture(t);
  await setSessionArchived(idA, true, root);
  const bytes = await readFile(file);
  const release = await lockfile.lock(file, { realpath: false });
  try { await refused(setSessionArchived(idB, true, root), "storage-unavailable"); }
  finally { await release(); }
  assert.deepEqual(await readFile(file), bytes);
  await setSessionArchived(idB, true, root);
  assert.deepEqual([...await readArchivedSessionIds(root)].sort(), [idA, idB].sort());
});

test("write permission failure preserves metadata and cleans up temporary files", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, async t => {
  const { root, file } = await fixture(t);
  await setSessionArchived(idA, true, root);
  const bytes = await readFile(file);
  await chmod(file, 0o400);
  // Deny metadata mutation, including lock-directory and sibling-temp creation.
  await chmod(root, 0o500);
  try { await refused(setSessionArchived(idB, true, root), "storage-unavailable"); }
  finally { await chmod(root, 0o700); }
  assert.deepEqual(await readFile(file), bytes);
  assert.deepEqual(await readdir(root), ["session-archive.json"]);
});

test("native history bytes/paths are unchanged and new fork IDs do not inherit archive metadata", async t => {
  const { root } = await fixture(t);
  const sessions = join(root, "sessions", "fixture-project");
  await mkdir(sessions, { recursive: true });
  const source = join(sessions, `source_${idA}.jsonl`), fork = join(sessions, `fork_${idB}.jsonl`);
  const history = Buffer.from(`${JSON.stringify({ type: "session", version: 3, id: idA, cwd: "/fixture" })}\n{"type":"message","PRIVATE":"history bytes stay exact"}\n`);
  const forkHistory = Buffer.from(`${JSON.stringify({ type: "session", version: 3, id: idB, parentSession: source })}\n`);
  await writeFile(source, history); await writeFile(fork, forkHistory);
  const names = await readdir(sessions);
  await setSessionArchived(idA, true, root);
  assert.equal((await readArchivedSessionIds(root)).has(idB), false);
  // Internal store can mark any UUID independently, even a child ID.
  await setSessionArchived(idB, true, root);
  await setSessionArchived(idA, false, root);
  assert.deepEqual([...await readArchivedSessionIds(root)], [idB]);
  assert.deepEqual(await readFile(source), history);
  assert.deepEqual(await readFile(fork), forkHistory);
  assert.deepEqual(await readdir(sessions), names);
});
