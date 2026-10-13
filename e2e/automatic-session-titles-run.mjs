// Isolated source-checkout runner. Never builds or changes the global Pi Web service.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
assert.equal(existsSync(join(root, ".next/dev/lock")), false, "Reuse the checkout's existing dev server instead of starting another");
const runDir = mkdtempSync(join(tmpdir(), "pi-web-title-browser-"));
const agentDir = join(runDir, "agent");
mkdirSync(agentDir);
const probe = createServer();
probe.listen(0, "127.0.0.1");
await once(probe, "listening");
const port = probe.address().port;
await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
const base = `http://127.0.0.1:${port}`;
const log = createWriteStream(join(runDir, "server.log"));
const server = spawn(process.execPath, ["--require", join(root, "bin/stdio-guard.js"), join(root, "node_modules/next/dist/bin/next"), "dev", "-H", "127.0.0.1", "-p", String(port)], {
  cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_WEB_PASSWORD: "", NEXT_TELEMETRY_DISABLED: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.pipe(log, { end: false });
server.stderr.pipe(log, { end: false });
const exited = once(server, "exit");
try {
  const deadline = Date.now() + 120_000;
  while (true) {
    assert.equal(server.exitCode, null, `Dev server exited; log: ${join(runDir, "server.log")}`);
    const response = await fetch(base, { signal: AbortSignal.timeout(5000) }).catch(() => null);
    if (response?.ok) break;
    assert.ok(Date.now() < deadline, "Dev server readiness timed out");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const test = spawn(process.execPath, [join(root, "e2e/automatic-session-titles.mjs")], {
    cwd: root, env: { ...process.env, E2E_BASE_URL: base }, stdio: "inherit",
  });
  const [code] = await once(test, "exit");
  assert.equal(code, 0, `Browser test failed; server log: ${join(runDir, "server.log")}`);
} finally {
  if (server.exitCode === null && server.signalCode === null) {
    server.kill("SIGTERM");
    const force = setTimeout(() => server.kill("SIGKILL"), 10_000);
    await exited;
    clearTimeout(force);
  }
  log.end();
  rmSync(agentDir, { recursive: true, force: true });
  console.log(`Isolated test server stopped; log: ${join(runDir, "server.log")}`);
}
