/**
 * Detects provider stop turns that contain no assistant-visible content.
 */
import { hasNonzeroUsage, normalizeUsage, type UsageLike } from "../usage.js";

type EmptyAssistantTurnLike = {
  content?: unknown;
  stopReason?: unknown;
  usage?: unknown;
};

// Upstream agent runtimes should normalize Anthropic zero-token empty `stop`
// turns before OpenClaw sees them. Downstream: openclaw/openclaw#71880.
function hasZeroTokenUsageSnapshot(usage: unknown): boolean {
  const normalized = normalizeUsage(usage as UsageLike | null | undefined);
  if (!normalized) {
    return false;
  }
  // Anthropic can report unavailable context telemetry alongside explicit zero buckets.
  const tokenUsage =
    normalized.contextUsage?.state === "unavailable"
      ? { ...normalized, contextUsage: undefined }
      : normalized;
  const hasObservedTokenBucket =
    Object.values(tokenUsage).some((value) => typeof value === "number") ||
    tokenUsage.contextUsage?.state === "available";
  return hasObservedTokenBucket && !hasNonzeroUsage(tokenUsage);
}

export function isZeroUsageEmptyStopAssistantTurn(message: EmptyAssistantTurnLike | null): boolean {
  return Boolean(
    message &&
    message.stopReason === "stop" &&
    Array.isArray(message.content) &&
    message.content.length === 0 &&
    hasZeroTokenUsageSnapshot(message.usage),
  );
}
