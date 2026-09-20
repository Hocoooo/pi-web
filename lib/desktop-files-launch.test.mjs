import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { createJiti } from "jiti";

// Mock the native boundary, not the queue/fallback logic. Never opens an application.
test("Windows reveals serialize, retry a failed process without UIA, and recover after errors", { skip: process.platform !== "win32" }, async (t) => {
  const calls = [];
  const mock = t.mock.method(childProcess, "execFile", (command, args, options, callback) => {
    calls.push({ command, args, options, callback });
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  const jiti = createJiti(import.meta.url, { moduleCache: false });
  const { launchDesktopFile } = await jiti.import("./desktop-files.ts");
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const first = launchDesktopFile("C:\\one.txt", "reveal");
  const second = launchDesktopFile("C:\\two.txt", "reveal");
  await tick();
  assert.equal(calls.length, 1, "Only one reveal may snapshot Explorer at a time");
  assert.equal(calls[0].options.env.PI_WEB_DESKTOP_FILE, "C:\\one.txt");
  calls[0].callback(new Error("Process timed out"));
  await tick();
  assert.equal(calls.length, 2);
  const fallback = Buffer.from(calls[1].args.at(-1), "base64").toString("utf16le");
  assert.match(fallback, /\/n,\/select,/);
  assert.doesNotMatch(fallback, /UIAutomationClient|Navigate2/);
  calls[1].callback(null);
  await first;
  await tick();
  assert.equal(calls.length, 3);
  assert.equal(calls[2].options.env.PI_WEB_DESKTOP_FILE, "C:\\two.txt");
  calls[2].callback(null);
  await second;
  assert.equal(globalThis.__piDesktopRevealQueue, undefined);

  const failed = launchDesktopFile("C:\\bad.txt", "reveal");
  const rejection = assert.rejects(failed, /system could not open/);
  await tick();
  calls[3].callback(new Error("Failed"));
  await tick();
  calls[4].callback(new Error("Fallback failed"));
  await rejection;
  const recovered = launchDesktopFile("C:\\next.txt", "reveal");
  await tick();
  calls[5].callback(null);
  await recovered;
  assert.equal(globalThis.__piDesktopRevealQueue, undefined);

  const open = launchDesktopFile("C:\\default-app.txt", "open");
  assert.equal(calls.length, 7);
  assert.doesNotMatch(Buffer.from(calls[6].args.at(-1), "base64").toString("utf16le"), /UIAutomationClient|Navigate2/);
  calls[6].callback(null);
  await open;
});
