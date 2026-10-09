import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { markerCommand, registerMcpSessionCleanup } from "./__fixtures__/mcp-test-helpers.mjs";

test("shell markers quote spaces and apostrophes rather than treating paths as commands", () => {
  assert.equal(markerCommand("a folder/it's marker", "it's done"), "!touch 'a folder/it'\\''s marker' && echo 'it'\\''s done'");
  if (process.platform === "win32") {
    assert.equal(markerCommand("C:\\a folder\\marker", "ok"), "!touch 'C:/a folder/marker' && echo 'ok'");
  }
});

test("MCP cleanup waits for every shutdown even if another shutdown fails", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-mcp-cleanup-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const cwd1 = await mkdtemp(join(root, "one-"));
  const cwd2 = await mkdtemp(join(root, "two-"));
  const hooks = [];
  const context = { after: (hook) => hooks.push(hook) };
  const shutdowns = [];
  registerMcpSessionCleanup(context, { async shutdown() {
    assert.ok(existsSync(cwd1), "shutdown runs before removing the child's cwd");
    shutdowns.push("one");
    throw new Error("first shutdown failed");
  } }, cwd1);
  registerMcpSessionCleanup(context, { async shutdown() {
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(existsSync(cwd2));
    shutdowns.push("two");
  } }, cwd2);
  assert.equal(hooks.length, 1);
  await assert.rejects(hooks[0](), (error) => error instanceof AggregateError && error.errors[0].message === "first shutdown failed");
  assert.deepEqual(shutdowns, ["one", "two"]);
  assert.equal(existsSync(cwd1), false);
  assert.equal(existsSync(cwd2), false);
});
