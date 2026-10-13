import assert from "node:assert/strict";
import test, { after } from "node:test";
import fs from "node:fs/promises";
import lockfile from "proper-lockfile";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createTaskTestJiti } from "./__fixtures__/task-jiti.mjs";

const rename = fs.rename, lock = lockfile.lock;
let replacementFault, compromise;
fs.rename = (...args) => replacementFault ? replacementFault(...args) : rename(...args);
lockfile.lock = async (file, options) => {
  compromise = options.onCompromised;
  return lock(file, options);
};
syncBuiltinESMExports();
after(() => { fs.rename = rename; lockfile.lock = lock; syncBuiltinESMExports(); });
const { taskOperation } = await createTaskTestJiti(import.meta.url).import("./task-operations.ts");

async function fixture(t) {
  const agentDir = await fs.mkdtemp(join(tmpdir(), "board-write-"));
  t.after(async () => { replacementFault = undefined; await fs.rm(agentDir, { recursive: true, force: true }); });
  const options = { agentDir };
  const { task } = await taskOperation({ action: "create", id: randomUUID(), title: "Before", description: "Original", completionCriteria: "User checks", cwd: null }, options);
  const directory = join(agentDir, "tasks"), file = join(directory, "board.json");
  const request = { action: "edit", id: task.id, expectedRevision: task.revision, title: "After", description: task.description,
    completionCriteria: task.completionCriteria, priority: task.priority, labels: task.labels };
  return { options, task, file, directory, request, bytes: await fs.readFile(file) };
}

test("Windows board replacement retries the same file without replaying the edit", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t); let attempts = 0, temporaryFile;
  replacementFault = async (temporary, destination) => {
    assert.equal(destination, f.file);
    temporaryFile ??= temporary; assert.equal(temporary, temporaryFile, "no new logical write on retry");
    assert.deepEqual(await fs.readFile(f.file), f.bytes);
    if (++attempts < 3) throw Object.assign(new Error("Controlled sharing violation"), { code: "EPERM" });
    return rename(temporary, destination);
  };
  const result = await taskOperation(f.request, f.options);
  assert.equal(attempts, 3); assert.equal(result.task.title, "After");
  assert.equal(result.task.revision, f.task.revision + 1);
  assert.equal(result.board.orderRevision, 1);
  assert.deepEqual(await fs.readdir(f.directory), ["board.json"]);
});

test("permanent board replacement failure leaves bytes unchanged and a later retry works", async t => {
  const f = await fixture(t); let attempts = 0;
  replacementFault = async () => { attempts++; throw Object.assign(new Error("Controlled denial"), { code: "EACCES" }); };
  await assert.rejects(taskOperation(f.request, f.options), { code: "storage-unavailable" });
  assert.equal(attempts, process.platform === "win32" ? 6 : 1);
  assert.deepEqual(await fs.readFile(f.file), f.bytes);
  assert.deepEqual(await fs.readdir(f.directory), ["board.json"]);
  replacementFault = undefined;
  const result = await taskOperation(f.request, f.options);
  assert.equal(result.task.revision, f.task.revision + 1);
});

test("Windows replacement rechecks the real board lock after backoff and refuses a compromised commit", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t); let attempts = 0;
  replacementFault = async () => {
    attempts++; compromise(new Error("Controlled ownership loss"));
    throw Object.assign(new Error("Controlled sharing violation"), { code: "EPERM" });
  };
  await assert.rejects(taskOperation(f.request, f.options), error => error.code === "storage-unavailable" && /lost its lock/.test(error.message));
  assert.equal(attempts, 1, "authority loss prevents the second rename");
  assert.deepEqual(await fs.readFile(f.file), f.bytes);
  assert.deepEqual(await fs.readdir(f.directory), ["board.json"]);
  replacementFault = undefined;
  const result = await taskOperation(f.request, f.options);
  assert.equal(result.task.revision, f.task.revision + 1);
});
