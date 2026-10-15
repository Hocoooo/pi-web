import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { createJiti } from "jiti";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url);
const draftStore = await jiti.import("../lib/draft-store.ts");

function callbackBody(name, nextName) {
  const start = source.indexOf(`const ${name} = useCallback`);
  const end = source.indexOf(`\n  const ${nextName}`, start);
  assert.notEqual(start, -1, `${name} callback not found`);
  assert.notEqual(end, -1, `${nextName} callback not found after ${name}`);
  return source.slice(start, end);
}

test("explicit context changes invalidate a pending workspace restore", () => {
  const callbacks = [
    ["handleCwdChange", "handleSelectSession"],
    ["handleSelectSession", "handleNewSession"],
    ["handleNewSession", "handleNewSessionProjectChange"],
    ["handleSessionCreated", "handleAgentEnd"],
    ["handleSessionForked", "handleInitialRestoreDone"],
    ["handleSessionDeleted", "handleOpenFile"],
  ];

  for (const [name, nextName] of callbacks) {
    assert.match(callbackBody(name, nextName), /invalidateWorkspaceRestore\(\);/);
  }
});

test("all active-session transitions share one persistence effect", () => {
  assert.match(
    source,
    /useEffect\(\(\) => \{\s+if \(selectedSession\) \{[\s\S]*?setLastOpenSession\(projectKey, selectedSession\.id\);\s+setTabOpenSession\(selectedSession\.id\);\s+return;\s+\}\s+if \(newSessionCwd\) setTabOpenNewSession\(newSessionCwd\);\s+\}, \[newSessionCwd, selectedSession\]\);/,
  );
});

test("keeps chat scroll positions in page memory by session id", () => {
  assert.match(source, /useRef\(new Map<string, ChatScrollPosition>\(\)\)/);
  assert.match(source, /sessionScrollPositionsRef\.current\.set\(sessionId, position\)/);
  assert.match(source, /initialScrollPosition=\{selectedSession \? sessionScrollPositionsRef\.current\.get\(selectedSession\.id\) \?\? null : null\}/);
  assert.match(source, /onScrollPositionChange=\{handleSessionScrollPositionChange\}/);
  assert.doesNotMatch(source, /localStorage[^\n]*sessionScroll/i);
});

test("workspace restoration remains inside the cross-project branch", () => {
  assert.match(
    callbackBody("handleCwdChange", "handleSelectSession"),
    /if \(currentProject !== newProject\) \{[\s\S]*?restoreWorkspaceContext\(newProject, cwd\);[\s\S]*?\}/,
  );
});

test("dashboard departure parks only the active composer, never merges an older /new cwd draft", () => {
  const callback = callbackBody("handleNavigateTasks", "restoreWorkspaceContext");
  for (const active of [{ value: "", images: [] }, { value: "active text", images: [{ data: "active-image", mimeType: "image/png" }] }]) {
    const cwd = "/dashboard-project";
    const key = `new:dashboard-${active.value ? "text" : "empty"}:${cwd}`;
    const oldKey = `parked-new:${cwd}`;
    const old = { value: "older deliberately unadopted draft", images: [{ data: "old-image", mimeType: "image/png" }] };
    draftStore.setDraft(oldKey, old);
    draftStore.setDraft(key, active);
    let memory;
    const context = vm.createContext({
      ...draftStore, useCallback: (fn) => fn, useLayoutEffect() {}, invalidateWorkspaceRestore() {},
      activeNewSessionDraftKeyRef: { current: key }, selectedSession: null, newSessionCwd: cwd,
      setTabOpenNewSession: (directory, _storage, parkedDraftKey) => { memory = { cwd: directory, parkedDraftKey }; },
    });
    vm.runInContext(stripTypeScriptTypes(`${callback}\nhandleNavigateTasks();`), context);
    assert.equal(memory.cwd, cwd);
    assert.equal(memory.parkedDraftKey, `parked-new:${key}`);
    assert.deepEqual(draftStore.getDraft(oldKey), old, "ordinary New's unadopted draft stays separate");
    assert.deepEqual(draftStore.getDraft(memory.parkedDraftKey), active.value ? active : null);
    draftStore.clearDraft(oldKey);
    draftStore.clearDraft(memory.parkedDraftKey);
  }
});

test("actual departure cleanup parks only for /tasks, never during mount or ordinary navigation", () => {
  assert.doesNotMatch(source, /onNavigateTasks=/, "no eager Link callback may snapshot an editable composer");
  const start = source.indexOf("  // Save only on actual /tasks departure");
  const end = source.indexOf("  // Restore the workspace's last open session", start);
  assert.ok(start >= 0 && end > start);
  let cleanup, parked = 0;
  const window = { location: { pathname: "/" } };
  const context = vm.createContext({ window, handleNavigateTasks: () => parked++, useLayoutEffect: (effect) => { cleanup = effect(); } });
  vm.runInContext(stripTypeScriptTypes(source.slice(start, end)), context);
  assert.equal(parked, 0, "mount does not park an active draft");
  cleanup();
  assert.equal(parked, 0, "ordinary session/project history keeps normal abandonment cleanup");
  window.location.pathname = "/tasks";
  cleanup();
  assert.equal(parked, 1, "dashboard departure parks before passive draft cleanup");
});

