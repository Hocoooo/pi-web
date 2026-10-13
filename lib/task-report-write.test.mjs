import assert from "node:assert/strict";
import test, { after } from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createTaskTestJiti } from "./__fixtures__/task-jiti.mjs";

// Install before Jiti imports the named fs binding; arm only for each write.
const rename = fs.rename, readFile = fs.readFile, mkdir = fs.mkdir;
let replacementFault, readGate, observeDirectory;
fs.rename = (...args) => replacementFault ? replacementFault(...args) : rename(...args);
fs.readFile = async (...args) => {
  if (readGate && args[0] === readGate.file) { readGate.entered(); await readGate.wait; }
  return readFile(...args);
};
fs.mkdir = (...args) => { observeDirectory?.(...args); return mkdir(...args); };
syncBuiltinESMExports();
after(() => { fs.rename = rename; fs.readFile = readFile; fs.mkdir = mkdir; syncBuiltinESMExports(); });
const jiti = createTaskTestJiti(import.meta.url);
const { writeTaskReport, getTaskReport } = await jiti.import("./task-reports.ts");
const { taskOperation } = await jiti.import("./task-operations.ts");

async function fixture(t) {
  const agentDir = await fs.mkdtemp(join(tmpdir(), "report-write-"));
  t.after(async () => { replacementFault = readGate = observeDirectory = undefined; await fs.rm(agentDir, { recursive: true, force: true }); });
  const before = { id: randomUUID(), status: "generating", body: null };
  await writeTaskReport(before, agentDir);
  return { agentDir, before, directory: join(agentDir, "task-reports"), file: join(agentDir, "task-reports", `${before.id}.json`) };
}

for (const code of ["EPERM", "EACCES", "EBUSY"]) {
  test(`Windows report replacement retries transient ${code} without exposing partial contents`, { skip: process.platform !== "win32" }, async t => {
    const f = await fixture(t);
    const beforeBytes = await fs.readFile(f.file);
    let attempts = 0;
    replacementFault = async (temporary, destination) => {
      assert.equal(destination, f.file);
      assert.deepEqual(await fs.readFile(f.file), beforeBytes, "old report stays readable until successful replacement");
      if (++attempts < 3) throw Object.assign(new Error("Controlled sharing violation"), { code });
      return rename(temporary, destination);
    };
    const after = { ...f.before, status: "generated", body: "Complete archive" };
    await writeTaskReport(after, f.agentDir);
    assert.equal(attempts, 3);
    assert.deepEqual(JSON.parse(await fs.readFile(f.file, "utf8")), after);
    assert.deepEqual(await fs.readdir(f.directory), [`${f.before.id}.json`], "one temporary file is cleaned up");
  });
}

for (const code of ["EPERM", "EACCES", "EBUSY", "EIO"]) {
  test(`permanent report replacement ${code} preserves the original and ends boundedly`, async t => {
    const f = await fixture(t), bytes = await fs.readFile(f.file);
    const failure = Object.assign(new Error("Controlled permanent replacement failure"), { code });
    let attempts = 0;
    replacementFault = async () => { attempts++; throw failure; };
    await assert.rejects(writeTaskReport({ ...f.before, body: "Never published" }, f.agentDir), error => error === failure);
    assert.equal(attempts, process.platform === "win32" && code !== "EIO" ? 6 : 1);
    assert.deepEqual(await fs.readFile(f.file), bytes);
    assert.deepEqual(await fs.readdir(f.directory), [`${f.before.id}.json`]);
  });
}

test("a blocked committed report read queues replacement until its handle is finished", async t => {
  const f = await fixture(t), options = { agentDir: f.agentDir };
  const { task } = await taskOperation({ action: "create", id: randomUUID(), title: "Committed report", description: "", completionCriteria: "", cwd: null }, options);
  const archived = await taskOperation({ action: "set-archive", id: task.id, archived: true, expectedArchiveRevision: 0, operationId: randomUUID() }, options);
  const id = archived.task.reportIds[0], before = await getTaskReport(id, f.agentDir);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  readGate = { file: join(f.agentDir, "task-reports", `${id}.json`), entered: () => entered.resolve(), wait: release.promise };
  const reading = getTaskReport(id, f.agentDir);
  await entered.promise;
  let started = false;
  observeDirectory = directory => { if (directory === f.directory) started = true; };
  const updated = { ...before, body: "New complete archive" }, writing = writeTaskReport(updated, f.agentDir);
  try {
    await Promise.resolve();
    assert.equal(started, false, "writer does not even create its temp while the read is blocked");
    release.resolve();
    assert.deepEqual(await reading, before, "reader finishes the original complete version");
    await writing;
    assert.equal(started, true);
    assert.deepEqual(await getTaskReport(id, f.agentDir), updated);
  } finally {
    release.resolve(); readGate = undefined; observeDirectory = undefined;
    await Promise.allSettled([reading, writing]);
  }
});
