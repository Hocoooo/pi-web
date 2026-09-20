import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { desktopFileCommand, isLocalDesktopRequest } = await jiti.import("./desktop-files.ts");

function request(host = "localhost:30141", origin = `http://${host}`, headers = {}) {
  return new Request(`http://${host}/api/files/desktop`, { method: "POST", headers: { host, ...(origin ? { origin } : {}), ...headers } });
}

test("desktop actions require an explicit matching localhost origin", () => {
  for (const host of ["localhost:30141", "127.0.0.1:30141", "[::1]:30141"]) assert.equal(isLocalDesktopRequest(request(host)), true);
  assert.equal(isLocalDesktopRequest(request("localhost:30141", "http://localhost:30141", { "x-forwarded-host": "localhost:30141" })), true);
  for (const req of [request("192.168.1.5:30141"), request("evil.example"), request("localhost:30141", "http://evil.example"), request("localhost:30141", "http://localhost:9999"), request("localhost:30141", null), request("localhost:30141", "http://localhost:30141", { "sec-fetch-site": "cross-site" }), request("localhost:30141", "http://localhost:30141", { "x-forwarded-host": "relay.example" })]) {
    assert.equal(isLocalDesktopRequest(req), false);
  }
});

test("Windows filenames never become PowerShell source or command arguments", () => {
  const tricky = "C:\\project\\中文 & $(calc) ' report.txt";
  for (const action of ["open", "reveal"]) {
    const command = desktopFileCommand(tricky, action, "win32");
    assert.match(command.command, /WindowsPowerShell/);
    assert.equal(command.args.includes(tricky), false);
    const script = Buffer.from(command.args.at(-1), "base64").toString("utf16le");
    assert.equal(script.includes(tricky), false);
    assert.match(script, /\$env:PI_WEB_DESKTOP_FILE/);
    assert.match(script, /UseShellExecute\s*=\s*\$true/);
  }
});

test("desktop launchers preserve a path as a single argument", () => {
  const file = "/project/a b & '中文.txt";
  assert.deepEqual(desktopFileCommand(file, "open", "darwin"), { command: "/usr/bin/open", args: [file] });
  assert.deepEqual(desktopFileCommand(file, "reveal", "darwin"), { command: "/usr/bin/open", args: ["-R", file] });
  assert.deepEqual(desktopFileCommand(file, "reveal", "linux"), { command: "xdg-open", args: ["/project"] });
  assert.throws(() => desktopFileCommand(file, "open", "aix"), /not supported/);
});
