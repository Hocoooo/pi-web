"use strict";

// CommonJS keeps this worker-loadable without a TypeScript loader or app imports.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require("node:fs");

function createLegacyScanMetrics() {
  return { bytesRead: 0, lines: 0, parsedLines: 0, candidateLines: 0 };
}

const SUBAGENT_META_TYPE = "pi-web:subagent";
const CUSTOM_TYPE = Buffer.from('"customType"');
const UNICODE_ESCAPE = Buffer.from("\\u");
const OVERLAP = CUSTOM_TYPE.length - 1;
const EMPTY = Buffer.alloc(0);
const MARKER = /"customType"\s*:\s*"pi-web:subagent"/;
const REAL_UNICODE_ESCAPE = /(?:^|[^\\])(?:\\\\)*\\u[0-9a-fA-F]{4}/;

/** Return only the fields needed by subagentMetadataData/readSubagentRun.
 * Preserve invalid metadata as invalid, but never transfer arbitrary task/body
 * values. The parent path is only type-checked by that validator, not returned
 * by this scan, so retain its validity without transferring its contents. */
function minimalEntry(entry) {
  const data = entry.data;
  const record = data !== null && typeof data === "object" && !Array.isArray(data);
  return {
    type: "custom",
    customType: SUBAGENT_META_TYPE,
    data: record ? {
      version: typeof data.version === "number" ? data.version : null,
      parentSessionId: typeof data.parentSessionId === "string" ? data.parentSessionId : null,
      parentSessionPath: typeof data.parentSessionPath === "string" ? "" : null,
    } : null,
  };
}

/** Scan through late legacy markers without decoding ordinary transcript lines.
 * Retain slices of only the current line: a marker can occur at its very end.
 * Memory is O(longest line), not O(file); candidate lines are joined only once,
 * never repeatedly copied as they grow. No line or Unicode escape is truncated.
 * Counters are optional, caller-owned, and additive across concurrent scans.
 * The first actual marker is returned even if its metadata is invalid: the
 * caller must validate it, never skip it in favor of a later valid marker. */
async function scanLegacyEntry(node, metrics) {
  const stream = fs.createReadStream(node.path);
  let parts = [];
  let length = 0;
  let tail = EMPTY;
  let candidate = false;
  let afterCR = false;

  const append = (part) => {
    if (!part.length) return;
    parts.push(part);
    length += part.length;
    if (candidate) return;
    candidate = part.includes(CUSTOM_TYPE) || part.includes(UNICODE_ESCAPE);
    // Only a fixed-size overlap is copied, including for one-byte chunks.
    if (!candidate && tail.length) {
      const boundary = Buffer.concat([tail, part.subarray(0, OVERLAP)]);
      candidate = boundary.includes(CUSTOM_TYPE) || boundary.includes(UNICODE_ESCAPE);
    }
    if (!candidate) {
      tail = part.length >= OVERLAP ? part.subarray(part.length - OVERLAP)
        : Buffer.concat([tail, part]).subarray(-OVERLAP);
    }
  };

  const finishLine = () => {
    if (metrics) metrics.lines++;
    if (candidate) {
      if (metrics) metrics.candidateLines++;
      const line = (parts.length === 1 ? parts[0] : Buffer.concat(parts, length)).toString("utf8");
      // These checks intentionally match the previous readline scanner exactly.
      // Quoted code and even-backslash escapes must not trigger JSON parsing.
      const marker = MARKER.test(line);
      if (marker || REAL_UNICODE_ESCAPE.test(line)) {
        let entry;
        if (metrics) metrics.parsedLines++;
        try { entry = JSON.parse(line); }
        catch {
          if (marker) throw new Error("Cannot safely parse a related subagent marker.");
        }
        if (entry?.type === "custom" && entry.customType === SUBAGENT_META_TYPE) {
          return minimalEntry(entry);
        }
      }
    }
    parts = [];
    length = 0;
    tail = EMPTY;
    candidate = false;
    return undefined;
  };

  try {
    for await (const bytes of stream) {
      if (metrics) metrics.bytesRead += bytes.length;
      let start = afterCR && bytes[0] === 10 ? 1 : 0;
      afterCR = false;
      // Cache both separator positions so many LF lines with no CR (or vice
      // versa) do not repeatedly search the rest of the chunk quadratically.
      let lf = bytes.indexOf(10, start);
      let cr = bytes.indexOf(13, start);
      for (;;) {
        const end = lf < 0 ? cr : cr < 0 ? lf : Math.min(lf, cr);
        if (end < 0) break;
        append(bytes.subarray(start, end));
        const entry = finishLine();
        if (entry !== undefined) return entry;
        start = end + 1;
        if (end === cr) {
          if (bytes[start] === 10) start++;
          else if (start === bytes.length) afterCR = true;
        }
        if (lf >= 0 && lf < start) lf = bytes.indexOf(10, start);
        if (cr >= 0 && cr < start) cr = bytes.indexOf(13, start);
      }
      append(bytes.subarray(start));
    }
    if (length) return finishLine();
    return undefined;
  } finally { stream.destroy(); }
}

module.exports = { createLegacyScanMetrics, scanLegacyEntry };
