import assert from "node:assert/strict";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { ChildProcess } from "node:child_process";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { resolveProject, invalidateProjectCache } = await jiti.import("./worktree.ts");
const { queueProjectResolution } = await jiti.import("./project-resolution-queue.ts");

test("project counters distinguish cold/fresh/stale and background joins without paths", async () => {
  invalidateProjectCache();
  const cwd = join(tmpdir(), `SECRET-MISSING-${randomUUID()}`);
  const cold = {};
  const info = await resolveProject(cwd, cold);
  assert.deepEqual(cold, { coldMisses: 1, missingCwd: 1 });
  const fresh = {};
  assert.equal(await resolveProject(cwd, fresh), info);
  assert.deepEqual(fresh, { freshHits: 1 });
  globalThis.__piProjectCache.get(cwd).expiresAt = 0;
  const stale = {};
  const first = resolveProject(cwd, stale);
  const second = resolveProject(cwd, stale);
  assert.equal(await first, info);
  assert.equal(await second, info);
  assert.deepEqual(stale, { staleHits: 2, backgroundStarts: 1, backgroundJoins: 1 });
  await Promise.all(globalThis.__piProjectRefresh.values());
  assert.equal(stale.missingCwd, 1, "queued I/O counters advance only after background admission");
  assert.ok(!JSON.stringify([cold, fresh, stale]).includes("SECRET"));
  invalidateProjectCache();
});

test("invalidation while a cold lookup is queued prevents stale cache publication", async () => {
  invalidateProjectCache();
  const releases = [];
  const blockers = [0, 1].map(() => queueProjectResolution("background", () => new Promise(resolve => releases.push(resolve))));
  await new Promise(resolve => setImmediate(resolve));
  const cwd = join(tmpdir(), `missing-generation-${randomUUID()}`);
  const pending = resolveProject(cwd);
  invalidateProjectCache();
  releases.forEach(resolve => resolve());
  await Promise.all(blockers);
  await pending;
  assert.equal(globalThis.__piProjectCache.has(cwd), false);
  await resolveProject(cwd);
  assert.equal(globalThis.__piProjectCache.has(cwd), true);
  invalidateProjectCache();
});

test("stale display lookup does not synchronously launch Git and cold callers share one resolution", async t => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-project-queue-"));
  try {
    invalidateProjectCache();
    let launches = 0;
    const spawn = ChildProcess.prototype.spawn;
    t.mock.method(ChildProcess.prototype, "spawn", function (...args) { launches++; return spawn.apply(this, args); });
    const [a, b] = await Promise.all([resolveProject(cwd), resolveProject(cwd)]);
    assert.deepEqual(a, b);
    assert.equal(launches, 1, "duplicate cold lookups must share one Git process");
    globalThis.__piProjectCache.get(cwd).expiresAt = 0;
    launches = 0;
    const stale = resolveProject(cwd);
    assert.equal(launches, 0, "stale returns must not spawn in the caller's synchronous turn");
    assert.equal(await stale, a);
    await Promise.all(globalThis.__piProjectRefresh.values());
    assert.equal(launches, 1);
  } finally { invalidateProjectCache(); await rm(cwd, { recursive: true, force: true }); }
});
