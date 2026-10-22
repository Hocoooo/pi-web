export interface LegacyScanMetrics {
  /** Bytes delivered by the stream (including the remainder of a marker's chunk). */
  bytesRead: number;
  /** Completed lines examined, including empty lines. */
  lines: number;
  /** JSON.parse attempts after the exact legacy regex checks. */
  parsedLines: number;
  /** Lines decoded after the coarse byte prefilter. */
  candidateLines: number;
}

/** Minimal marker metadata, not yet validated by readSubagentRun. */
export interface LegacyScanEntry {
  type: "custom";
  customType: "pi-web:subagent";
  data: {
    version: number | null;
    parentSessionId: string | null;
    /** Empty string for a valid string path; null for an invalid/missing path. */
    parentSessionPath: "" | null;
  } | null;
}

export function createLegacyScanMetrics(): LegacyScanMetrics;
export function scanLegacyEntry(
  node: { id: string; path: string },
  metrics?: LegacyScanMetrics,
): Promise<LegacyScanEntry | undefined>;
