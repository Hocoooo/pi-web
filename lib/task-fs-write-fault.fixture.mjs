import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";

// Install before Jiti loads the production modules: its fs namespace can copy
// named exports. Keep one dispatcher, but arm it only at the intended boundary.
export function installTaskTemporaryWriteFault() {
  const originalOpen = fs.open;
  let active;
  fs.open = async function (file, flags, ...args) {
    if (active && flags === "wx" && typeof file === "string") {
      const path = resolve(file);
      if (path.startsWith(`${active.target}.`) && path.endsWith(".tmp")) {
        active.calls.push(path);
        throw Object.assign(new Error(`EACCES: permission denied, open '${file}'`), {
          code: "EACCES", syscall: "open", path: file,
        });
      }
    }
    return Reflect.apply(originalOpen, this, [file, flags, ...args]);
  };
  syncBuiltinESMExports();
  return {
    deny(file) {
      assert.equal(active, undefined, "only one filesystem fault may be armed");
      const fault = { target: resolve(file), calls: [] };
      active = fault;
      return {
        calls: fault.calls,
        restore() { if (active === fault) active = undefined; },
      };
    },
    restore() {
      active = undefined;
      fs.open = originalOpen;
      syncBuiltinESMExports();
    },
  };
}
