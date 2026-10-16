import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Script } from "node:vm";
import { createJiti } from "jiti";
import ts from "typescript";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { canRunBuiltinSlashCommandWhileStreaming, offersBuiltinSlashCommandWhileStreaming } = await jiti.import("./ChatInput.tsx");
const { isBareMcpCommand } = await jiti.import("@/lib/mcp-command");
const { isSettingsSlashCommand } = await jiti.import("@/lib/model-command");
const inputText = readFileSync(new URL("./ChatInput.tsx", import.meta.url), "utf8");
const shellText = readFileSync(new URL("./AppShell.tsx", import.meta.url), "utf8");

function callback(text, name, context) {
  const source = ts.createSourceFile("component.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function find(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) return node.initializer.arguments[0];
    return ts.forEachChild(node, find);
  }
  const node = find(source);
  assert.ok(node, `${name} callback exists`);
  return new Script(ts.transpileModule(`(${node.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText).runInNewContext(context);
}

function composer(value, isStreaming, attachedImages = []) {
  const actions = [];
  const context = {
    value, isStreaming, attachedImages, cwd: "/current-session-worktree",
    videos: undefined, videoBlocked: false, videoBlockedRef: { current: false }, videoSendError: null, restoringSubmission: false,
    onAudioUnlock() {},
    onNewSession: (...args) => actions.push(["new", ...args]),
    onBuiltinCommand: async (msg) => { actions.push(["builtin", msg]); return { handled: false }; },
    builtinCommandPendingRef: { current: false }, sendPendingRef: { current: false },
    setBuiltinCommandPending() {},
    clearInput: () => actions.push(["clear"]),
    onSend: (...args) => actions.push(["send", ...args]),
    onPromptWithStreamingBehavior: (...args) => actions.push(["queue", ...args]),
    canRunBuiltinSlashCommandWhileStreaming, offersBuiltinSlashCommandWhileStreaming, isBareMcpCommand, isSettingsSlashCommand,
  };
  context.runBuiltinCommand = callback(inputText, "runBuiltinCommand", context);
  return {
    actions, context,
    send: callback(inputText, "handleSend", context),
    queue: callback(inputText, "sendQueued", context),
  };
}

test("Recall/restore pending never dispatches, clears or queues another composer input", async () => {
  for (const streaming of [false, true]) {
    const input = composer("Keep the current input", streaming, [{ data: "png", mimeType: "image/png" }]);
    input.context.restoringSubmission = true;
    await input.send(); await input.queue("steer"); await input.queue("followup");
    assert.deepEqual(input.actions, []);
  }
});

test("a synchronous pending-video ref blocks Send and queues before React state catches up", async () => {
  const input = composer("Question", false);
  input.context.videoBlockedRef.current = true;
  await input.send(); await input.queue("steer"); await input.queue("followup");
  assert.deepEqual(input.actions, []);
});

test("standalone /new clears the source draft and opens a blank session without sending", async () => {
  for (const value of ["/new", "  /new \n"]) {
    for (const images of [[], [{ data: "image", mimeType: "image/png" }]]) {
      for (const streaming of [false, true]) {
        const input = composer(value, streaming, images);
        await input.send();
        assert.deepEqual(input.actions, [["clear"], ["new", "/current-session-worktree"]]);
      }
    }
  }
});

test("streaming steer and follow-up paths navigate instead of queuing /new", () => {
  for (const mode of ["steer", "followup"]) {
    for (const images of [[], [{ data: "image", mimeType: "image/png" }]]) {
      const input = composer(" /new ", true, images);
      input.queue(mode);
      assert.deepEqual(input.actions, [["clear"], ["new", "/current-session-worktree"]]);
    }
  }
});

test("/new prefixes and arguments do not trigger new-session navigation", async () => {
  for (const value of ["/newfoo", "/new explain this", "/new\nexplain this"]) {
    const input = composer(value, false);
    await input.send();
    assert.deepEqual(input.actions, [["builtin", value], ["clear"], ["send", value, undefined]]);
    assert.equal(canRunBuiltinSlashCommandWhileStreaming(value), false);
    const streaming = composer(value, true);
    streaming.queue("followup");
    assert.deepEqual(streaming.actions, [["clear"], ["queue", value, "followUp", undefined]]);
  }
});

test("repeated ordinary Send during command dispatch submits and clears the video draft once", async () => {
  const images = [{ data: "original-image-bytes", mimeType: "image/png" }];
  const videos = [
    { version: 1, path: "/current-session-worktree/clip.avi", mimeType: "video/avi" },
    { version: 1, path: "/current-session-worktree/second.mp4", mimeType: "video/mp4" },
  ];
  const input = composer("Keep my question", false, images);
  input.context.videos = videos;
  const dispatch = Promise.withResolvers();
  input.context.runBuiltinCommand = () => dispatch.promise;
  const first = input.send();
  const second = input.send();
  assert.deepEqual(input.actions, [], "input is not cleared while dispatch is pending");
  dispatch.resolve(false);
  await Promise.all([first, second]);
  assert.deepEqual(input.actions, [["clear"], ["send", "Keep my question", images, videos]]);
  assert.equal(input.context.sendPendingRef.current, false);
});

test("a handled or failed command releases the local Send guard for the next explicit attempt", async () => {
  const input = composer("Question", false);
  input.context.runBuiltinCommand = async () => { throw new Error("dispatch failed"); };
  await assert.rejects(input.send(), /dispatch failed/);
  assert.equal(input.context.sendPendingRef.current, false);
  input.context.runBuiltinCommand = async () => true;
  await input.send();
  assert.deepEqual(input.actions, []);
  assert.equal(input.context.sendPendingRef.current, false);
  input.context.runBuiltinCommand = async () => false;
  await input.send();
  assert.deepEqual(input.actions, [["clear"], ["send", "Question", undefined]]);
});

test("/new is discoverable and available during streaming", () => {
  assert.match(inputText, /name: "new", description: "chat.commandNew", source: "builtin", availableWhileStreaming: true/);
  assert.equal(canRunBuiltinSlashCommandWhileStreaming(" /new \n"), true);
});

test("changing a blank session project updates its reload URL and carries the draft", () => {
  const state = {};
  const migrations = [];
  const context = {
    invalidateWorkspaceRestore() {},
    crypto: { randomUUID: () => "new-project" },
    rekeyDraft: (...args) => migrations.push(args),
    chatNavigationIntentRef: { current: 0 },
    activeNewSessionDraftKeyRef: { current: "new:old:/old-project" },
    activeProjectKeyRef: { current: "/old-project" },
    selectedSession: null, newSessionCwd: "/old-project", activeCwd: "/old-project",
    CHAT_WORKSPACE_KEY: "pi-web:chat",
    router: { replace: (url) => { state.route = url; } },
  };
  for (const [setter] of shellText.matchAll(/\bset[A-Z]\w*(?=\()/g)) {
    context[setter] = (value) => { state[setter] = value; };
  }
  callback(shellText, "handleNewSessionProjectChange", context)("/new-project/worktree", "/new-project");
  assert.equal(state.route, "?cwd=%2Fnew-project%2Fworktree");
  assert.equal(state.setNewSessionCwd, "/new-project/worktree");
  assert.equal(context.activeProjectKeyRef.current, "/new-project");
  assert.deepEqual(migrations, [["new:old:/old-project", "new:new-project:/new-project/worktree"]]);
});

test("new-session navigation reuses AppShell and can leave parked drafts untouched", () => {
  for (const restoreParkedDraft of [false, undefined]) {
    const state = {};
    const migrations = [];
    const context = {
      invalidateWorkspaceRestore() {},
      parkedNewSessionDraftKey: (cwd) => `parked:${cwd}`,
      rekeyDraft: (...args) => migrations.push(args),
      chatNavigationIntentRef: { current: 0 },
      activeNewSessionDraftKeyRef: { current: null },
      isMobile: false,
      chatWorkspaceCwd: null,
      router: { replace: (...args) => { state.route = args[0]; } },
    };
    for (const [setter] of shellText.matchAll(/\bset[A-Z]\w*(?=\()/g)) {
      context[setter] = (value) => { state[setter] = value; };
    }
    const open = callback(shellText, "handleNewSession", context);
    open("fresh-id", "/current-session-worktree", restoreParkedDraft);
    assert.equal(state.setSelectedSession, null);
    assert.equal(state.setNewSessionCwd, "/current-session-worktree");
    assert.equal(state.setNewSessionDraftId, "fresh-id");
    assert.equal(context.activeNewSessionDraftKeyRef.current, "new:fresh-id:/current-session-worktree");
    assert.equal(state.route, "?cwd=%2Fcurrent-session-worktree");
    assert.equal(migrations.length, restoreParkedDraft === false ? 0 : 1);
  }
  // Verify the command uses the displayed session's cwd, not the sidebar selection,
  // and opts out of restoring unrelated parked composer text.
  const windowText = readFileSync(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  assert.match(windowText, /onNewSession=\{onNewSession \? handleNewSession : undefined\}/);
  assert.match(windowText, /cwd=\{session\?\.cwd \?\? newSessionCwd\}/);
  assert.match(shellText, /onNewSession=\{handleNewSessionCommand\}/);
  assert.match(windowText, /if \(!isNew \|\| loading\) return;[\s\S]*?composerRef\.current\?\.focusComposer\(\)/);
});
