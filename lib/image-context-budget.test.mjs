import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { SessionManager } from "@earendil-works/pi-coding-agent";
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { imageContextMaxBytes, imageBase64Bytes, planImageOffload, offloadSessionImages, DEFAULT_IMAGE_CONTEXT_MAX_BYTES } = await jiti.import("./image-context-budget.ts");
const { buildSessionContext } = await jiti.import("./session-reader.ts");
const image = data => ({ type: "image", data, mimeType: "image/png" });
const text = value => ({ type: "text", text: value });
const user = content => ({ role: "user", content, timestamp: 1 });
const bytes = manager => manager.buildSessionProjection().messages.reduce((n, m) => n + imageBase64Bytes(m.content), 0);
const assistant = { role: "assistant", content: [text("ok")], stopReason: "stop", api: "anthropic-messages", provider: "anthropic", model: "test", timestamp: 2, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };

test("configuration is positive safe integer Base64 bytes, default 20 MiB", () => {
  assert.equal(DEFAULT_IMAGE_CONTEXT_MAX_BYTES, 20 * 1024 * 1024);
  assert.equal(imageContextMaxBytes("123"), 123);
  for (const value of ["", "0", "-1", "1.5", "NaN", "Infinity", " 12", "1e6", "9007199254740992"]) assert.throws(() => imageContextMaxBytes(value), /positive safe integer/);
  assert.equal(imageBase64Bytes([image("AAAA"), text("irrelevant"), image("BBBBBBBB")]), 12);
});

test("boundary counts encoded bytes, not decoded bytes or tokens; at cap is a no-op", () => {
  const m = SessionManager.inMemory();
  m.appendMessage(user([image("A".repeat(DEFAULT_IMAGE_CONTEXT_MAX_BYTES))]));
  assert.deepEqual(planImageOffload(m.buildSessionProjection(), DEFAULT_IMAGE_CONTEXT_MAX_BYTES), []);
  assert.throws(() => planImageOffload(m.buildSessionProjection(), DEFAULT_IMAGE_CONTEXT_MAX_BYTES - 1), /newest image-bearing message/);
});

test("oldest blocks removed only as necessary; effective edits and newest custom message group preserved", () => {
  const m = SessionManager.inMemory();
  const old = m.appendMessage(user([text("raw"), image("AAAA"), image("BBBB"), image("CCCC")]));
  m.appendContextEdit(old, { content: [text("prior edit"), image("BBBB"), image("CCCC")] });
  const latest = m.appendCustomMessageEntry("fixture", [image("DDDD"), image("EEEE")], true, { original: true });
  const raw = structuredClone(m.getEntries());
  offloadSessionImages(m, 12);
  assert.equal(bytes(m), 12);
  const projection = m.buildSessionProjection();
  const changed = projection.entries.find(e => e.sourceEntry.id === old).messages[0];
  assert.equal(changed.content[0].text, "prior edit");
  assert.match(changed.content[1].text, /offloaded/);
  assert.deepEqual(changed.content[2], image("CCCC"));
  assert.deepEqual(projection.entries.find(e => e.sourceEntry.id === latest).messages[0].content, [image("DDDD"), image("EEEE")]);
  assert.deepEqual(m.getEntries().slice(0, raw.length), raw);
  const count = m.getEntries().length;
  offloadSessionImages(m, 12);
  assert.equal(m.getEntries().length, count, "no duplicate edits on repeated preparation");
});

test("oversized newest custom/tool group rejects atomically without editing earlier images", () => {
  for (const kind of ["custom", "toolResult"]) {
    const m = SessionManager.inMemory();
    m.appendMessage(user([image("AAAA")]));
    if (kind === "custom") m.appendCustomMessageEntry("fixture", [image("BBBB"), image("CCCC")], true);
    else m.appendMessage({ role: "toolResult", toolCallId: "call", toolName: "read", content: [image("BBBB"), image("CCCC")], isError: false, timestamp: 2 });
    const before = structuredClone(m.getEntries());
    assert.throws(() => offloadSessionImages(m, 4), /newest image-bearing message/);
    assert.deepEqual(m.getEntries(), before);
  }
});

test("native persistence, sibling branches, fork/clone and compaction retain raw images but not offloaded context", t => {
  const dir = mkdtempSync(join(tmpdir(), "pi-image-persist-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const m = SessionManager.create(dir, dir);
  const old = m.appendMessage(user([text("old"), image("AAAAAAAA")]));
  const call = m.appendMessage({ ...assistant, content: [{ type: "toolCall", id: "call", name: "pictures", arguments: {} }], stopReason: "toolUse" });
  const result = m.appendMessage({ role: "toolResult", toolCallId: "call", toolName: "pictures", content: [text("result"), image("BBBBBBBB")], isError: false, details: { identity: "unchanged" }, timestamp: 3 });
  const newest = m.appendCustomMessageEntry("custom", [image("CCCC"), image("DDDD")], true);
  const beforeEdit = m.getLeafId();
  const rawPrefix = readFileSync(m.getSessionFile(), "utf8");
  offloadSessionImages(m, 8);
  const editedLeaf = m.getLeafId();
  assert.equal(bytes(m), 8);
  assert.ok(readFileSync(m.getSessionFile(), "utf8").startsWith(rawPrefix));
  const projection = m.buildSessionProjection().messages;
  assert.deepEqual(projection.find(v => v.role === "assistant"), m.getEntry(call).message);
  assert.deepEqual(projection.find(v => v.role === "toolResult").details, { identity: "unchanged" });
  assert.equal(projection.find(v => v.role === "toolResult").toolCallId, "call");
  const rawUi = buildSessionContext(m.getEntries(), editedLeaf);
  assert.ok(rawUi.entryIds.includes(old));
  assert.ok(rawUi.entryIds.includes(result));
  assert.equal(rawUi.messages.reduce((n, v) => n + imageBase64Bytes(v.content), 0), 24);
  const reopened = SessionManager.open(m.getSessionFile(), dir);
  assert.equal(bytes(reopened), 8);
  reopened.branch(beforeEdit);
  assert.equal(bytes(reopened), 24, "before-edit branch has original contributions");
  const sibling = reopened.appendMessage(user("sibling"));
  assert.equal(bytes(reopened), 24, "unrelated branch does not inherit offload");
  offloadSessionImages(reopened, 8);
  assert.equal(bytes(reopened), 8);
  reopened.branch(editedLeaf);
  assert.equal(bytes(reopened), 8);
  for (const [kind, leaf, expected] of [["clone", editedLeaf, 8], ["fork_branch", beforeEdit, 24], ["fork-before-target", m.getEntry(newest).parentId, 16]]) {
    const source = SessionManager.open(m.getSessionFile(), dir);
    const file = source.createBranchedSession(leaf);
    const child = SessionManager.open(file, dir);
    assert.equal(bytes(child), expected, kind);
    assert.equal(child.getEntry(old).id, old);
    assert.equal(child.getEntry(sibling), undefined);
    offloadSessionImages(child, 8);
    assert.equal(bytes(child), 8);
  }
  reopened.appendCompaction("text summary", old, 100);
  assert.equal(bytes(reopened), 8, "retained old messages honor pre-compaction edits");
  reopened.appendCompaction("new summary", newest, 100);
  assert.equal(bytes(reopened), 8);
  assert.equal(bytes(SessionManager.open(reopened.getSessionFile(), dir)), 8);
  assert.deepEqual(reopened.getEntry(old).message.content, [text("old"), image("AAAAAAAA")]);
});
