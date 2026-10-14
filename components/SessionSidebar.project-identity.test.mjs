import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const customPathStart = source.indexOf("const commitCustomPath = useCallback");
const customPathEnd = source.indexOf("const handleCustomPathClick", customPathStart);
const customPathSource = source.slice(customPathStart, customPathEnd);

function resolveProject(cwd, worktreeState, allSessions = []) {
  const start = source.indexOf("const projectFor = useCallback");
  const end = source.indexOf("\n  // A worktree/session refresh", start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({
    useCallback: (fn) => fn, validatedProject: null, chatCwd: null,
    worktreeState, allSessions, cwd,
    projectSelection: (root, key) => ({ root, key }),
    workspaceKeyOf: (session) => session.projectKey ?? session.projectRoot ?? session.cwd,
  });
  vm.runInContext(stripTypeScriptTypes(`${source.slice(start, end)}\nglobalThis.result = projectFor(cwd);`), context);
  return context.result;
}

for (const root of ["/fixtures/repo", "E:\\fixtures\\repo"]) {
  test(`subdirectory worktree cache cannot reassign the containing repo: ${root}`, () => {
    const nested = `${root}/benchmark-runs/case-01`;
    const state = { forCwd: nested, projectRoot: nested, projectKey: "nested", isTopLevel: false,
      worktrees: [{ path: root }] };
    assert.deepEqual(resolveProject(root, state, [{ cwd: root, projectRoot: root, projectKey: "repo" }]),
      { root, key: "repo" });
    assert.deepEqual(resolveProject(nested, state), { root: nested, key: "nested" },
      "the exact subdirectory retains its server identity");
    assert.deepEqual(resolveProject(root, state), { root, key: root },
      "even without a session, do not borrow the nested identity");
  });
}

test("a top-level worktree cache still resolves siblings without sessions", () => {
  const state = { forCwd: "/repo", projectRoot: "/repo", projectKey: "repo", isTopLevel: true,
    worktrees: [{ path: "/repo" }, { path: "/repo-feature" }] };
  assert.deepEqual(resolveProject("/repo-feature", state), { root: "/repo", key: "repo" });
});

test("custom cwd selection installs validated identity before changing cwd", () => {
  assert.notEqual(customPathStart, -1);
  assert.notEqual(customPathEnd, -1);
  assert.match(customPathSource, /projectRoot\?: string;[\s\S]*?projectKey\?: string;/);

  const identityUpdate = customPathSource.indexOf("setValidatedProject(");
  const cwdUpdate = customPathSource.indexOf("setSelectedCwd(");
  assert.ok(identityUpdate >= 0, "validated project identity is retained");
  assert.ok(cwdUpdate > identityUpdate, "identity is retained before cwd changes");
});

test("custom cwd selection remembers the last validated path for the picker", () => {
  assert.match(customPathSource, /saveLastCustomCwd\(data\.cwd\)/);
  assert.match(source, /initialPath=\{customPathValue\}/);
});

test("independent chat replaces the dated-directory shortcut without changing custom validation", async () => {
  assert.doesNotMatch(source, /const handleDefaultCwd = useCallback/);
  const route = await readFile(new URL("../app/api/default-cwd/route.ts", import.meta.url), "utf8");
  assert.match(route, /chatWorkspaceCwd\(getAgentDir\(\)\)/);
  assert.match(route, /allowFileRoot\(dir\)/);
  assert.match(route, /projectKey: CHAT_WORKSPACE_KEY, sessionKind: "chat"/);
  assert.match(customPathSource, /if \(remember\) \{\s*saveLastCustomCwd\(data\.cwd\)/);
});
