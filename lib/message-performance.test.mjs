import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { averagePerformance, readMessagePerformance, messageTokensPerSecond } = await jiti.import("./message-performance.ts");
const { computeSessionStats, mergeSessionStats } = await jiti.import("./session-stats.ts");

function message(output, ttftMs, generationMs, stopReason = "stop") {
  return {
    role: "assistant", provider: "test", model: "test", content: [], stopReason,
    usage: { input: 0, output, cacheRead: 0, cacheWrite: 0 },
    piWebPerformance: { version: 1, ttftMs, generationMs, totalMs: ttftMs + generationMs },
  };
}
function entries(messages) {
  return messages.map((message, index) => ({ type: "message", id: String(index), parentId: index ? String(index - 1) : null, message }));
}

test("speed is token/time weighted; TTFT is request weighted", () => {
  const a = message(100, 1000, 1000);
  const b = message(900, 3000, 30000, "toolUse");
  const stats = computeSessionStats(entries([a, b]));
  assert.deepEqual(stats.performance, { ttftSamples: 2, ttftMs: 4000, speedSamples: 2, outputTokens: 1000, generationMs: 31000 });
  assert.deepEqual(averagePerformance(stats.performance), { ttftMs: 2000, tokensPerSecond: 1000 / 31 });
  assert.equal(messageTokensPerSecond(a), 100);
});

test("missing timing, failed, aborted, deferred and pending samples are excluded", () => {
  const legacy = message(100, 100, 1000);
  delete legacy.piWebPerformance;
  const noDelta = message(100, null, null);
  noDelta.piWebPerformance.totalMs = 1000;
  const skipped = [legacy, noDelta, ...["error", "aborted", "deferred", "pending"].map((reason) => message(100, 100, 1000, reason))];
  assert.equal(computeSessionStats(entries(skipped)).performance, undefined);
  assert.deepEqual(averagePerformance(undefined), {});
  assert.equal(messageTokensPerSecond(legacy), undefined);
});

test("zero TTFT is valid, zero duration/missing output has TTFT but no speed", () => {
  const zeroDuration = message(100, 0, 0, "length");
  const missingUsage = message(100, 200, 1000);
  delete missingUsage.usage;
  const zeroOutput = message(0, 400, 1000);
  const stats = computeSessionStats(entries([zeroDuration, missingUsage, zeroOutput]));
  assert.deepEqual(stats.performance, { ttftSamples: 3, ttftMs: 600, speedSamples: 1, outputTokens: 0, generationMs: 1000 });
  assert.deepEqual(averagePerformance(stats.performance), { ttftMs: 200, tokensPerSecond: 0 });
  const withOutput = computeSessionStats(entries([zeroOutput, message(100, 400, 1000)]));
  assert.equal(averagePerformance(withOutput.performance).tokensPerSecond, 50, "zero output still contributes its measured duration");
  assert.equal(messageTokensPerSecond(zeroDuration), undefined);
});

test("malformed and future timing values cannot poison aggregate stats", () => {
  const valid = message(100, 100, 1000).piWebPerformance;
  for (const invalid of [null, {}, { ...valid, version: 2 }, { ...valid, ttftMs: NaN },
    { ...valid, generationMs: -1 }, { ...valid, totalMs: Infinity }, { ...valid, totalMs: 50 },
    { ...valid, ttftMs: null }]) {
    assert.equal(readMessagePerformance(invalid), undefined);
    const m = { ...message(100, 100, 1000), piWebPerformance: invalid };
    assert.equal(computeSessionStats(entries([m])).performance, undefined);
  }
  assert.equal(messageTokensPerSecond(message(Infinity, 100, 1000)), undefined);
});

test("live delta merges do not double-count on reload or lose compacted/other-branch samples", () => {
  const a = message(100, 100, 1000);
  const b = message(200, 200, 2000);
  const c = message(300, 300, 3000);
  const file = computeSessionStats(entries([a, b]));
  const merged = mergeSessionStats(file, [b], [b, c]);
  const refreshed = computeSessionStats(entries([a, b, c]));
  assert.deepEqual(merged, refreshed);
  assert.deepEqual(mergeSessionStats(refreshed, [c], [c]), refreshed);
  assert.deepEqual(mergeSessionStats(refreshed, [b, c], [a]), refreshed);
  assert.deepEqual(mergeSessionStats(undefined, [], [a, b, c]), refreshed);
});

test("only assistant requests contribute speed, not compaction or nested tool usage", () => {
  const m = message(100, 100, 1000);
  const file = entries([m]);
  file.push({ type: "compaction", usage: m.usage, piWebPerformance: m.piWebPerformance });
  file.push({ type: "message", message: { ...m, role: "toolResult" } });
  const stats = computeSessionStats(file);
  assert.equal(stats.performance.ttftSamples, 1);
  assert.equal(stats.performance.outputTokens, 100);
  assert.equal(stats.tokens.output, 300);
});
