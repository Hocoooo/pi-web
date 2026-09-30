import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { chatWorkspaceCwd, isChatWorkspace } = await jiti.import("./chat-workspace.ts");
const { getInitialNavigation, withTabOpen } = await jiti.import("./initial-navigation.ts");
const { getRecentProjects, sessionsForProject } = await jiti.import("./project-groups.ts");
const { buildSidebarProjectRows } = await jiti.import("./sidebar-project-rows.ts");
const { workspaceKeyOf } = await jiti.import("./workspace-memory.ts");

const chatSession = (id, modified) => ({
  id, cwd: "/agent/chat-workspace", sessionKind: "chat", projectKey: "pi-web:chat", projectRoot: "/agent/chat-workspace",
  path: `/sessions/${id}.jsonl`, created: modified, modified, messageCount: 2, firstMessage: id,
});

test("the exact reserved workspace is stable and never inferred from a basename or descendant", () => {
  assert.equal(chatWorkspaceCwd("/agent"), join("/agent", "chat-workspace"));
  assert.equal(isChatWorkspace(join("/agent", "chat-workspace"), "/agent"), true);
  assert.equal(isChatWorkspace("/project/chat-workspace", "/agent"), false);
  assert.equal(isChatWorkspace("/agent/chat-workspace/nested", "/agent"), false);
  assert.equal(isChatWorkspace("/agent/pi-cwd-20260901", "/agent"), false);
});

test("independent chat keeps normal session permissions instead of a Chat-only policy", () => {
  const rpcManager = readFileSync(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  assert.doesNotMatch(rpcManager, /only support Chat only/);
  assert.doesNotMatch(rpcManager, /Shell commands are not available in independent chats/);
  assert.doesNotMatch(rpcManager, /globalChatContextFiles/);
});

test("chat URLs override tab memory and do not expose the managed path", () => {
  const navigation = getInitialNavigation(new URLSearchParams("chat=1&session=old"));
  assert.equal(navigation.requestedChat, true);
  assert.equal(navigation.sessionId, null);
  assert.equal(navigation.requestedCwd, null);
  assert.equal(withTabOpen(navigation, { kind: "session", sessionId: "old" }), navigation);
});

test("chats share one identity and are listed as an ordinary project with the same preview limit", () => {
  const chats = Array.from({ length: 7 }, (_, index) => chatSession(`chat-${index}`, `2026-09-${String(index + 1).padStart(2, "0")}T00:00:00Z`));
  const project = { ...chatSession("project", "2026-09-20T00:00:00Z"), sessionKind: "project", cwd: "/project", projectRoot: "/project", projectKey: "project" };
  const sessions = [...chats, project];
  assert.equal(workspaceKeyOf(chats[0]), "pi-web:chat");
  assert.deepEqual(getRecentProjects(sessions), [
    { key: "project", root: "/project" },
    { key: "pi-web:chat", root: "/agent/chat-workspace" },
  ]);
  assert.equal(sessionsForProject(sessions, "pi-web:chat").length, 7);
  const rows = buildSidebarProjectRows(sessions, [], null);
  const chatProjects = rows.filter((row) => row.kind === "project" && row.project.key === "pi-web:chat");
  assert.equal(chatProjects.length, 1);
  assert.equal(chatProjects[0].project.root, "/agent/chat-workspace");
  assert.equal(rows.filter((row) => row.kind === "session" && row.family.root.sessionKind === "chat").length, 5);
  const more = rows.find((row) => row.kind === "more" && row.project.key === "pi-web:chat");
  assert.ok(more);
  assert.equal(more.remaining, 2);
  assert.equal(buildSidebarProjectRows(sessions, [], null, ["pi-web:chat"]).filter((row) => row.kind === "session" && row.family.root.sessionKind === "chat").length, 7);
  assert.equal(buildSidebarProjectRows(sessions, ["pi-web:chat"], null).filter((row) => row.kind === "session").length, 1);
});

test("real SDK creation, persistence and reopen keep the chat identity with normal session permissions", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-independent-chat-"));
  const agentDir = join(root, "agent");
  const cwd = chatWorkspaceCwd(agentDir);
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "AGENTS.md"), "GLOBAL_CHAT_INSTRUCTIONS");
  const previous = { agentDir: process.env.PI_CODING_AGENT_DIR, offline: process.env.PI_OFFLINE };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_OFFLINE = "1";
  const { POST } = await jiti.import("../app/api/default-cwd/route.ts");
  const { startRpcSession, setRpcSessionTools } = await jiti.import("./rpc-manager.ts");
  const { attachSessionProjectInfo, listAllSessions, invalidateSessionListCache } = await jiti.import("./session-reader.ts");
  let wrapper;
  t.after(async () => {
    await wrapper?.shutdown();
    if (previous.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous.agentDir;
    if (previous.offline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previous.offline;
    invalidateSessionListCache();
    rmSync(root, { recursive: true, force: true });
  });

  const first = await (await POST()).json();
  writeFileSync(join(cwd, "sentinel"), "not recreated");
  const second = await (await POST()).json();
  assert.deepEqual(first, second);
  assert.equal(first.cwd, cwd);
  assert.equal(first.sessionKind, "chat");
  assert.equal(readFileSync(join(cwd, "sentinel"), "utf8"), "not recreated");

  const started = await startRpcSession("__independent_chat_test__", "", cwd);
  wrapper = started.session;
  assert.ok(wrapper.inner.getActiveToolNames().length > 0, "chat keeps the normal default tool loadout");
  await setRpcSessionTools(started.realSessionId, undefined, ["read"]);
  assert.deepEqual(wrapper.inner.getActiveToolNames(), ["read"]);
  await wrapper.send({ type: "reload" });
  assert.deepEqual(wrapper.inner.getActiveToolNames(), ["read"]);

  // Synthetic finalized messages exercise actual JSONL persistence, not a model request.
  wrapper.inner.sessionManager.appendMessage({ role: "user", content: "yesterday", timestamp: Date.parse("2026-09-01T00:00:00Z") });
  wrapper.inner.sessionManager.appendMessage({
    role: "assistant", content: [{ type: "text", text: "recorded reply" }], api: "openai-completions", provider: "openai", model: "fixture",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: Date.parse("2026-09-01T00:00:01Z"),
  });
  const file = wrapper.inner.sessionManager.getSessionFile();
  assert.equal(existsSync(file), true);
  await wrapper.shutdown();
  wrapper = (await startRpcSession(started.realSessionId, file, undefined)).session;
  assert.deepEqual(wrapper.inner.getActiveToolNames(), ["read"]);
  const decorated = await attachSessionProjectInfo([chatSession(started.realSessionId, "2026-09-01T00:00:00Z"), { ...chatSession("real", "2026-09-01T00:00:00Z"), cwd }]);
  assert.equal(decorated[1].sessionKind, "chat");
  assert.equal(decorated[1].projectKey, "pi-web:chat");
  invalidateSessionListCache();
  const listed = (await listAllSessions({ force: true })).find((session) => session.id === started.realSessionId);
  assert.equal(listed.sessionKind, "chat");
  assert.equal(listed.cwd, cwd);
});
