import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { windowsRevealInTabScript, windowsRevealFallbackScript } = await jiti.import("./windows-explorer.ts");
const { desktopFileCommand } = await jiti.import("./desktop-files.ts");

function powershell(script, env = {}) {
  const { command } = desktopFileCommand("C:\\test.txt", "reveal", "win32");
  return execFileSync(command, ["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", Buffer.from("$ProgressPreference = 'SilentlyContinue'\n" + script, "utf16le").toString("base64")], {
    encoding: "utf8", windowsHide: true, timeout: 20_000, env: { ...process.env, ...env },
  }).trim();
}

test("Windows reveal targets UIA and a newly registered view, never keyboard or clipboard", () => {
  assert.match(windowsRevealInTabScript, /GetIUnknownForObject/);
  assert.match(windowsRevealInTabScript, /\$before.ContainsKey/);
  assert.match(windowsRevealInTabScript, /\$oldCount \+ 1/);
  assert.match(windowsRevealInTabScript, /InvokePattern/);
  assert.match(windowsRevealInTabScript, /\$newView.Navigate2\(\$folder\)/);
  assert.match(windowsRevealInTabScript, /SelectItem\(\$item, 29\)/);
  assert.doesNotMatch(windowsRevealInTabScript, /SendKeys|SetClipboard|keybd_event|SendInput/);
  assert.match(windowsRevealFallbackScript, /\/n,\/select,/);
});

test("PowerShell parses the complete production scripts without executing them", { skip: process.platform !== "win32" }, () => {
  for (const script of [windowsRevealInTabScript, windowsRevealFallbackScript]) {
    const result = powershell(String.raw`
$tokens = $null
$errors = $null
[System.Management.Automation.Language.Parser]::ParseInput($env:PI_WEB_TEST_SCRIPT, [ref]$tokens, [ref]$errors) | Out-Null
if ($errors.Count) { throw ($errors | Out-String) }
Write-Output 'parsed'
`, { PI_WEB_TEST_SCRIPT: script });
    assert.equal(result, "parsed");
  }
});

test("no eligible Explorer window and unavailable UIA both enter fallback without touching the desktop", { skip: process.platform !== "win32" }, () => {
  // Replace only the fallback's side effect; execute the real error-handling flow.
  const safeScript = windowsRevealInTabScript.replace(windowsRevealFallbackScript, "Write-Output 'fallback'");
  const noWindows = safeScript.replace(/^  \$oldViews = .*$/m, "  $oldViews = @()");
  assert.notEqual(noWindows, safeScript);
  assert.equal(powershell(noWindows), "fallback");
  const noAutomation = safeScript.replace("Add-Type -AssemblyName UIAutomationClient", "throw 'UIA unavailable'");
  assert.equal(powershell(noAutomation), "fallback");
});
