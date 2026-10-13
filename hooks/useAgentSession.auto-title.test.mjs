import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const hook = readFileSync(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const chat = readFileSync(new URL("../components/ChatWindow.tsx", import.meta.url), "utf8");
const shell = readFileSync(new URL("../components/AppShell.tsx", import.meta.url), "utf8");

test("title SSE updates are session-scoped metadata, not a new run or history reload", () => {
  const event = hook.slice(hook.indexOf('case "session_title_updated"'), hook.indexOf('case "agent_start"'));
  assert.match(event, /event\.sessionId !== sid/);
  assert.match(event, /typeof event\.title !== "string"/);
  assert.match(event, /typeof event\.autoTitleEnabled !== "boolean"/);
  assert.match(event, /titleEventVersionRef\.current\+\+/);
  assert.match(event, /onSessionTitleChange\?\.\(sid, event\.title, event\.autoTitleEnabled, typeof event\.sessionListVersion/);
  assert.doesNotMatch(event, /loadSession\(|setSettledRun\(|dispatch\(/);
});

test("an in-flight session GET cannot overwrite a newer title event", () => {
  assert.match(hook, /const titleVersion = titleEventVersionRef\.current/);
  assert.match(hook, /titleVersion === titleEventVersionRef\.current && d\.info/);
  assert.match(hook, /onSessionTitleChange\?\.\(sid, d\.info\.name \?\? "", d\.info\.autoTitleEnabled, d\.sessionListVersion\)/);
  assert.match(shell, /protectCatalogTitle\(row, sessionListVersion, titleSnapshotsRef\.current\.get\(current\.id\)\)/);
  assert.match(shell, /protectCatalogTitle\(row, d\?\.sessionListVersion, titleSnapshotsRef\.current\.get\(sessionId\)\)/);
  assert.match(chat, /onAgentEnd: wrappedOnAgentEnd, onSessionTitleChange/);
  assert.match(shell, /onSessionTitleChange=\{handleSessionTitleChange\}/);
});

test("the per-session control is persisted, discloses cost, and is omitted for subagents", () => {
  assert.match(shell, /selectedSession\.relation\?\.kind !== "subagent"/);
  assert.match(shell, /checked=\{selectedSession\.autoTitleEnabled \?\? !selectedSession\.name\}/);
  assert.match(shell, /body: JSON\.stringify\(\{ autoTitleEnabled: enabled \}\)/);
  assert.match(shell, /translate\("title\.autoUpdateDescription"\)/);
  for (const locale of ["en", "zh-CN", "zh-TW"]) {
    const messages = readFileSync(new URL(`../lib/i18n/messages/${locale}.ts`, import.meta.url), "utf8");
    assert.match(messages, /"title\.autoUpdate":/);
    assert.match(messages, /"title\.autoUpdateDescription":/);
  }
});

test("automatic generation is not triggered again by browser completion or title events", () => {
  const completed = shell.slice(shell.indexOf("const handleAgentEnd"), shell.indexOf("const handleAttentionNeeded"));
  assert.doesNotMatch(completed, /handleAutoName\(|auto-name/);
  assert.match(chat, /JSON\.stringify\(\{ model: nextCueModel, leafId: activeLeafId \}\)/);
});