test("task panel navigation only opens existing sessions and rejects suspended preparation without sending", async () => {
  const calls = [];
  const context = vm.createContext({
    URL, window: { location: { origin: "http://localhost" } },
    useCallback: callback => callback,
    fetch: async () => ({ ok: true, json: async () => ({ info: { id: "linked", cwd: "/chat" } }) }),
    handleSelectSession: (...args) => calls.push(["select", ...args]),
    handleNewSession: (...args) => calls.push(["new", ...args]),
    closeTasks: () => calls.push(["close"]),
    activeNewSessionDraftKeyRef: { current: "draft" },
    taskNavigationIntentRef: { current: 0 }, workspaceRestoreTokenRef: { current: 0 },
    newSessionCwd: "/chat", activeCwd: "/chat", chatWorkspaceCwd: "/chat", selectedSession: null,
    rekeyDraft: (...args) => calls.push(["park", ...args]),
    parkedNewSessionDraftKey: cwd => `parked:${cwd}`,
  });
  vm.runInContext(stripTypeScriptTypes(`${callbackBody("navigateTaskChat", "handleNewChat")} globalThis.navigate = navigateTaskChat;`), context);
  await context.navigate("/?session=linked");
  assert.equal(calls[0][0], "select");
  assert.equal(calls[0][1].id, "linked");
  assert.equal(calls[0].length, 2, "navigation supplies no task execution metadata");
  assert.deepEqual(calls[1], ["close"]);
  calls.length = 0;
  for (const href of ["/?cwd=%2Fchat&taskStart=new-preview", "/?session=linked&taskStart=prepared", "/?session=linked&taskStart=", "/?cwd=%2Fchat"]) {
    await assert.rejects(context.navigate(href), /only opens existing conversations/);
    assert.deepEqual(calls, [], "old preparation does not create, select, park drafts or close panel");
  }
  context.fetch = async () => ({ ok: false, json: async () => ({ error: "Missing session" }) });
  await assert.rejects(context.navigate("/?session=missing"), /Missing session/);
  assert.deepEqual(calls, [], "failure keeps panel and current chat intact");
  const first = Promise.withResolvers(), second = Promise.withResolvers();
  context.fetch = href => href.endsWith("first") ? first.promise : second.promise;
  const firstNavigation = context.navigate("/?session=first");
  const secondNavigation = context.navigate("/?session=second");
  second.resolve({ ok: true, json: async () => ({ info: { id: "second", cwd: "/chat" } }) });
  await secondNavigation;
  first.resolve({ ok: true, json: async () => ({ info: { id: "first", cwd: "/chat" } }) });
  await firstNavigation;
  assert.equal(calls.filter(call => call[0] === "select").length, 1);
  assert.equal(calls[0][1].id, "second", "latest navigation wins");
  calls.length = 0;
  const dismissed = Promise.withResolvers();
  context.fetch = () => dismissed.promise;
  const dismissedNavigation = context.navigate("/?session=dismissed");
  context.taskNavigationIntentRef.current++;
  dismissed.resolve({ ok: true, json: async () => ({ info: { id: "dismissed", cwd: "/chat" } }) });
  await dismissedNavigation;
  assert.deepEqual(calls, [], "dismissed navigation never selects an old target");
});

