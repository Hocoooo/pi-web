import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";

const cliPath = fileURLToPath(new URL("../bin/pi-web.js", import.meta.url));
const cliRequire = createRequire(cliPath);
const source = readFileSync(cliPath, "utf8");

// Execute the real CLI with process creation replaced. No server/browser is opened.
function launch({ platform = "win32", openBrowser = false } = {}) {
  const spawns = [];
  const wired = [];
  const output = [];
  const warnings = [];
  const require = (name) => {
    if (name === "child_process") return {
      spawn(command, args, options) {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.unrefCount = 0;
        child.unref = () => { child.unrefCount++; };
        spawns.push({ command, args, options, child });
        return child;
      },
    };
    if (name === "fs") return { existsSync: () => true };
    // Rotation has its own filesystem tests; the launch fixture must never
    // inspect or rewrite the checkout's real prerender manifest.
    if (name === "./rotate-preview-secrets") return { rotatePreviewSecrets: () => ({ ok: true }) };
    if (name === "./pi-web-options") return {
      parseLaunchOptions: () => ({ port: "30141", hostname: "127.0.0.1", openBrowser }),
    };
    if (name === "./process-lifecycle") return { wireChildProcessLifecycle: (child) => wired.push(child) };
    return cliRequire(name);
  };
  require.resolve = cliRequire.resolve;
  runInNewContext(source.replace(/^#![^\n]*\n/, ""), {
    require, __dirname: path.dirname(cliPath),
    process: {
      platform, versions: process.versions, execPath: process.execPath,
      env: { PI_TEST_MARKER: "runtime-env", ComSpec: "C:\\Windows\\System32\\cmd.exe" },
      stdout: { write: (value) => output.push(value) },
    },
    console: { warn: (value) => warnings.push(value), error: (value) => warnings.push(value) },
  }, { filename: cliPath });
  return { spawns, wired, output, warnings };
}

for (const platform of ["win32", "linux", "darwin"]) {
  test(`${platform}: Next requests a hidden Windows console without changing lifecycle or logs`, () => {
    const { spawns, wired, output } = launch({ platform });
    assert.equal(spawns.length, 1);
    const next = spawns[0];
    assert.equal(next.options.windowsHide, true);
    assert.equal(next.command, process.execPath);
    assert.equal(next.options.shell, undefined, "never introduce a command-shell wrapper");
    assert.equal(next.options.detached, undefined, "Next remains owned by the CLI lifecycle");
    assert.deepEqual(Array.from(next.options.stdio), ["inherit", "pipe", "inherit"]);
    assert.equal(next.options.env.PI_WEB_HOSTNAME, "127.0.0.1");
    assert.equal(next.options.env.PI_TEST_MARKER, "runtime-env");
    assert.equal(wired[0], next.child);
    next.child.stdout.emit("data", Buffer.from("Ready\n"));
    assert.deepEqual(output, ["Ready\n"]);
    assert.equal(spawns.length, 1, "--no-open never starts a browser opener");
  });
}

test("Windows browser opening hides cmd.exe and still opens once after Ready", () => {
  const { spawns, warnings } = launch({ openBrowser: true });
  const next = spawns[0];
  next.child.stdout.emit("data", Buffer.from("Starting...\n"));
  assert.equal(spawns.length, 1);
  next.child.stdout.emit("data", Buffer.from("Ready\n"));
  next.child.stdout.emit("data", Buffer.from("Ready again\n"));
  assert.equal(spawns.length, 2);
  const opener = spawns[1];
  assert.equal(opener.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(Array.from(opener.args), ["/c", "start", "", "http://127.0.0.1:30141"]);
  assert.equal(opener.options.windowsHide, true);
  assert.equal(opener.options.shell, undefined);
  assert.equal(opener.options.stdio, "ignore");
  assert.equal(opener.options.detached, true);
  assert.equal(opener.child.unrefCount, 1);
  opener.child.emit("error", new Error("browser unavailable"));
  assert.ok(warnings.some(warning => /Could not open browser automatically: browser unavailable/.test(warning)));
});

for (const [platform, command] of [["darwin", "open"], ["linux", "xdg-open"]]) {
  test(`${platform}: browser opening retains the native opener`, () => {
    const { spawns } = launch({ platform, openBrowser: true });
    spawns[0].child.stdout.emit("data", Buffer.from("Ready\n"));
    assert.equal(spawns[1].command, command);
    assert.deepEqual(Array.from(spawns[1].args), ["http://127.0.0.1:30141"]);
    assert.equal(spawns[1].child.unrefCount, 1);
  });
}
