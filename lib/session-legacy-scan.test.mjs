import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { scanLegacyEntry } from "../bin/session-legacy-scan.cjs";

const jiti = createJiti(import.meta.url, { interopDefault: false });
const { scanLegacyParent, createLegacyScanMetrics } = await jiti.import("./session-legacy-scan.ts");
const marker = (parent = "parent") => JSON.stringify({
  type: "custom", customType: "pi-web:subagent",
  data: { version: 1, parentSessionId: parent, parentSessionPath: "/parent.jsonl" },
});
const message = (content) => JSON.stringify({ type: "message", message: { role: "user", content } });

async function fixture(t, body) {
  const dir = await mkdtemp(join(tmpdir(), "pi-legacy-scan-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const node = { id: "child", path: join(dir, "child.jsonl") };
  await writeFile(node.path, body);
  return node;
}

function chunkSize(t, size) {
  const original = fs.createReadStream;
  const streams = [];
  t.mock.method(fs, "createReadStream", (path, options) => {
    const stream = original(path, { ...options, highWaterMark: size });
    streams.push(stream);
    return stream;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return streams;
}

test("late, parentless and conflicting-header metadata still determines the parent", async (t) => {
  for (const parentSession of [undefined, "/unrelated.jsonl"]) {
    const body = [JSON.stringify({ type: "session", id: "child", parentSession }),
      ...Array.from({ length: 3000 }, () => message("ordinary")), marker()].join("\n");
    const node = await fixture(t, body);
    const metrics = createLegacyScanMetrics();
    assert.equal(await scanLegacyParent(node, metrics), "parent");
    assert.deepEqual(metrics, { bytesRead: Buffer.byteLength(body), lines: 3002, candidateLines: 1, parsedLines: 1 });
  }
});

for (const size of [1, 2, 7, 13]) {
  test(`byte prefilter, UTF8 and CRLF survive ${size}-byte chunks`, async (t) => {
    chunkSize(t, size);
    const escaped = marker("父🙂").replace('"customType"', '"custom\\u0054ype"')
      .replace("pi-web:subagent", "pi-web:sub\\u0061gent");
    const body = message("ordinary🙂") + "\r\n\r\n" + escaped;
    const node = await fixture(t, body);
    const metrics = createLegacyScanMetrics();
    assert.equal(await scanLegacyParent(node, metrics), "父🙂");
    assert.deepEqual(metrics, { bytesRead: Buffer.byteLength(body), lines: 3, candidateLines: 1, parsedLines: 1 });
  });
}

test("raw customType token is recognized at every chunk-boundary offset", async (t) => {
  chunkSize(t, 16);
  for (let offset = 0; offset < 16; offset++) {
    const node = await fixture(t, " ".repeat(offset) + marker());
    assert.equal(await scanLegacyParent(node), "parent", `offset ${offset}`);
  }
});

test("escaped keys, custom types and entry types use actual JSON validation", async (t) => {
  for (const line of [
    marker().replace('"customType"', '"\\u0063ustomType"'),
    marker().replace("pi-web:subagent", "\\u0070i-web:subagent"),
    marker().replace('"custom"', '"cu\\u0073tom"'),
    marker().replaceAll("customType", "\\u0063\\u0075\\u0073\\u0074\\u006f\\u006d\\u0054\\u0079\\u0070\\u0065"),
  ]) assert.equal(await scanLegacyParent(await fixture(t, line)), "parent");
});

test("escaped quoted code and even-backslash Unicode are never JSON parsed", async (t) => {
  const body = [message('const code = {"customType":"pi-web:subagent"};'),
    message(String.raw`\u0063 \\u0063`),
    JSON.stringify({ customType: "unrelated" })].join("\n");
  const node = await fixture(t, body);
  const parse = JSON.parse;
  let attempts = 0;
  t.mock.method(JSON, "parse", function (...args) { attempts++; return parse.apply(this, args); });
  const metrics = createLegacyScanMetrics();
  assert.equal(await scanLegacyParent(node, metrics), undefined);
  assert.equal(attempts, 0);
  assert.equal(metrics.parsedLines, 0);
  assert.equal(metrics.candidateLines, 2);
});

test("odd-backslash Unicode fallback is parsed, even runs are not", async (t) => {
  chunkSize(t, 2);
  for (let count = 1; count <= 7; count++) {
    const line = '{"type":"message","text":"' + "\\".repeat(count) + 'u0061"}';
    const metrics = createLegacyScanMetrics();
    assert.equal(await scanLegacyParent(await fixture(t, line), metrics), undefined);
    assert.equal(metrics.candidateLines, 1);
    assert.equal(metrics.parsedLines, count % 2);
  }
});

test("malformed actual marker fails closed and destroys the stream", async (t) => {
  const streams = chunkSize(t, 17);
  for (const line of [
    '{"type":"custom","customType":"pi-web:subagent",',
    marker().replace('"version":1', '"version":999'),
    marker().replace('"parentSessionId":"parent",', ""),
    marker().replace('"customType"', '"custom\\u0054ype"').replace('"version":1', '"version":999'),
  ]) {
    await assert.rejects(scanLegacyParent(await fixture(t, line)), /Cannot safely (parse|identify) a related subagent/);
    assert.equal(streams.at(-1).destroyed, true);
  }
});

test("malformed Unicode-only candidates retain the old non-marker fallback", async (t) => {
  const body = '{"custom\\u0054ype":"pi-web:subagent",\n' + marker();
  const metrics = createLegacyScanMetrics();
  assert.equal(await scanLegacyParent(await fixture(t, body), metrics), "parent");
  assert.equal(metrics.parsedLines, 2);
});

test("parsed but unrelated entries are ignored; first real marker wins", async (t) => {
  const body = ["null", marker().replace('"type":"custom"', '"type":"message"'),
    JSON.stringify({ nested: JSON.parse(marker()) }), marker("first"), marker("second"),
    '{"customType":"pi-web:subagent",'].join("\n");
  const streams = chunkSize(t, 32);
  const metrics = createLegacyScanMetrics();
  assert.equal(await scanLegacyParent(await fixture(t, body), metrics), "first");
  assert.equal(metrics.lines, 4);
  assert.equal(metrics.parsedLines, 3);
  assert.equal(streams[0].destroyed, true);
});

test("empty parent ID preserves readSubagentRun's existing first-marker result", async (t) => {
  assert.equal(await scanLegacyParent(await fixture(t, marker("") + "\n" + marker("later"))), "");
});

test("huge ordinary lines are not decoded or parsed; a marker at the end is not truncated", async (t) => {
  const huge = message("ordinary🙂".repeat(500000));
  const late = '{"padding":"' + "x".repeat(2 * 1024 * 1024) + '",' + marker().slice(1);
  const node = await fixture(t, huge + "\n" + late);
  const toString = Buffer.prototype.toString;
  let largeDecodes = 0;
  t.mock.method(Buffer.prototype, "toString", function (...args) {
    if (this.length > 1024 * 1024) {
      largeDecodes++;
      assert.equal(this.length, Buffer.byteLength(late), "only candidate line may be decoded");
    }
    return toString.apply(this, args);
  });
  const metrics = createLegacyScanMetrics();
  assert.equal(await scanLegacyParent(node, metrics), "parent");
  assert.equal(largeDecodes, 1);
  assert.equal(metrics.lines, 2);
  assert.equal(metrics.candidateLines, 1);
  assert.equal(metrics.parsedLines, 1);
});

test("empty files, blank lines, CRLF, bare CR and unterminated lines match readline", async (t) => {
  chunkSize(t, 1);
  for (const [body, lines] of [["", 0], ["\n", 1], ["\r\n", 1], ["\r\n\r\n", 2],
    ["{}", 1], ["{}\r{}\n{}\r\n{}", 4], ["{}\r\n", 1]]) {
    const metrics = createLegacyScanMetrics();
    assert.equal(await scanLegacyParent(await fixture(t, body), metrics), undefined);
    assert.deepEqual(metrics, { bytesRead: Buffer.byteLength(body), lines, candidateLines: 0, parsedLines: 0 });
  }
});

test("metrics are caller-owned and additive across four concurrent scans", async (t) => {
  const nodes = await Promise.all(Array.from({ length: 4 }, () => fixture(t, marker())));
  const metrics = createLegacyScanMetrics();
  metrics.lines = 10;
  assert.deepEqual(await Promise.all(nodes.map(node => scanLegacyParent(node, metrics))), Array(4).fill("parent"));
  assert.deepEqual(metrics, { bytesRead: 4 * Buffer.byteLength(marker()), lines: 14, candidateLines: 4, parsedLines: 4 });
  assert.deepEqual(createLegacyScanMetrics(), { bytesRead: 0, lines: 0, candidateLines: 0, parsedLines: 0 });
});

test("errors after partial reads propagate rather than returning no relation", async (t) => {
  const node = await fixture(t, message("ordinary".repeat(100)) + "\n" + marker());
  const original = fs.createReadStream;
  const failure = new Error("injected read failure");
  let opened;
  t.mock.method(fs, "createReadStream", (path, options) => {
    opened = original(path, { ...options, highWaterMark: 16 });
    opened.once("data", () => opened.destroy(failure));
    return opened;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(scanLegacyParent(node), error => error === failure);
  assert.equal(opened.destroyed, true);
});

test("core returns only minimal validation metadata, never arbitrary task/body fields", async (t) => {
  const entry = JSON.parse(marker());
  entry.body = "private body".repeat(10000);
  entry.data.task = "private task".repeat(10000);
  entry.data.resourceSnapshot = { arbitrary: "private snapshot" };
  entry.data.parentSessionPath = "private path";
  const node = await fixture(t, JSON.stringify(entry));
  assert.deepEqual(await scanLegacyEntry(node), {
    type: "custom", customType: "pi-web:subagent",
    data: { version: 1, parentSessionId: "parent", parentSessionPath: "" },
  });
});

test("minimal core metadata preserves every existing validator condition", async (t) => {
  const { readSubagentRun } = await jiti.import("./subagents.ts");
  const valid = JSON.parse(marker()).data;
  const variants = [undefined, null, [], "body", 7, false, {}, valid,
    { ...valid, parentSessionId: "" }, { ...valid, parentSessionPath: "" }];
  for (const field of ["version", "parentSessionId", "parentSessionPath"]) {
    for (const value of [undefined, null, {}, [], false, 999, "1"]) {
      variants.push({ ...valid, [field]: value });
    }
  }
  for (const data of variants) {
    const entry = { type: "custom", customType: "pi-web:subagent", data };
    const node = await fixture(t, JSON.stringify(entry) + "\n" + marker("later"));
    const expected = readSubagentRun([entry], node.id, node.path);
    const minimal = await scanLegacyEntry(node);
    const actual = readSubagentRun([minimal], node.id, node.path);
    assert.equal(actual?.parentSessionId, expected?.parentSessionId);
    assert.equal(actual === null, expected === null);
    if (expected) assert.equal(await scanLegacyParent(node), expected.parentSessionId);
    else await assert.rejects(scanLegacyParent(node), /Cannot safely identify a related subagent session/);
  }
});

test("file open errors propagate and destroy the stream", async (t) => {
  const node = await fixture(t, "");
  await rm(node.path);
  const streams = chunkSize(t, 16);
  await assert.rejects(scanLegacyParent(node), { code: "ENOENT" });
  assert.equal(streams[0].destroyed, true);
});
