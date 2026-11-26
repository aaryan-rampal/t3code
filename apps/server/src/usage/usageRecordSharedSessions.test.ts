import { assert, describe, it } from "@effect/vitest";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";

import {
  applySharedSessionOccurrenceKey,
  findSharedSessionIds,
} from "./usageRecordSharedSessions.ts";

function record(sessionId: string, timestampMs: number): UsageRecord {
  return {
    provider: "codex",
    timestampMs,
    model: "gpt-5",
    sessionId,
    totals: {
      uncachedInputTokens: 10,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 5,
      reasoningTokens: 0,
    },
    reportedCostUsd: null,
    speed: "standard",
    dedupeKey: null,
  };
}

describe("shared session dedupe", () => {
  it("keys moved copies by per-file occurrence so they deduplicate across files", () => {
    const files = [
      { records: [record("moved", 1), record("local", 2)] },
      { records: [record("moved", 1)] },
    ];
    const shared = findSharedSessionIds(files, new Set(["codex"]));

    assert.deepStrictEqual([...shared], ["moved"]);
    const first = applySharedSessionOccurrenceKey(record("moved", 1), new Map());
    const second = applySharedSessionOccurrenceKey(record("moved", 1), new Map());
    assert.strictEqual(first.dedupeKey, second.dedupeKey);
    assert.isString(first.dedupeKey);
  });

  it("keeps repeated equal events inside one file distinct", () => {
    const occurrences = new Map<string, number>();
    const first = applySharedSessionOccurrenceKey(record("moved", 1), occurrences);
    const second = applySharedSessionOccurrenceKey(record("moved", 1), occurrences);

    assert.notStrictEqual(first.dedupeKey, second.dedupeKey);
    assert.match(first.dedupeKey!, /:1$/);
    assert.match(second.dedupeKey!, /:2$/);
  });

  it("leaves a single-file session keyless", () => {
    const shared = findSharedSessionIds([{ records: [record("local", 1)] }], new Set(["codex"]));
    assert.strictEqual(shared.size, 0);
  });
});
