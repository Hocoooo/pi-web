import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import ts from "typescript";
import { MAX_ATTACHED_IMAGES, isBase64ImageWithinLimits } from "../lib/image-attachments.ts";

// Invoke the real hook callback, following the existing settings callback tests.
// SDK/full-clear atomicity is separately exercised by video-queue.test.mjs.
const source = ts.createSourceFile("useAgentSession.ts", readFileSync(new URL("./useAgentSession.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
function callback(context) {
  function find(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === "handleRecallQueue") return node.initializer.arguments[0];
    return ts.forEachChild(node, find);
  }
  const node = find(source); assert.ok(node);
  return new Script(ts.transpileModule(`(${node.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText).runInNewContext(context);
}
const plain = { steering: [], followUp: [{ text: "Plain queued question", images: [] }] };
const video = { version: 1, id: "known-video-id", path: "/fixture/later.avi", mimeType: "video/avi" };
const png = { type: "image", data: Buffer.from("native-image-bytes").toString("base64"), mimeType: "image/png" };
const draftPng = { data: png.data, mimeType: png.mimeType };
const native = { steering: [{ text: "Native video question", images: [png], video }], followUp: [] };
const copy = x => JSON.parse(JSON.stringify(x));
function fixture(inputs = plain, resultInputs = inputs, occupied = false) {
  const calls = [], context = {
    console: { error() {} }, MAX_ATTACHED_IMAGES, isBase64ImageWithinLimits,
    sessionIdRef: { current: "fixture" }, sessionHookMountedRef: { current: true },
    restoringSubmissionRef: { current: false }, submittedDraftRef: { current: null },
    agentRunningRef: { current: false }, bashRunningRef: { current: false }, isCompacting: false,
    promptRunIdRef: { current: 1 }, entryIdsRef: { current: ["old-entry"] },
    queuedMessages: { steering: [], followUp: ["Plain queued question"], inputs: copy(inputs) },
    composerDraftKey: "fixture", resolveComposerDraftKey: key => key, getDraft: () => null,
    opts: { chatInputRef: { current: { hasInput: () => occupied, canRestoreImages: () => true, prependText: text => calls.push(["prepend", text]) } } },
    addNotice: notice => calls.push(["notice", copy(notice)]),
    setRestoringSubmission: value => calls.push(["busy", value]),
    setUnconfirmedSubmission: draft => calls.push(["saved", copy(draft)]),
    setQueuedMessages: value => calls.push(["queue", copy(value)]),
    clearSubmittedDraft: () => { context.submittedDraftRef.current = null; calls.push(["release"]); },
    restoreSubmission: (...args) => calls.push(["restore", ...copy(args)]),
    loadSession: async (...args) => { calls.push(["load", ...copy(args)]); return null; },
    sendAgentCommand: async (sid, command) => {
      calls.push(["rpc", sid, copy(command)]);
      return { steering: ["server summary must not classify media"], followUp: [], inputs: copy(resultInputs) };
    },
  };
  return { calls, context, recall: callback(context) };
}

test("plain busy Recall sends full native inputs as a clear precondition, without adding an idle gate", async () => {
  const f = fixture(); f.context.agentRunningRef.current = true;
  await f.recall();
  assert.deepEqual(f.calls.find(c => c[0] === "rpc")[2], { type: "clear_queue", recall: true, recallInputs: plain });
  assert.deepEqual(f.calls.find(c => c[0] === "prepend"), ["prepend", "Plain queued question"]);
  assert.equal(f.context.submittedDraftRef.current, null);
});

test("missing full input projection never authorizes destructive Recall; only refreshes authority", async () => {
  const f = fixture(); delete f.context.queuedMessages.inputs;
  await f.recall();
  assert.equal(f.calls.filter(c => c[0] === "rpc").length, 0);
  assert.equal(f.calls.filter(c => c[0] === "load").length, 1);
  assert.equal(f.calls.filter(c => c[0] === "restore" || c[0] === "prepend").length, 0);
  assert(f.calls.some(c => c[0] === "notice"));
});

test("successful video Recall restores native returned text/image bytes, not the saved client summary", async () => {
  const old = { steering: [{ text: "Old client text", images: [{ ...png, data: Buffer.from("old-bytes").toString("base64") }], video }], followUp: [] };
  const f = fixture(old, native); await f.recall();
  assert.deepEqual(f.calls.find(c => c[0] === "restore"), ["restore", "Native video question", [{ ...draftPng, previewUrl: "" }], "fixture", video]);
  assert.equal(f.context.submittedDraftRef.current, null);
});

test("a successful response is classified by native inputs even when the client summary was plain", async () => {
  // Response contract test; the actual SDK stale-queue tests separately prove
  // the precondition refuses unseen media before clear, even with ACK loss.
  const f = fixture(plain, native); await f.recall();
  assert.deepEqual(f.calls.find(c => c[0] === "restore"), ["restore", "Native video question", [{ ...draftPng, previewUrl: "" }], "fixture", video]);
  assert.equal(f.calls.filter(c => c[0] === "prepend").length, 0);
});

test("native video response plus a now-occupied plain composer keeps full recalled input separately", async () => {
  const f = fixture(plain, native, true); await f.recall();
  assert.equal(f.calls.filter(c => c[0] === "restore" || c[0] === "prepend").length, 0);
  const saved = f.context.submittedDraftRef.current;
  assert.equal(saved.unknown, true); assert.equal(saved.recallVideoId, video.id);
  assert.deepEqual(copy(saved.draft), { value: "Native video question", images: [{ data: png.data, mimeType: png.mimeType }], video });
  assert.equal(f.calls.filter(c => c[0] === "saved").length, 1);
});

const imageOnly = { steering: [{ text: "Native PNG question", images: [png] }], followUp: [] };
test("busy PNG-only Recall restores actual returned text and image bytes via the existing draft interface", async () => {
  const old = { steering: [{ text: "Old PNG text", images: [{ ...png, data: Buffer.from("old PNG").toString("base64") }] }], followUp: [] };
  const f = fixture(old, imageOnly); f.context.agentRunningRef.current = true;
  await f.recall();
  assert.deepEqual(f.calls.find(c => c[0] === "rpc")[2].recallInputs, old);
  assert.deepEqual(f.calls.find(c => c[0] === "restore"), ["restore", "Native PNG question", [{ ...draftPng, previewUrl: "" }], "fixture", null]);
  assert.equal(f.calls.filter(c => c[0] === "prepend").length, 0);
  assert.equal(f.context.submittedDraftRef.current, null);
});

test("a locally plain success still restores a PNG-only native result", async () => {
  const f = fixture(plain, imageOnly); await f.recall();
  assert.deepEqual(f.calls.find(c => c[0] === "restore"), ["restore", "Native PNG question", [{ ...draftPng, previewUrl: "" }], "fixture", null]);
});

test("PNG-only Recall can merge with an occupied composer when its images fit, without an empty-composer gate", async () => {
  const f = fixture(imageOnly, imageOnly, true); await f.recall();
  assert.equal(f.calls.filter(c => c[0] === "restore").length, 1);
  assert.equal(f.calls.filter(c => c[0] === "saved").length, 0);
});

test("Recall refuses before clear if the full native image set cannot fit the composer", async () => {
  const f = fixture(imageOnly); f.context.opts.chatInputRef.current.canRestoreImages = () => false;
  await f.recall();
  assert.equal(f.calls.filter(c => c[0] === "rpc" || c[0] === "restore").length, 0);
  assert(f.calls.some(c => c[0] === "notice"));
});

test("Recall refuses an over-capacity queued image set before destructive clear", async () => {
  const f = fixture({ steering: [{ text: "Many PNGs", images: Array(MAX_ATTACHED_IMAGES + 1).fill(png) }], followUp: [] });
  await f.recall();
  assert.equal(f.calls.filter(c => c[0] === "rpc" || c[0] === "restore").length, 0);
  assert(f.calls.some(c => c[0] === "notice"));
});

test("the actual composer capacity reader includes attached images and pending file reads", () => {
  const input = ts.createSourceFile("ChatInput.tsx", readFileSync(new URL("../components/ChatInput.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function find(node) {
    if (ts.isMethodDeclaration(node) && node.name.getText(input) === "canRestoreImages") return node;
    return ts.forEachChild(node, find);
  }
  const method = find(input); assert.ok(method);
  const context = { MAX_ATTACHED_IMAGES, attachedImagesRef: { current: Array(8) }, pendingImageCountRef: { current: 1 } };
  const canRestore = new Script(ts.transpileModule(`({${method.getText(input)}}).canRestoreImages`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText).runInNewContext(context);
  assert.equal(canRestore(1), true); assert.equal(canRestore(2), false);
  context.pendingImageCountRef.current = 0; assert.equal(canRestore(2), true);
});

test("PNG-only native success that no longer fits preserves all bytes in the existing single slot", async () => {
  const f = fixture(plain, imageOnly, true); f.context.opts.chatInputRef.current.canRestoreImages = () => false;
  await f.recall();
  assert.equal(f.calls.filter(c => c[0] === "restore" || c[0] === "prepend").length, 0);
  const saved = f.context.submittedDraftRef.current;
  assert.equal(saved.unknown, true);
  assert.deepEqual(copy(saved.draft), { value: "Native PNG question", images: [draftPng] });
  assert.equal(f.calls.filter(c => c[0] === "saved").length, 1);
});
