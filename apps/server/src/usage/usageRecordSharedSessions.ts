import type { UsageProviderKind } from "@t3tools/contracts";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";

/**
 * Finds sessions that appear in more than one file, so copies of the same request
 * (a moved rollout, or `.jsonl` beside `.jsonl.zst`) are deduplicated across files.
 */
export function findSharedSessionIds(
  files: ReadonlyArray<{ readonly records: ReadonlyArray<UsageRecord> }>,
  sharedProviders: ReadonlySet<UsageProviderKind>,
): ReadonlySet<string> {
  const firstFile = new Map<string, number>();
  const shared = new Set<string>();
  for (const [index, file] of files.entries()) {
    let previous = "";
    for (const { provider, sessionId } of file.records) {
      if (!sharedProviders.has(provider) || sessionId === previous || sessionId.length === 0) {
        continue;
      }
      previous = sessionId;
      const first = firstFile.get(sessionId);
      if (first === undefined) firstFile.set(sessionId, index);
      else if (first !== index) shared.add(sessionId);
    }
  }
  return shared;
}

/**
 * Adds a per-file occurrence to a shared session's key so moved copies merge while
 * repeated equal events inside one file stay separate.
 */
export function applySharedSessionOccurrenceKey(
  record: UsageRecord,
  occurrences: Map<string, number>,
): UsageRecord {
  const key = JSON.stringify([
    record.provider,
    record.sessionId,
    record.timestampMs,
    record.model,
    record.totals,
  ]);
  const occurrence = (occurrences.get(key) ?? 0) + 1;
  occurrences.set(key, occurrence);
  return { ...record, dedupeKey: `${key}:${occurrence}` };
}
