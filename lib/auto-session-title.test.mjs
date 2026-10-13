import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const { AUTO_TITLE_TYPE, AutoSessionTitleController, StaleSessionTitleError, readSessionTitleState, renameSessionTitle, setSessionAutoTitleEnabled, latestSuccessfulTitleReply } = await createJiti(import.meta.url).import("./auto-session-title.ts");
const tick = () => new Promise((resolve) => setImmediate(resolve));
const reply = (text = "Done", stopReason = "stop") => ({
  role: "assistant", content: [{ type: "text", text }], stopReason,
  api: "test", provider: "test", model: "test", timestamp: Date.now(),
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});

function fixture(generate = async () => ({ title: "Implement feature" })) {
  const manager = SessionManager.inMemory("/tmp/title-test");
  const changed = [];
  const calls = [];
  const state = { alive: true, running: false };
  const session = { sessionId: manager.getSessionId(), sessionManager: manager };
  const controller = new AutoSessionTitleController({
    session, isAlive: () => state.alive, isRunning: () => state.running,
    onChanged: (value) => changed.push(value),
    generate: (source, options) => { calls.push(options); return generate(source, options); },
  });
  const finish = (reason = "stop") => {
    controller.beginRun();
    manager.appendMessage({ role: "user", content: "Implement feature", timestamp: Date.now() });
    manager.appendMessage(reply("Done", reason));
    controller.completeRun();
  };
  return { manager, controller, calls, changed, state, finish };
}

test("new sessions opt in; legacy titles and malformed metadata fail closed", () => {
  assert.equal(readSessionTitleState([], undefined).enabled, true);
  assert.equal(readSessionTitleState([], "Existing title").enabled, false);
  assert.equal(readSessionTitleState([{ type: "session_info", name: "" }], "").enabled, false);
  for (const data of [null, {}, { version: 1, enabled: true, title: "", source: "bogus" }]) {
    assert.equal(readSessionTitleState([{ type: "custom", customType: AUTO_TITLE_TYPE, data }], "").enabled, false);
  }
});

test("latest normal text reply must follow a user on the active branch", () => {
  const user = { type: "message", id: "u", message: { role: "user", content: "Hi" } };
  const assistant = { type: "message", id: "a", message: reply() };
  assert.equal(latestSuccessfulTitleReply([user, assistant]), "a");
  for (const reason of ["error", "aborted", "length", "toolUse", "pending", "deferred"]) {
    assert.equal(latestSuccessfulTitleReply([user, { ...assistant, message: reply("Partial", reason) }]), undefined);
  }
  assert.equal(latestSuccessfulTitleReply([assistant]), undefined);
  assert.equal(latestSuccessfulTitleReply([user, assistant, { ...user, id: "u2" }]), undefined);
  assert.equal(latestSuccessfulTitleReply([user, { ...assistant, message: reply("   ") }]), undefined);
});

test("each successful logical run generates once without adding conversation messages", async () => {
  const f = fixture(async () => ({ title: `Feature ${f.calls.length}` }));
  f.finish();
  f.controller.completeRun();
  await tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.manager.getSessionName(), "Feature 1");
  assert.equal(f.controller.getState().enabled, true);
  assert.equal(f.manager.getEntries().filter((entry) => entry.type === "message").length, 2);
  assert.equal(f.calls[0].timeoutMs, 15_000);
  f.finish();
  await tick();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].previousTitle, "Feature 1");
  assert.equal(f.manager.getSessionName(), "Feature 2");
});

test("an unchanged candidate produces no writes or refresh events", async () => {
  const f = fixture();
  f.finish();
  await tick();
  f.finish();
  const before = f.manager.getEntries().length;
  await tick();
  assert.equal(f.manager.getEntries().length, before);
  assert.equal(f.changed.length, 1);
});

