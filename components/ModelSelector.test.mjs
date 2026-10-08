import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ModelSelector.tsx", import.meta.url), "utf8");

test("does not autofocus the model filter on mobile", async () => {
  // Autofocus would open the on-screen keyboard as soon as the picker opens.
  assert.match(source, /<ModelPicker[^>]*autoFocus=\{!isMobile \|\| openedFromCommand\.current\}/);
  const picker = await readFile(new URL("./ModelPicker.tsx", import.meta.url), "utf8");
  assert.match(picker, /if \(target \|\| autoFocus\)/);
  assert.doesNotMatch(source, /^\s*autoFocus\s*$/m);
});
