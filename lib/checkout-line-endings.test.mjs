import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("fresh checkouts keep source LF with autocrlf enabled without changing binary files", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-checkout-eol-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const git = (...args) => execFileSync("git", ["-C", dir, "-c", "core.autocrlf=true", ...args], { windowsHide: true, stdio: "pipe" });
  git("init", "--quiet");
  await writeFile(join(dir, ".gitattributes"), await readFile(new URL("../.gitattributes", import.meta.url)));
  const source = "export const value = 1;\nexport const other = 2;\n";
  const binary = Buffer.from([0, 13, 10, 255]);
  await writeFile(join(dir, "source.ts"), source);
  await writeFile(join(dir, "native.cmd"), "@echo off\nexit /b 0\n");
  await writeFile(join(dir, "binary.bin"), binary);
  git("add", ".");
  for (const name of ["source.ts", "native.cmd", "binary.bin"]) await rm(join(dir, name));
  git("checkout-index", "--all");
  assert.equal(await readFile(join(dir, "source.ts"), "utf8"), source);
  assert.equal(await readFile(join(dir, "native.cmd"), "utf8"), "@echo off\r\nexit /b 0\r\n");
  assert.deepEqual(await readFile(join(dir, "binary.bin")), binary);
});
