import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { archiveSessionBatchOnce, readArchivedSessionIds, setSessionArchived } = await jiti.import("./session-archive.ts");
const fingerprint = createHash("sha256").update("Synthetic fixed batch").digest("hex");
const batch = sessionIds => ({ taskId: randomUUID(), operationId: randomUUID(), fingerprint, sessionIds });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "session-archive-batch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, file: join(root, "session-archive.json") };
}

test("batch writes all roots and receipt atomically, preserves v1 IDs and deduplicates after manual restoration", async t => {
  const { root, file } = await fixture(t), a = randomUUID(), b = randomUUID(), unrelated = randomUUID();
  await setSessionArchived(unrelated, true, root);
  assert.equal(JSON.parse(await readFile(file, "utf8")).version, 1);
  const input = batch([a, b]); await archiveSessionBatchOnce(input, root, async () => true);
  assert.deepEqual(new Set(await readArchivedSessionIds(root)), new Set([a, b, unrelated]));
  const document = JSON.parse(await readFile(file, "utf8"));
  assert.equal(document.version, 2); assert.equal(document.taskArchiveReceipts.length, 1);
  await setSessionArchived(a, false, root);
  const fresh = await createJiti(import.meta.url, { moduleCache: false }).import("./session-archive.ts");
  await fresh.archiveSessionBatchOnce(input, root, async () => { throw new Error("Committed batch cannot re-authorize or replay"); });
  assert.deepEqual(new Set(await readArchivedSessionIds(root)), new Set([b, unrelated]));
  assert.equal(JSON.parse(await readFile(file, "utf8")).taskArchiveReceipts.length, 1);
  await assert.rejects(archiveSessionBatchOnce({ ...input, fingerprint: "a".repeat(64) }, root, async () => true), { code: "invalid-input" });
});

test("scope refusal leaves v1 bytes intact, and a new explicit intent replaces only its task's latest receipt", async t => {
  const { root, file } = await fixture(t), a = randomUUID(), b = randomUUID();
  await setSessionArchived(a, true, root); const before = await readFile(file);
  await assert.rejects(archiveSessionBatchOnce(batch([b]), root, async () => false), { code: "scope-changed" });
  assert.deepEqual(await readFile(file), before);
  const first = batch([b]), other = batch([a]);
  await archiveSessionBatchOnce(first, root, async () => true); await archiveSessionBatchOnce(other, root, async () => true);
  await setSessionArchived(b, false, root);
  await archiveSessionBatchOnce({ ...first, operationId: randomUUID() }, root, async () => true);
  assert.equal(JSON.parse(await readFile(file, "utf8")).taskArchiveReceipts.length, 2);
  assert.equal((await readArchivedSessionIds(root)).has(b), true);
});

test("concurrent independent process batches and manual writers do not lose IDs or receipts", async t => {
  const { root } = await fixture(t), inputs = Array.from({ length: 3 }, () => batch([randomUUID(), randomUUID()]));
  const source = new URL("./session-archive.ts", import.meta.url).href;
  const exec = promisify(execFile);
  const manualId = randomUUID();
  await Promise.all([setSessionArchived(manualId, true, root), ...inputs.map(input => exec(process.execPath, ["--input-type=module", "-e", `
    import { createJiti } from 'jiti';
    const { archiveSessionBatchOnce } = await createJiti(import.meta.url).import(${JSON.stringify(source)});
    await archiveSessionBatchOnce(${JSON.stringify(input)}, ${JSON.stringify(root)}, async () => true);`], { cwd: process.cwd(), timeout: 30000 }))]);
  assert.deepEqual(new Set(await readArchivedSessionIds(root)), new Set([manualId, ...inputs.flatMap(input => input.sessionIds)]));
});

for (const [name, receipt] of [
  ["missing fields", {}], ["extra fields", { taskId: randomUUID(), operationId: randomUUID(), fingerprint, private: "no" }],
  ["unsafe task ID", { taskId: "../escape", operationId: randomUUID(), fingerprint }],
  ["invalid fingerprint", { taskId: randomUUID(), operationId: randomUUID(), fingerprint: "bad" }],
]) test(`malformed v2 ${name} is refused on reads and writes without repair`, async t => {
  const { root, file } = await fixture(t), id = randomUUID();
  const bytes = JSON.stringify({ version: 2, archivedSessionIds: [id], taskArchiveReceipts: [receipt] }); await writeFile(file, bytes);
  await assert.rejects(readArchivedSessionIds(root), { code: "invalid-storage" });
  await assert.rejects(setSessionArchived(id, false, root), { code: "invalid-storage" });
  await assert.rejects(archiveSessionBatchOnce(batch([id]), root, async () => true), { code: "invalid-storage" });
  assert.equal(await readFile(file, "utf8"), bytes);
});
