// Opt-in only: opens one real Explorer tab (or window with --fallback).
// Does not close or change existing tabs.
// PI_WEB_TEST_NATIVE_EXPLORER=1 node e2e/windows-explorer-tabs.mjs [--fallback]
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createJiti } from "jiti";

assert.equal(process.platform, "win32", "Requires Windows 11");
assert.equal(process.env.PI_WEB_TEST_NATIVE_EXPLORER, "1", "Explicit opt-in required for desktop interaction");
const jiti = createJiti(import.meta.url);
const { desktopFileCommand } = await jiti.import("../lib/desktop-files.ts");
const file = path.resolve("lib/windows-explorer.ts");
const { command, args } = desktopFileCommand(file, "reveal");
const forceFallback = process.argv.includes("--fallback");
if (forceFallback) {
  // Simulate an Explorer version without the tab control, before any tab is created.
  const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
  args[args.length - 1] = Buffer.from(script.replace("Find-Control $root 'TabView'", "Find-Control $root 'PiWebMissingTabView'"), "utf16le").toString("base64");
}
const options = { encoding: "utf8", windowsHide: true, timeout: 20_000, env: { ...process.env, PI_WEB_DESKTOP_FILE: file } };
const snapshotScript = String.raw`
$ProgressPreference = 'SilentlyContinue'
$shell = New-Object -ComObject Shell.Application
$views = @($shell.Windows() | Where-Object { $_.FullName -like '*\explorer.exe' } | ForEach-Object {
  $selected = @()
  try { $selected = @($_.Document.SelectedItems() | ForEach-Object { $_.Path }) } catch {}
  @{ hwnd = [long]$_.HWND; location = $_.LocationURL; selected = $selected }
})
ConvertTo-Json -InputObject $views -Compress -Depth 4
`;
const snapshot = () => JSON.parse(execFileSync(command, ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", Buffer.from(snapshotScript, "utf16le").toString("base64")], options).trim());
const before = snapshot();
assert.ok(before.length, "Open an Explorer window before running this test");
const result = execFileSync(command, args, options).trim();
assert.equal(result, forceFallback ? "window" : "tab", "Expected reveal strategy");
let after = snapshot();
const deadline = Date.now() + 8000;
while (Date.now() < deadline && (after.length !== before.length + 1
  || !after.some((v) => v.selected.some((selected) => selected.toLowerCase() === file.toLowerCase())))) {
  await delay(150);
  after = snapshot();
}
assert.equal(after.length, before.length + 1, "Exactly one new Explorer view");
if (forceFallback) {
  assert.equal(new Set(after.map((v) => v.hwnd)).size, new Set(before.map((v) => v.hwnd)).size + 1, "Fallback opens a new window");
} else {
  assert.deepEqual([...new Set(after.map((v) => v.hwnd))].sort(), [...new Set(before.map((v) => v.hwnd))].sort(), "No new top-level window");
}
const remaining = after.map((v) => `${v.hwnd}|${v.location}`);
for (const view of before) {
  const index = remaining.indexOf(`${view.hwnd}|${view.location}`);
  assert.notEqual(index, -1, "An existing tab must not navigate away");
  remaining.splice(index, 1);
}
assert.ok(after.some((v) => v.selected.some((selected) => selected.toLowerCase() === file.toLowerCase())), "Target file selected");
console.log(`PASS: ${forceFallback ? "new-window fallback" : "existing-window tab"}; Explorer views ${before.length} -> ${after.length}; existing tab locations preserved; target file selected.`);
