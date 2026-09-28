// Windows native smoke: run the real CLI spawn paths with a tiny console probe
// substituted for Next and cmd.exe. No service, browser, port or global install is touched.
// The probe samples its own console at entry; this is not a desktop flash recorder.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  console.log("SKIP: Windows console visibility smoke requires Windows and powershell.exe");
} else {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const dir = mkdtempSync(path.join(tmpdir(), "pi-web-silent-start-"));
  const exe = path.join(dir, "console-probe.exe");
  const nextReport = path.join(dir, "next.json");
  const openerReport = path.join(dir, "opener.json");
  const logPath = path.join(dir, "launcher.log");
  let child;
  try {
    const code = `
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
public class ConsoleProbe {
  [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  public static void Main(string[] args) {
    IntPtr hwnd = GetConsoleWindow();
    bool visible = hwnd != IntPtr.Zero && IsWindowVisible(hwnd);
    File.WriteAllText(args[0], "{\\"hasConsole\\":" + (hwnd != IntPtr.Zero ? "true" : "false") + ",\\"visible\\":" + (visible ? "true" : "false") + "}");
    Console.WriteLine("Ready");
    Thread.Sleep(1500);
  }
}`;
    const ps = `$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n${code}\n'@ -OutputAssembly '${exe.replaceAll("'", "''")}' -OutputType ConsoleApplication`;
    await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(ps, "utf16le").toString("base64")], {
      windowsHide: true, timeout: 30_000,
    });
    const runner = path.join(dir, "runner.cjs");
    writeFileSync(runner, `
const fs = require('node:fs');
const cp = require('node:child_process');
const vm = require('node:vm');
const path = require('node:path');
const { createRequire } = require('node:module');
const cli = ${JSON.stringify(path.join(root, "bin/pi-web.js"))};
const cliRequire = createRequire(cli);
let count = 0;
const fixtureRequire = name => {
  if (name === 'fs') return { ...fs, existsSync: p => p === path.join(path.dirname(cli), '../.next') ? true : fs.existsSync(p) };
  if (name === 'child_process') return { ...cp, spawn(command, args, options) {
    const report = count++ === 0 ? ${JSON.stringify(nextReport)} : ${JSON.stringify(openerReport)};
    // Preserve the actual CLI spawn options, replacing only the executable/argv.
    return cp.spawn(${JSON.stringify(exe)}, [report], options);
  }};
  if (name === './pi-web-options') return { parseLaunchOptions: () => ({ port: '30141', hostname: '127.0.0.1', openBrowser: true }) };
  return cliRequire(name);
};
fixtureRequire.resolve = cliRequire.resolve;
vm.runInNewContext(fs.readFileSync(cli, 'utf8').replace(/^#![^\\n]*\\n/, ''), {
  require: fixtureRequire, __dirname: path.dirname(cli), process, console
}, { filename: cli });
`, "utf8");
    const fd = openSync(logPath, "a");
    try {
      child = spawn(process.execPath, [runner], {
        cwd: root, detached: true, windowsHide: true, stdio: ["ignore", fd, fd],
      });
    } finally { closeSync(fd); }
    const timer = setTimeout(() => {
      // Stop only this smoke's process tree on timeout, never a real service.
      if (child.pid) execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
    }, 20_000);
    let exit;
    try { exit = await once(child, "exit"); } finally { clearTimeout(timer); }
    assert.equal(exit[0], 0, readFileSync(logPath, "utf8"));
    // The detached opener is intentionally not owned by CLI shutdown; wait for its fixture to exit.
    await new Promise(resolve => setTimeout(resolve, 1800));
    for (const [name, report] of [["Next", nextReport], ["browser opener", openerReport]]) {
      const state = JSON.parse(readFileSync(report, "utf8"));
      assert.equal(state.visible, false, `${name} acquired a visible console`);
      console.log(`PASS: ${name} native console probe ${JSON.stringify(state)}`);
    }
    assert.match(readFileSync(logPath, "utf8"), /Ready/);
    console.log("PASS: detached hidden launcher preserves CLI stdout forwarding; no real browser/server was started");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
