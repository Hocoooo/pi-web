import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

test("desktop route validates requests and authorizes files before launching", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-desktop-test-"));
  const root = path.join(dir, "project");
  await mkdir(root);
  const file = path.join(root, "中文 & ' report.txt");
  const outside = path.join(dir, "outside.txt");
  await writeFile(file, "test");
  await writeFile(outside, "outside");
  const stub = path.join(dir, "desktop-stub.ts");
  const references = path.join(dir, "references-stub.ts");
  await writeFile(stub, `export { isLocalDesktopRequest } from ${JSON.stringify(path.resolve("lib/desktop-files.ts").replaceAll("\\", "/"))};
    export async function launchDesktopFile(filePath, action) {
      if (globalThis.__desktopTestFail) throw new Error('No default application');
      globalThis.__desktopTestLaunches.push({ filePath, action });
    }`);
  await writeFile(references, `export async function isFilePathReferencedBySession(filePath, sessionId) {
    return sessionId === 'test-session' && filePath === ${JSON.stringify(outside)};
  }`);
  const previousCache = globalThis.__piAllowedRootsCache;
  globalThis.__piAllowedRootsCache = { roots: new Set([root]), expiresAt: Date.now() + 60_000 };
  globalThis.__desktopTestLaunches = [];
  t.after(async () => {
    globalThis.__piAllowedRootsCache = previousCache;
    delete globalThis.__desktopTestLaunches;
    delete globalThis.__desktopTestFail;
    await rm(dir, { recursive: true, force: true });
  });
  const jiti = createJiti(import.meta.url, {
    moduleCache: false,
    alias: { "@/lib/desktop-files": stub, "@/lib/session-file-references": references, "@": process.cwd() },
  });
  const { POST } = await jiti.import("./route.ts");
  const req = (body, headers = {}) => new Request("http://localhost:30141/api/files/desktop", {
    method: "POST", headers: { host: "localhost:30141", origin: "http://localhost:30141", "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body),
  });
  for (const [body, headers, expected] of [
    [{ filePath: file, action: "open" }, { origin: "http://evil.example" }, 403],
    [{ filePath: file, action: "open" }, { "Content-Type": "text/plain" }, 415],
    ["{", {}, 400],
    [null, {}, 400],
    [{ filePath: "relative.txt", action: "open" }, {}, 400],
    [{ filePath: file, action: "execute" }, {}, 400],
    [{ filePath: outside, action: "open" }, {}, 403],
    [{ filePath: root, action: "open" }, {}, 400],
    [{ filePath: path.join(root, "missing.txt"), action: "open" }, {}, 404],
    [{ filePath: outside, action: "reveal", sessionId: "test-session" }, {}, 403],
  ]) {
    const response = await POST(req(body, headers));
    assert.equal(response.status, expected, JSON.stringify(body));
  }
  assert.deepEqual(globalThis.__desktopTestLaunches, []);
  for (const action of ["open", "reveal"]) {
    assert.equal((await POST(req({ filePath: file, action }))).status, 200);
  }
  assert.equal((await POST(req({ filePath: outside, action: "open", sessionId: "test-session" }))).status, 200);
  assert.deepEqual(globalThis.__desktopTestLaunches, [
    { filePath: await realpath(file), action: "open" },
    { filePath: await realpath(file), action: "reveal" },
    { filePath: await realpath(outside), action: "open" },
  ]);
  const junction = path.join(root, "escape");
  await symlink(dir, junction, process.platform === "win32" ? "junction" : "dir");
  assert.equal((await POST(req({ filePath: path.join(junction, "outside.txt"), action: "open" }))).status, 403);
  globalThis.__desktopTestFail = true;
  const failed = await POST(req({ filePath: file, action: "open" }));
  assert.equal(failed.status, 500);
  assert.match((await failed.json()).error, /No default application/);
});
