import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type {
  QuotaHistoryRunAttribution,
  QuotaHistoryRunAttributionMap,
} from "./QuotaHistoryExport.ts";

export class QuotaHistoryRunAttributionError extends Schema.TaggedError<QuotaHistoryRunAttributionError>()(
  "QuotaHistoryRunAttributionError",
  { dbPath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not read T3 run attribution from ${this.dbPath}.`;
  }
}

/**
 * Reads T3's projection tables without writing, so exported token groups can name
 * the runs and native turns behind each provider session.
 */
const readRunAttribution = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly native_thread_id: string | null;
    readonly native_turn_id: string | null;
    readonly thread_id: string;
    readonly run_id: string | null;
  }>`
      SELECT COALESCE(
          json_extract(attempt.payload_json, '$.nativeThreadId'),
          json_extract(provider_thread.payload_json, '$.nativeThreadRef.nativeId')
        ) AS native_thread_id,
        json_extract(turn.payload_json, '$.nativeTurnRef.nativeId') AS native_turn_id,
        turn.thread_id AS thread_id,
        attempt.run_id AS run_id
      FROM orchestration_v2_projection_provider_turns AS turn
      LEFT JOIN orchestration_v2_projection_provider_threads AS provider_thread
        ON provider_thread.provider_thread_id = turn.provider_thread_id
      LEFT JOIN orchestration_v2_projection_run_attempts AS attempt
        ON attempt.attempt_id = turn.run_attempt_id
        AND attempt.thread_id = turn.thread_id
        AND attempt.provider_thread_id = turn.provider_thread_id
    `;

  interface SessionEntry {
    readonly runIds: Set<string>;
    readonly threadIds: Set<string>;
    readonly nativeRunIds: Set<string>;
  }
  const sessions = new Map<string, SessionEntry>();
  for (const row of rows) {
    const sessionId = row.native_thread_id?.trim();
    if (!sessionId) continue;
    const entry = sessions.get(sessionId) ?? {
      runIds: new Set<string>(),
      threadIds: new Set<string>(),
      nativeRunIds: new Set<string>(),
    };
    if (row.run_id) entry.runIds.add(row.run_id);
    if (row.thread_id) entry.threadIds.add(row.thread_id);
    if (row.native_turn_id) entry.nativeRunIds.add(row.native_turn_id);
    sessions.set(sessionId, entry);
  }

  const attribution = new Map<string, QuotaHistoryRunAttribution>();
  for (const [sessionId, entry] of sessions) {
    attribution.set(sessionId, {
      runIds: [...entry.runIds].toSorted(),
      threadIds: [...entry.threadIds].toSorted(),
      nativeRunIds: [...entry.nativeRunIds].toSorted(),
      // A token record names a session, not a turn, so several runs or turns cannot be picked.
      uncertain: entry.runIds.size !== 1 || entry.nativeRunIds.size > 1,
    });
  }
  return attribution satisfies QuotaHistoryRunAttributionMap;
});

export const readQuotaHistoryRunAttribution = (dbPath: string) =>
  readRunAttribution.pipe(
    Effect.provide(
      NodeSqliteClient.layer({ filename: dbPath, readonly: true, readerWorker: true }),
    ),
    Effect.mapError((cause) => new QuotaHistoryRunAttributionError({ dbPath, cause })),
    Effect.withSpan("readQuotaHistoryRunAttribution"),
  );
