import { createJiti } from "jiti";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));

/** Keep alias and relative error imports on the same native Windows cache key. */
export function createTaskTestJiti(id, options = {}) {
  return createJiti(id, {
    ...options,
    alias: {
      "@": root,
      ...options.alias,
      "@/lib/task-types": join(root, "lib", "task-types.ts"),
      "@/lib/task-session-copy": join(root, "lib", "task-session-copy.ts"),
      "@/lib/task-report-settings": join(root, "lib", "task-report-settings.ts"),
    },
  });
}
