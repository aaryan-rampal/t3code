import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { readQuotaHistoryRunAttribution } from "./QuotaHistoryRuns.ts";

const codexSession = "019fbbc1-b12c-7360-a685-28c181f0025f";
const antigravitySession = "3f2c0ba1-1f82-4c4c-9a3c-0c5f43fbc6d8";
const codexProviderThread = `provider-thread:provider:codex:native-thread:${codexSession}`;
const antigravityProviderThread = `provider-thread:provider:antigravity:provider-instance:antigravity:native-thread:${antigravitySession}`;

const writeProjection = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.unsafe(`
    CREATE TABLE orchestration_v2_projection_provider_turns (
      provider_thread_id TEXT,
      thread_id TEXT,
      run_attempt_id TEXT,
      payload_json TEXT
    )
  `);
  yield* sql.unsafe(`
    CREATE TABLE orchestration_v2_projection_provider_threads (
      provider_thread_id TEXT PRIMARY KEY,
      thread_id TEXT,
      payload_json TEXT
    )
  `);
  yield* sql.unsafe(`
    CREATE TABLE orchestration_v2_projection_run_attempts (
      attempt_id TEXT,
      thread_id TEXT,
      provider_thread_id TEXT,
      run_id TEXT,
      payload_json TEXT
    )
  `);
  // Codex writes the native session on the attempt; the derived provider thread id
  // is T3's own id, not the session the token reader reports.
  yield* sql.unsafe(
    `INSERT INTO orchestration_v2_projection_run_attempts VALUES ('attempt-1', 'thread-1', '${codexProviderThread}', 'run-1', '{"nativeThreadId":"${codexSession}"}')`,
  );
  // Antigravity attempts omit nativeThreadId; the native conversation id is on the provider thread.
  yield* sql.unsafe(
    `INSERT INTO orchestration_v2_projection_run_attempts VALUES ('attempt-2', 'thread-2', '${antigravityProviderThread}', 'run-2', '{}')`,
  );
  yield* sql.unsafe(
    `INSERT INTO orchestration_v2_projection_provider_threads VALUES ('${codexProviderThread}', 'thread-1', '{"nativeThreadRef":{"driver":"codex","nativeId":"${codexSession}","strength":"strong"}}')`,
  );
  yield* sql.unsafe(
    `INSERT INTO orchestration_v2_projection_provider_threads VALUES ('${antigravityProviderThread}', 'thread-2', '{"nativeThreadRef":{"driver":"antigravity","nativeId":"${antigravitySession}","strength":"strong"}}')`,
  );
  yield* sql.unsafe(
    `INSERT INTO orchestration_v2_projection_provider_turns VALUES ('${codexProviderThread}', 'thread-1', 'attempt-1', '{"nativeTurnRef":{"nativeId":"turn-1"}}')`,
  );
  yield* sql.unsafe(
    `INSERT INTO orchestration_v2_projection_provider_turns VALUES ('${antigravityProviderThread}', 'thread-2', 'attempt-2', '{"nativeTurnRef":{"nativeId":"turn-2a"}}')`,
  );
  yield* sql.unsafe(
    `INSERT INTO orchestration_v2_projection_provider_turns VALUES ('${antigravityProviderThread}', 'thread-2', 'attempt-2', '{"nativeTurnRef":{"nativeId":"turn-2b"}}')`,
  );
});

it.effect("maps native sessions to T3 runs and marks multi-turn sessions uncertain", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "quota-history-runs-" });
    const dbPath = path.join(dir, "statev2.sqlite");
    yield* writeProjection.pipe(
      Effect.provide(
        Layer.mergeAll(NodeSqliteClient.layer({ filename: dbPath }), NodeServices.layer),
      ),
    );

    const attribution = yield* readQuotaHistoryRunAttribution(dbPath);
    assert.deepStrictEqual(attribution.get(codexSession), {
      runIds: ["run-1"],
      threadIds: ["thread-1"],
      nativeRunIds: ["turn-1"],
      uncertain: false,
    });
    assert.deepStrictEqual(attribution.get(antigravitySession), {
      runIds: ["run-2"],
      threadIds: ["thread-2"],
      nativeRunIds: ["turn-2a", "turn-2b"],
      uncertain: true,
    });
  }).pipe(Effect.provide(NodeServices.layer)),
);
