import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { subagentVideoToolExtensions, withVideoToolPrecedence } = await createJiti(import.meta.url).import("./video-tools.ts");
const hostPath = "<inline:pi-web-video-tools>";
const host = { path: hostPath, tools: new Map([["read_video", {}]]) };
const user = { path: "/agent/extensions/custom-video.ts", tools: new Map([["read_video", {}]]) };
const conflict = { path: hostPath, error: `Tool "read_video" conflicts with ${user.path}` };
const unrelated = { path: "/agent/extensions/other.ts", error: "Unrelated failure" };

test("subagent video factory requires an explicit host tool grant and is not SDK replaceable", () => {
  assert.deepEqual(subagentVideoToolExtensions([]), []);
  assert.deepEqual(subagentVideoToolExtensions(["read"]), []);
  const [extension] = subagentVideoToolExtensions(["read_video"]);
  assert.equal(extension.name, "pi-web-video-tools");
  assert.notEqual(extension.replaceable, true);
  let tool;
  extension.factory({ registerTool(value) { tool = value; } });
  assert.equal(tool.name, "read_video");
  assert.equal(tool.exposure, "model-only");
});

test("video precedence runs after scope and removes only resolved host conflicts", () => {
  const base = { extensions: [user, host], errors: [conflict, unrelated], runtime: {} };
  const keepUser = withVideoToolPrecedence()(base);
  assert.deepEqual(keepUser.extensions, [user]);
  assert.deepEqual(keepUser.errors, [unrelated]);
  const hostOnly = withVideoToolPrecedence(value => ({ ...value, extensions: [host] }))(base);
  assert.deepEqual(hostOnly.extensions, [host]);
  assert.deepEqual(hostOnly.errors, [unrelated]);
  assert.deepEqual(base.extensions, [user, host], "The source list is not mutated");
});

test("video precedence does not hide third-party conflicts or failed factory diagnostics", () => {
  const otherConflict = { path: "/agent/extensions/another-video.ts", error: `Tool "read_video" conflicts with ${user.path}` };
  const hostFailure = { path: hostPath, error: "Failed to register video tool" };
  const result = withVideoToolPrecedence()({ extensions: [host, user], errors: [conflict, otherConflict, hostFailure], runtime: {} });
  assert.deepEqual(result.errors, [otherConflict, hostFailure]);
  const noHost = { extensions: [user], errors: [otherConflict], runtime: {} };
  assert.equal(withVideoToolPrecedence()(noHost), noHost);
});
