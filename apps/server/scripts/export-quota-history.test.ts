import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { Command } from "effect/cli";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  dedupeUsageRecords,
  exportQuotaHistory,
  type QuotaHistoryExport,
} from "../src/usage/QuotaHistoryExport.ts";
import {
  encodeQuotaHistoryRecord,
  quotaHistoryFilePath,
  type QuotaHistoryReading,
} from "../src/usage/QuotaHistoryRecorder.ts";
import {
  exportCommand,
  readClaudeTokens,
  readCodexTokens,
  runExport,
} from "./export-quota-history.ts";

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

const claudeTranscript = [
  // Repeated assistant content-block records share message.id + requestId.
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-11-25T10:01:00.000Z",
    sessionId: "claude-session-1",
    requestId: "req_1",
    message: {
      id: "msg_1",
      model: "claude-opus-5-5",
      content: [{ type: "thinking" }],
      usage: {
        input_tokens: 4,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 500,
        output_tokens: 10,
      },
    },
  }),
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-11-25T10:01:01.000Z",
    sessionId: "claude-session-1",
    requestId: "req_1",
    message: {
      id: "msg_1",
      model: "claude-opus-5-5",
      content: [{ type: "text" }],
      usage: {
        input_tokens: 4,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 600,
        output_tokens: 80,
        iterations: [
          {
            type: "advisor_message",
            model: "claude-fable-5-1",
            input_tokens: 200,
            cache_read_input_tokens: 50,
            cache_creation_input_tokens: 25,
            output_tokens: 30,
          },
        ],
      },
    },
  }),
  // Local <synthetic> placeholders must be skipped.
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-11-25T10:02:00.000Z",
    sessionId: "claude-session-1",
    requestId: "req_syn",
    message: {
      id: "msg_syn",
      model: "<synthetic>",
      content: [{ type: "text" }],
      usage: {
        input_tokens: 999,
        output_tokens: 999,
      },
    },
  }),
].join("\n");

