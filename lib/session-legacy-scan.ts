import { scanLegacyEntry, type LegacyScanMetrics } from "../bin/session-legacy-scan.cjs";
import { readSubagentRun } from "./subagents";
import type { SessionEntry } from "./types";

export { createLegacyScanMetrics, type LegacyScanMetrics } from "../bin/session-legacy-scan.cjs";

/** The dependency-free core also runs in a worker; validation remains shared
 * with the existing subagent reader. Its minimal entry retains all fields that
 * reader validates, but deliberately omits transcript and task contents. */
export async function scanLegacyParent(
  node: { id: string; path: string },
  metrics?: LegacyScanMetrics,
): Promise<string | undefined> {
  const entry = await scanLegacyEntry(node, metrics);
  if (entry === undefined) return undefined;
  const child = readSubagentRun([entry as SessionEntry], node.id, node.path);
  if (!child) throw new Error("Cannot safely identify a related subagent session.");
  return child.parentSessionId;
}
