import { rename } from "node:fs/promises";

/** Retry only atomic replacement, not logical operations or model requests. */
export async function replaceTaskFile(temporary: string, file: string, assertAuthority?: () => void): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    // A board lock may be lost during backoff; do not commit after that loss.
    assertAuthority?.();
    try { await rename(temporary, file); return; }
    catch (error) {
      if (process.platform !== "win32" || attempt >= 5
        || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      await new Promise(resolve => setTimeout(resolve, 10 * 2 ** attempt));
    }
  }
}