it.effect(
  "reads Claude transcripts, skips <synthetic>, dedupes repeated content blocks by max-per-channel, preserves advisor iterations and joins with quota history",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectsDir = yield* fs.makeTempDirectoryScoped({ prefix: "quota-history-claude-" });
      const projectSubdir = path.join(projectsDir, "-Users-dev-repo");
      yield* fs.makeDirectory(projectSubdir, { recursive: true });
      yield* fs.writeFileString(
        path.join(projectSubdir, "claude-session-1.jsonl"),
        `${claudeTranscript}\n`,
      );

      const read = yield* readClaudeTokens([projectsDir], 0);
      assert.strictEqual(read.files, 1);
      assert.strictEqual(read.failures, 0);
      // 2 executor content-block records + 1 advisor iteration record (with <synthetic> skipped).
      assert.strictEqual(read.records.length, 3);
      assert.isFalse(read.records.some((record) => record.model === "<synthetic>"));

      const deduped = dedupeUsageRecords(read.records);
      assert.strictEqual(deduped.records.length, 2);
      assert.strictEqual(deduped.dropped, 1);

      const executor = deduped.records.find((record) => record.model === "claude-opus-5-5");
      const advisor = deduped.records.find((record) => record.model === "claude-fable-5-1");
      assert.deepStrictEqual(executor?.totals, {
        uncachedInputTokens: 4,
        cachedInputTokens: 1000,
        cacheCreationTokens: 600,
        outputTokens: 80,
        reasoningTokens: 0,
      });
      assert.deepStrictEqual(advisor?.totals, {
        uncachedInputTokens: 200,
        cachedInputTokens: 50,
        cacheCreationTokens: 25,
        outputTokens: 30,
        reasoningTokens: 0,
      });

      const readings: ReadonlyArray<QuotaHistoryReading> = [
        {
          version: 1,
          kind: "reading",
          observedAt: "2026-11-25T10:00:00.000Z",
          providerInstanceId: "claudeAgent",
          driver: "claudeAgent",
          accountKey: "org-claude",
          source: "probe",
          checkedAt: "2026-11-25T10:00:00.000Z",
          windows: [
            {
              id: "five_hour",
              kind: "session",
              label: "Session",
              usedPercent: 10,
              meter: "upstream",
            },
            {
              id: "seven_day_fable",
              kind: "weekly",
              label: "Weekly · Fable",
              usedPercent: 20,
              meter: "upstream",
            },
          ],
        },
        {
          version: 1,
          kind: "reading",
          observedAt: "2026-11-25T10:05:00.000Z",
          providerInstanceId: "claudeAgent",
          driver: "claudeAgent",
          accountKey: "org-claude",
          source: "probe",
          checkedAt: "2026-11-25T10:05:00.000Z",
          windows: [
            {
              id: "five_hour",
              kind: "session",
              label: "Session",
              usedPercent: 15,
              meter: "upstream",
            },
            {
              id: "seven_day_fable",
              kind: "weekly",
              label: "Weekly · Fable",
              usedPercent: 22,
              meter: "upstream",
            },
          ],
        },
      ];

      const exported = exportQuotaHistory({ records: readings, tokens: read.records });
      assert.strictEqual(exported.tokenRecords, 2);
      assert.strictEqual(exported.duplicateTokenRecords, 1);

      const fiveHour = exported.buckets.find((bucket) => bucket.bucketId === "five_hour")!;
      assert.deepStrictEqual(fiveHour.intervals[0]?.tokenTotals, {
        uncachedInputTokens: 204,
        cachedInputTokens: 1050,
        cacheCreationTokens: 625,
        outputTokens: 110,
        reasoningTokens: 0,
      });

      const sevenDayFable = exported.buckets.find(
        (bucket) => bucket.bucketId === "seven_day_fable",
      )!;
      assert.deepStrictEqual(
        sevenDayFable.intervals[0]?.tokens.map((group) => group.model),
        ["claude-fable-5-1"],
      );

      // Verify end-to-end runExport wiring with --claude-projects and NDJSON logs.
      const emptyRoot = yield* fs.makeTempDirectoryScoped({ prefix: "quota-history-empty-" });
      const logsDir = yield* fs.makeTempDirectoryScoped({ prefix: "quota-history-logs-" });
      const logFile = quotaHistoryFilePath(logsDir, "2026-11-25T10:00:00.000Z");
      yield* fs.writeFileString(
        logFile,
        `${readings.map((entry) => encodeQuotaHistoryRecord(entry)).join("\n")}\n`,
      );
      const outputFile = path.join(logsDir, "exported.json");
      const cliExported = yield* runExport({
        logsDir,
        codexSessions: [emptyRoot],
        claudeProjects: [projectsDir],
        antigravityData: [emptyRoot],
        opencodeData: [emptyRoot],
        stateDir: undefined,
        since: undefined,
        until: undefined,
        output: outputFile,
      });
      assert.strictEqual(cliExported.tokenRecords, 2);
      assert.strictEqual(cliExported.duplicateTokenRecords, 1);
      assert.strictEqual(cliExported.buckets.length, 2);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "deduplicates canonical file paths across overlapping Claude roots without dropping distinct copied files",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootA = yield* fs.makeTempDirectoryScoped({ prefix: "quota-history-claude-overlap-" });
      const subdir = path.join(rootA, "project-sub");
      const rootB = yield* fs.makeTempDirectoryScoped({ prefix: "quota-history-claude-copy-" });
      yield* fs.makeDirectory(subdir, { recursive: true });

      // Keyless record (no message.id / requestId => dedupeKey: null) must not double-count across overlapping roots.
      const keylessLine = JSON.stringify({
        type: "assistant",
        timestamp: "2026-11-25T10:01:00.000Z",
        sessionId: "claude-keyless-session",
        message: {
          model: "claude-opus-5-5",
          content: [{ type: "text" }],
          usage: { input_tokens: 11, output_tokens: 7 },
        },
      });
      yield* fs.writeFileString(path.join(subdir, "keyless.jsonl"), `${keylessLine}\n`);

      // Overlapping parent + child + symlink should read the canonical file exactly once.
      const symlinkRoot = path.join(rootB, "symlinked-subdir");
      yield* fs.symlink(subdir, symlinkRoot);
      const overlapping = yield* readClaudeTokens([rootA, subdir, symlinkRoot], 0);
      assert.strictEqual(overlapping.files, 1);
      assert.strictEqual(overlapping.records.length, 1);
      assert.isNull(overlapping.records[0]?.dedupeKey);

      // Copied keyed transcript across distinct files deduplicates via dedupeUsageRecords.
      yield* fs.writeFileString(path.join(rootB, "copy.jsonl"), `${claudeTranscript}\n`);
      yield* fs.writeFileString(path.join(subdir, "orig.jsonl"), `${claudeTranscript}\n`);
      const copied = yield* readClaudeTokens([subdir, rootB], 0);
      const deduped = dedupeUsageRecords(copied.records);
      assert.strictEqual(deduped.records.length, 3);
      assert.strictEqual(deduped.records.filter((r) => r.dedupeKey === null).length, 1);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("appends >150,000 transcript records without hitting argument spread limits", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const projectsDir = yield* fs.makeTempDirectoryScoped({
      prefix: "quota-history-claude-large-",
    });
    const count = 155_000;
    const lines = Array.from({ length: count }, (_, index) =>
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-11-25T10:01:00.000Z",
        sessionId: "large-session",
        requestId: `req_${index}`,
        message: {
          id: `msg_${index}`,
          model: "claude-opus-5-5",
          content: [{ type: "text" }],
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      }),
    );
    yield* fs.writeFileString(path.join(projectsDir, "large.jsonl"), `${lines.join("\n")}\n`);

    const read = yield* readClaudeTokens([projectsDir], 0);
    assert.strictEqual(read.files, 1);
    assert.strictEqual(read.failures, 0);
    assert.strictEqual(read.records.length, count);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "parses CLI flags (--claude-projects dirA,dirB with ~ expansion) and resolves CLAUDE_CONFIG_DIR defaults",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "quota-history-home-" });
      const dirA = path.join(home, "claude-a");
      const dirB = path.join(home, "claude-b");
      const emptyRoot = path.join(home, "empty");
      const logsDir = path.join(home, "logs");
      const claudeConfigDir = path.join(home, "custom-claude-config");
      const claudeConfigProjects = path.join(claudeConfigDir, "projects");

      yield* fs.makeDirectory(dirA, { recursive: true });
      yield* fs.makeDirectory(dirB, { recursive: true });
      yield* fs.makeDirectory(emptyRoot, { recursive: true });
      yield* fs.makeDirectory(logsDir, { recursive: true });
      yield* fs.makeDirectory(claudeConfigProjects, { recursive: true });

      const makeLine = (req: string, inputTokens: number) =>
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-11-25T10:01:00.000Z",
          sessionId: "cli-session",
          requestId: req,
          message: {
            id: `msg_${req}`,
            model: "claude-opus-5-5",
            content: [{ type: "text" }],
            usage: { input_tokens: inputTokens, output_tokens: 1 },
          },
        });

      yield* fs.writeFileString(path.join(dirA, "a.jsonl"), `${makeLine("r1", 10)}\n`);
      yield* fs.writeFileString(path.join(dirB, "b.jsonl"), `${makeLine("r2", 20)}\n`);
      yield* fs.writeFileString(
        path.join(claudeConfigProjects, "c.jsonl"),
        `${makeLine("r3", 30)}\n`,
      );

      const readings: ReadonlyArray<QuotaHistoryReading> = [
        {
          version: 1,
          kind: "reading",
          observedAt: "2026-11-25T10:00:00.000Z",
          providerInstanceId: "claudeAgent",
          driver: "claudeAgent",
          accountKey: "org-claude",
          source: "probe",
          checkedAt: "2026-11-25T10:00:00.000Z",
          windows: [
            {
              id: "five_hour",
              kind: "session",
              label: "Session",
              usedPercent: 10,
              meter: "upstream",
            },
          ],
        },
        {
          version: 1,
          kind: "reading",
          observedAt: "2026-11-25T10:05:00.000Z",
          providerInstanceId: "claudeAgent",
          driver: "claudeAgent",
          accountKey: "org-claude",
          source: "probe",
          checkedAt: "2026-11-25T10:05:00.000Z",
          windows: [
            {
              id: "five_hour",
              kind: "session",
              label: "Session",
              usedPercent: 20,
              meter: "upstream",
            },
          ],
        },
      ];
      yield* fs.writeFileString(
        quotaHistoryFilePath(logsDir, "2026-11-25T10:00:00.000Z"),
        `${readings.map((entry) => encodeQuotaHistoryRecord(entry)).join("\n")}\n`,
      );

      const runCli = (args: ReadonlyArray<string>, env: NodeJS.ProcessEnv = process.env) =>
        Command.runWith(exportCommand, { version: "0.0.0" })(args).pipe(
          Effect.provideService(HostProcess.HomeDirectory, home),
          Effect.provideService(HostProcess.Environment, env),
        );

      const explicitOutput = path.join(home, "explicit.json");
      yield* runCli([
        "--logs-dir",
        logsDir,
        "--claude-projects",
        `~/claude-a,${dirB}`,
        "--codex-sessions",
        emptyRoot,
        "--antigravity-data",
        emptyRoot,
        "--opencode-data",
        emptyRoot,
        "--output",
        explicitOutput,
      ]);
      const explicitJson = JSON.parse(
        yield* fs.readFileString(explicitOutput),
      ) as QuotaHistoryExport;
      assert.strictEqual(explicitJson.tokenRecords, 2);
      assert.strictEqual(explicitJson.buckets[0]?.totals.tokenTotals.uncachedInputTokens, 30);

      const defaultOutput = path.join(home, "default-claude-config-dir.json");
      yield* runCli(
        [
          "--logs-dir",
          logsDir,
          "--codex-sessions",
          emptyRoot,
          "--antigravity-data",
          emptyRoot,
          "--opencode-data",
          emptyRoot,
          "--output",
          defaultOutput,
        ],
        { ...process.env, CLAUDE_CONFIG_DIR: "~/custom-claude-config" },
      );
      const defaultJson = JSON.parse(yield* fs.readFileString(defaultOutput)) as QuotaHistoryExport;
      assert.strictEqual(defaultJson.tokenRecords, 1);
      assert.strictEqual(defaultJson.buckets[0]?.totals.tokenTotals.uncachedInputTokens, 30);
    }).pipe(Effect.provide(NodeServices.layer)),
);
