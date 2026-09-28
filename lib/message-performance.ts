import type { AssistantMessage } from "./types";

/** SDK-observed request timing, not provider-side token timestamps. */
export interface MessagePerformance {
  version: 1;
  ttftMs: number | null;
  generationMs: number | null;
  totalMs: number;
}

export interface PerformanceTotals {
  ttftSamples: number;
  ttftMs: number;
  speedSamples: number;
  outputTokens: number;
  generationMs: number;
}

export function emptyPerformanceTotals(): PerformanceTotals {
  return { ttftSamples: 0, ttftMs: 0, speedSamples: 0, outputTokens: 0, generationMs: 0 };
}

export function readMessagePerformance(value: unknown): MessagePerformance | undefined {
  if (!value || typeof value !== "object") return undefined;
  const timing = value as MessagePerformance;
  const validMs = (ms: unknown): ms is number => typeof ms === "number" && Number.isFinite(ms) && ms >= 0;
  if (timing.version !== 1 || !validMs(timing.totalMs)) return undefined;
  if (timing.ttftMs === null && timing.generationMs === null) return timing;
  if (!validMs(timing.ttftMs) || !validMs(timing.generationMs)) return undefined;
  if (Math.abs(timing.ttftMs + timing.generationMs - timing.totalMs) > 1) return undefined;
  return timing;
}

export function messageTokensPerSecond(message: AssistantMessage): number | undefined {
  const timing = readMessagePerformance(message.piWebPerformance);
  const output = message.usage?.output;
  if (!isSuccessfulResponse(message) || !timing || timing.generationMs === null || timing.generationMs <= 0
    || typeof output !== "number" || !Number.isFinite(output) || output < 0) return undefined;
  return output * 1000 / timing.generationMs;
}

function isSuccessfulResponse(message: AssistantMessage): boolean {
  return message.stopReason === "stop" || message.stopReason === "toolUse" || message.stopReason === "length";
}

export function addMessagePerformance(totals: PerformanceTotals, message: AssistantMessage): void {
  const timing = readMessagePerformance(message.piWebPerformance);
  if (!isSuccessfulResponse(message) || !timing || timing.ttftMs === null) return;
  totals.ttftSamples += 1;
  totals.ttftMs += timing.ttftMs;
  if (messageTokensPerSecond(message) !== undefined) {
    totals.speedSamples += 1;
    totals.outputTokens += message.usage!.output;
    totals.generationMs += timing.generationMs!;
  }
}

export function averagePerformance(totals: PerformanceTotals | undefined): {
  ttftMs?: number;
  tokensPerSecond?: number;
} {
  if (!totals) return {};
  return {
    ...(totals.ttftSamples > 0 ? { ttftMs: totals.ttftMs / totals.ttftSamples } : {}),
    ...(totals.speedSamples > 0 && totals.generationMs > 0
      ? { tokensPerSecond: totals.outputTokens * 1000 / totals.generationMs } : {}),
  };
}
