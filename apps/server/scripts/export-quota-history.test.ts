import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { dedupeUsageRecords } from "../src/usage/QuotaHistoryExport.ts";
import { readCodexTokens } from "./export-quota-history.ts";

const session = "019fbbc1-b12c-7360-a685-28c181f0025f";
const transcript = [
  JSON.stringify({
    type: "session_meta",
    timestamp: "2026-08-01T05:17:41.289Z",
    payload: { type: "session_meta", id: session },
  }),
  JSON.stringify({
    type: "turn_context",
    timestamp: "2026-08-01T05:17:42.694Z",
    payload: { type: "turn_context", model: "gpt-5.6-sol" },
  }),
  JSON.stringify({
    type: "event_msg",
    timestamp: "2026-08-01T05:17:49.919Z",
    payload: {
      type: "token_count",
      info: {
        last_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 20,
          cache_write_input_tokens: 0,
          output_tokens: 10,
          reasoning_output_tokens: 2,
        },
      },
    },
  }),
].join("\n");

it.effect("keys a Codex session copied across roots so it deduplicates once", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const first = yield* fs.makeTempDirectoryScoped({ prefix: "quota-history-codex-a-" });
    const second = yield* fs.makeTempDirectoryScoped({ prefix: "quota-history-codex-b-" });
    const fileName = `rollout-2026-08-01T05-17-41-${session}.jsonl`;
    yield* fs.writeFileString(path.join(first, fileName), `${transcript}\n`);
    yield* fs.writeFileString(path.join(second, fileName), `${transcript}\n`);

    const read = yield* readCodexTokens([first, second], 0);
    assert.strictEqual(read.files, 2);
    assert.strictEqual(read.records.length, 2);
    assert.isString(read.records[0]?.dedupeKey);
    assert.strictEqual(read.records[0]?.dedupeKey, read.records[1]?.dedupeKey);

    const deduped = dedupeUsageRecords(read.records);
    assert.strictEqual(deduped.records.length, 1);
    assert.strictEqual(deduped.dropped, 1);
    assert.strictEqual(deduped.records[0]?.totals.outputTokens, 10);
  }).pipe(Effect.provide(NodeServices.layer)),
);