test("old replies, errors, stopped runs and busy sessions do not trigger generation", async () => {
  for (const reason of ["error", "aborted", "length", "toolUse"]) {
    const f = fixture();
    f.finish(reason);
    await tick();
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  f.manager.appendMessage({ role: "user", content: "Old", timestamp: 1 });
  f.manager.appendMessage(reply());
  f.controller.beginRun();
  f.controller.completeRun();
  assert.equal(f.calls.length, 0);
  f.controller.stopRun();
  f.manager.appendMessage(reply("Stopped after a final response"));
  f.controller.completeRun();
  assert.equal(f.calls.length, 0);
  const busy = fixture();
  busy.state.running = true;
  busy.finish();
  assert.equal(busy.calls.length, 0);
});

test("manual rename cancels generation, persists a lock and can be explicitly re-enabled", async () => {
  const done = Promise.withResolvers();
  const f = fixture(() => done.promise);
  f.finish();
  f.controller.rename("My stable title");
  assert.equal(f.calls[0].signal.aborted, true);
  done.resolve({ title: "Late automatic title" });
  await tick();
  assert.equal(f.manager.getSessionName(), "My stable title");
  assert.equal(f.controller.getState().enabled, false);
  f.finish();
  assert.equal(f.calls.length, 1);
  f.controller.setEnabled(true);
  assert.equal(f.calls.length, 1, "enabling alone never calls a provider");
  f.finish();
  await tick();
  assert.equal(f.calls.length, 2);
  assert.equal(f.manager.getSessionName(), "Late automatic title");
});

for (const mutation of ["next run", "branch", "external name", "same-text external name", "shutdown", "disable"]) {
  test(`late result is discarded after ${mutation}`, async () => {
    const done = Promise.withResolvers();
    const f = fixture(() => done.promise);
    f.finish();
    const originalName = f.manager.getSessionName();
    switch (mutation) {
      case "next run": f.controller.beginRun(); break;
      case "branch": f.manager.branch(f.manager.getEntries().find((entry) => entry.type === "message").id); break;
      case "external name": f.manager.appendSessionInfo("External name"); break;
      case "same-text external name": f.manager.appendSessionInfo(originalName ?? ""); break;
      case "shutdown": f.state.alive = false; f.controller.cancel(); break;
      case "disable": f.controller.setEnabled(false); break;
    }
    done.resolve({ title: "Should not land" });
    await tick();
    assert.notEqual(f.manager.getSessionName(), "Should not land");
  });
}

test("explicit AI naming preserves policy and rejects overlapping or stale requests", async () => {
  const done = Promise.withResolvers();
  const f = fixture(() => done.promise);
  f.controller.rename("Hand named");
  const first = f.controller.generate();
  const rejected = assert.rejects(first, StaleSessionTitleError);
  const second = f.controller.generate();
  done.resolve({ title: "Generated once" });
  await rejected;
  await second;
  assert.equal(f.manager.getSessionName(), "Generated once");
  assert.equal(f.controller.getState().enabled, false);
});

test("failed optional generation is silent and is not retried for the same reply", async () => {
  const f = fixture(async () => { throw new Error("provider error with private detail"); });
  f.finish();
  await tick();
  f.controller.completeRun();
  await tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.changed.length, 0);
  assert.equal(f.manager.getSessionName(), undefined);
});

test("policy survives a real JSONL reopen and stays session-wide across branches", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "pi-auto-title-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const manager = SessionManager.create(directory, directory);
  const user = manager.appendMessage({ role: "user", content: "Goal", timestamp: 1 });
  manager.appendMessage(reply());
  renameSessionTitle(manager, "Pinned");
  setSessionAutoTitleEnabled(manager, true);
  const reopened = SessionManager.open(manager.getSessionFile());
  assert.equal(readSessionTitleState(reopened.getEntries(), reopened.getSessionName()).enabled, true);
  reopened.branch(user);
  assert.equal(readSessionTitleState(reopened.getEntries(), reopened.getSessionName()).enabled, true);
  reopened.appendSessionInfo("Pinned");
  assert.equal(readSessionTitleState(reopened.getEntries(), reopened.getSessionName()).enabled, false);
});