test("New restores the draft after session navigation and workspace auto-restore", async (t) => {
  const callbacks = [
    callbackBody("restoreWorkspaceContext", "handleCwdChange"),
    callbackBody("handleCwdChange", "handleSelectSession"),
    callbackBody("handleSelectSession", "handleNewSession"),
    callbackBody("handleNewSession", "handleNewSessionProjectChange"),
  ].join("\n");
  const parkedKeyHelper = source.slice(source.indexOf("function parkedNewSessionDraftKey"), source.indexOf("export function AppShell"));
  const hookSource = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
  const cleanupStart = hookSource.indexOf("    return () => {", hookSource.indexOf("  // Load session on mount"));
  const cleanupEnd = hookSource.indexOf("    // eslint-disable-next-line", cleanupStart);

  for (const rememberedCwd of ["/draft-project", "/draft-project-worktree"]) {
    await t.test(`remembered session cwd: ${rememberedCwd}`, async () => {
      const cwd = "/draft-project";
      const session = { id: "remembered", cwd: rememberedCwd, projectKey: cwd };
      const response = Promise.withResolvers();
      const context = vm.createContext({
        ...draftStore,
        crypto: globalThis.crypto,
        queueMicrotask,
        URLSearchParams,
        window: { location: { pathname: "/", search: "" } },
        router: { replace() {} },
        fetch: () => response.promise,
        getLastOpenSession: (key) => key === cwd ? session.id : null,
        clearLastOpen() {},
        workspaceKeyOf: (value) => value.projectKey ?? value.cwd,
        useCallback: (callback) => callback,
        useGlobalKeyboardShortcuts() {},
        closeTasks() {},
        chatNavigationIntentRef: { current: 0 },
        activeNewSessionDraftKeyRef: { current: `new:initial:${cwd}` },
        activeProjectKeyRef: { current: cwd },
        workspaceRestoreTokenRef: { current: 0 },
        suppressCwdBumpRef: { current: false },
        branchLeafChangeFnRef: { current: null },
        liveFollowFrameRef: { current: null },
        bashRecoveryIdRef: { current: 0 },
        cancelEventStreamGrace() {},
        closeEvents() {},
        isMobile: false,
        chatWorkspaceCwd: null,
        CHAT_WORKSPACE_KEY: "pi-web:chat",
        activeCwd: cwd,
        activeFileTabId: null,
        newSessionCwd: cwd,
        newSessionDraftId: "initial",
        selectedSession: null,
        sessionCatalog: [],
        sessionKey: 0,
      });
      context.invalidateWorkspaceRestore = () => context.workspaceRestoreTokenRef.current++;
      for (const [setter] of callbacks.matchAll(/\bset[A-Z]\w*(?=\()/g)) {
        const state = setter[3].toLowerCase() + setter.slice(4);
        context[setter] = (value) => {
          context[state] = typeof value === "function" ? value(context[state]) : value;
        };
      }
      vm.runInContext(stripTypeScriptTypes(`${parkedKeyHelper}\n${callbacks}
        globalThis.navigate = { handleCwdChange, handleSelectSession, handleNewSession };
      `), context);
      // Run the actual hook cleanup with the outgoing mount's captured draft key.
      const makeCleanup = vm.runInContext(stripTypeScriptTypes(`((isNew, newSessionDraftKey) => {
        const sessionHookMountedRef = { current: true };
        const newSessionPromotedRef = { current: false };
        const sessionIdRef = { current: null };
        const dataRef = { current: null };
        const messagesRef = { current: [] };
        const entryIdsRef = { current: [] };
        const activeLeafIdRef = { current: null };
        const historyCursorRef = { current: null };
        const hasEarlierMessagesRef = { current: false };
        const getSessionViewSnapshot = () => null;
        const setSessionViewSnapshot = () => false;
        const deleteSessionViewSnapshot = () => {};
        ${hookSource.slice(cleanupStart, cleanupEnd)}
      })`), context);
      let mountedKey = context.sessionKey;
      let cleanup = makeCleanup(true, context.activeNewSessionDraftKeyRef.current);
      async function commit() {
        if (mountedKey !== context.sessionKey) {
          cleanup();
          mountedKey = context.sessionKey;
          const activeCwd = context.newSessionCwd ?? context.activeCwd;
          const key = context.selectedSession ? null : `new:${context.newSessionDraftId}:${activeCwd}`;
          context.activeNewSessionDraftKeyRef.current = key;
          cleanup = makeCleanup(!context.selectedSession, key);
        }
        await new Promise((resolve) => setImmediate(resolve));
      }

      const draft = { value: "unsent project draft", images: [{ data: "aGVsbG8=", mimeType: "image/png" }] };
      draftStore.setDraft(context.activeNewSessionDraftKeyRef.current, draft);
      context.navigate.handleSelectSession({ ...session, cwd });
      await commit();
      context.navigate.handleNewSession("direct-return", cwd);
      await commit();
      assert.deepEqual(draftStore.getDraft(context.activeNewSessionDraftKeyRef.current), draft);
      context.navigate.handleSelectSession({ ...session, cwd });
      await commit();
      context.navigate.handleCwdChange("/other-project", "/other-project", "/other-project");
      await commit();
      context.navigate.handleCwdChange(cwd, cwd, cwd);
      await commit();
      assert.deepEqual(draftStore.getDraft(context.activeNewSessionDraftKeyRef.current), draft);
      response.resolve({ ok: true, json: async () => ({ sessions: [session] }) });
      await new Promise((resolve) => setImmediate(resolve));
      await commit();
      assert.equal(context.selectedSession.id, session.id);
      context.navigate.handleNewSession("after-auto-restore", cwd);
      await commit();
      assert.deepEqual(draftStore.getDraft(context.activeNewSessionDraftKeyRef.current), draft);
      draftStore.clearDraft(context.activeNewSessionDraftKeyRef.current);
    });
  }
});
