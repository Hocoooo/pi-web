import { statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

/** Lexical normalization only: safe for confirming an already committed selection. */
export function normalizeCwd(input: string): string {
  const cwd = input.trim();
  if (!cwd) throw new Error("Path is required");
  return cwd === "~" ? homedir()
    : cwd.startsWith("~/") ? resolve(homedir(), cwd.slice(2))
    : isAbsolute(cwd) ? cwd : resolve(cwd);
}

/** Shared directory boundary for explicit project selection; grants no file access. */
export function validatedCwd(input: string): string {
  const normalized = normalizeCwd(input);
  const cwd = input.trim();
  let stat;
  try { stat = statSync(normalized); }
  catch { throw new Error(`Directory does not exist: ${cwd}`); }
  if (!stat.isDirectory()) throw new Error(`Path is not a directory: ${cwd}`);
  return normalized;
}
