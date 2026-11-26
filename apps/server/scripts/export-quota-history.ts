#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";
import { readOpenCodeUsage } from "@t3tools/provider-opencode/server/usage";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Command, Flag } from "effect/cli";
import * as Option from "effect/Option";

import { readAntigravityUsage } from "../src/provider/Drivers/antigravityUsageReader.ts";
import { claudeUsageFormat } from "../src/provider/Drivers/claudeUsage.ts";
import { codexUsageFormat } from "../src/provider/Drivers/codexUsage.ts";
import {
  exportQuotaHistory,
  type QuotaHistoryRunAttributionMap,
} from "../src/usage/QuotaHistoryExport.ts";
import {
  QUOTA_HISTORY_VERSION,
  type QuotaHistoryRecord,
} from "../src/usage/QuotaHistoryRecorder.ts";
import { readQuotaHistoryRunAttribution } from "../src/usage/QuotaHistoryRuns.ts";
import {
  applySharedSessionOccurrenceKey,
  findSharedSessionIds,
} from "../src/usage/usageRecordSharedSessions.ts";
import { listTranscriptFiles, readTranscriptRecords } from "../src/usage/usageTranscriptReader.ts";

class QuotaHistoryExportInputError extends Schema.TaggedError<QuotaHistoryExportInputError>()(
  "QuotaHistoryExportInputError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

interface QuotaLogRead {
  readonly records: ReadonlyArray<QuotaHistoryRecord>;
  readonly files: ReadonlyArray<string>;
  readonly malformedLines: number;
}

interface TokenRead {
  readonly records: ReadonlyArray<UsageRecord>;
  readonly files: number;
  readonly failures: number;
}

const quotaFileName = new RegExp(
  `^quota-history-v${QUOTA_HISTORY_VERSION}-\\d{4}-\\d{2}-\\d{2}\\.ndjson$`,
);
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function splitRoots(value: Option.Option<string>): ReadonlyArray<string> {
  return Option.match(value, {
    onNone: () => [],
    onSome: (text) =>
      text
        .split(",")
        .map((root) => root.trim())
        .filter((root) => root.length > 0),
  });
}

function normalizeBound(
  name: "since" | "until",
  value: Option.Option<string>,
): Effect.Effect<Option.Option<string>, QuotaHistoryExportInputError> {
  if (Option.isNone(value)) return Effect.succeedNone;
  // A date without a time includes its whole day: --until 2026-11-26 ends at 23:59:59.999Z.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value.value);
  const fallback = dateOnly
    ? `${value.value}T${name === "until" ? "23:59:59.999" : "00:00:00.000"}Z`
    : value.value;
  const parsed = dateOnly
    ? DateTime.make(fallback)
    : DateTime.make(value.value).pipe(Option.orElse(() => DateTime.make(fallback)));
  if (Option.isNone(parsed)) {
    return Effect.fail(
      new QuotaHistoryExportInputError({
        detail: `--${name} must be an ISO 8601 date or timestamp (received '${value.value}').`,
      }),
    );
  }
  return Effect.succeedSome(DateTime.formatIso(parsed.value));
}

const progress = Effect.fn("QuotaHistoryExport.progress")(function* (message: string) {
  const now = yield* Clock.currentTimeMillis;
  yield* Console.error(
    `[${DateTime.formatIso(DateTime.makeUnsafe(now))}] quota-history-export: ${message}`,
  );
});

const readQuotaLogs = Effect.fn("readQuotaLogs")(function* (logsDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = yield* fs.exists(logsDir).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return yield* new QuotaHistoryExportInputError({
      detail: `Quota history logs directory does not exist: ${logsDir}`,
    });
  }
  const files = (yield* fs.readDirectory(logsDir))
    .filter((name) => quotaFileName.test(name))
    .sort();
  const records: QuotaHistoryRecord[] = [];
  let malformedLines = 0;
  for (const name of files) {
    const content = yield* fs.readFileString(path.join(logsDir, name));
    for (const line of content.split("\n")) {
      if (line.trim().length === 0) continue;
      const parsed = decodeJson(line);
      if (Option.isNone(parsed)) {
        malformedLines += 1;
        continue;
      }
      const value = parsed.value;
      if (
        typeof value !== "object" ||
        value === null ||
        !("version" in value) ||
        value.version !== QUOTA_HISTORY_VERSION ||
        !("kind" in value) ||
        (value.kind !== "reading" && value.kind !== "gap")
      ) {
        malformedLines += 1;
        continue;
      }
      records.push(value as QuotaHistoryRecord);
    }
  }
  return { records, files, malformedLines } satisfies QuotaLogRead;
});

export const readCodexTokens = Effect.fn("readCodexTokens")(function* (
  sessionsDirs: ReadonlyArray<string>,
  sinceMs: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const readFiles: Array<{ readonly path: string; readonly records: ReadonlyArray<UsageRecord> }> =
    [];
  const seenPaths = new Set<string>();
  let fileCount = 0;
  let failures = 0;
  // A rollout can be present under more than one root, so shared-session detection
  // must see every root at once; per-root runs would leave both copies keyless.
  for (const sessionsDir of sessionsDirs) {
    const listed = yield* Effect.promise(() => listTranscriptFiles(sessionsDir, sinceMs));
    failures += listed.failedPaths;
    const files = listed.files.toSorted((left, right) => compareText(left.path, right.path));
    for (const file of files) {
      const canonicalPath = yield* fs
        .realPath(file.path)
        .pipe(Effect.orElseSucceed(() => path.resolve(file.path)));
      if (seenPaths.has(canonicalPath)) continue;
      seenPaths.add(canonicalPath);
      fileCount += 1;
      const parsed = yield* Effect.promise(() =>
        readTranscriptRecords(file.path, codexUsageFormat),
      );
      if (parsed === null) {
        failures += 1;
        continue;
      }
      const fileRecords: UsageRecord[] = [];
      for (const record of parsed.records) fileRecords.push(record);
      for (const record of parsed.tailRecords) fileRecords.push(record);
      readFiles.push({ path: canonicalPath, records: fileRecords });
    }
  }
  // A moved rollout can appear in two files, so Codex needs UsageService's cross-file
  // occurrence keys or the export double-counts it.
  const sharedSessions = findSharedSessionIds(readFiles, new Set(["codex"]));
  const records: UsageRecord[] = [];
  for (const file of readFiles) {
    const occurrences = new Map<string, number>();
    for (const record of file.records) {
      records.push(
        sharedSessions.has(record.sessionId)
          ? applySharedSessionOccurrenceKey(record, occurrences)
          : record,
      );
    }
  }
  return { records, files: fileCount, failures } satisfies TokenRead;
});

export const readClaudeTokens = Effect.fn("readClaudeTokens")(function* (
  projectsDirs: ReadonlyArray<string>,
  sinceMs: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const records: UsageRecord[] = [];
  const seenPaths = new Set<string>();
  let fileCount = 0;
  let failures = 0;
  for (const projectsDir of projectsDirs) {
    const listed = yield* Effect.promise(() => listTranscriptFiles(projectsDir, sinceMs));
    failures += listed.failedPaths;
    const files = listed.files.toSorted((left, right) => compareText(left.path, right.path));
    for (const file of files) {
      const canonicalPath = yield* fs
        .realPath(file.path)
        .pipe(Effect.orElseSucceed(() => path.resolve(file.path)));
      if (seenPaths.has(canonicalPath)) continue;
      seenPaths.add(canonicalPath);
      fileCount += 1;
      const parsed = yield* Effect.promise(() =>
        readTranscriptRecords(file.path, claudeUsageFormat),
      );
      if (parsed === null) {
        failures += 1;
        continue;
      }
      for (const record of parsed.records) records.push(record);
      for (const record of parsed.tailRecords) records.push(record);
    }
  }
  return { records, files: fileCount, failures } satisfies TokenRead;
});

const readAntigravityTokens = Effect.fn("readAntigravityTokens")(function* (
  directories: ReadonlyArray<string>,
  sinceMs: number,
) {
  const result = yield* readAntigravityUsage(directories, sinceMs);
  const records: UsageRecord[] = [];
  for (const file of result.files) {
    for (const record of file.records) records.push(record);
  }
  return {
    records,
    files: result.files.length,
    failures: result.errors.length,
  } satisfies TokenRead;
});

const readOpenCodeTokens = Effect.fn("readOpenCodeTokens")(function* (
  roots: ReadonlyArray<string>,
  sinceMs: number,
) {
  const records: UsageRecord[] = [];
  let files = 0;
  let failures = 0;
  for (const root of roots) {
    const result = yield* readOpenCodeUsage(root, sinceMs);
    files += result.files.length;
    if (result.error) failures += 1;
    for (const file of result.files) {
      for (const record of file.records) records.push(record);
    }
  }
  return { records, files, failures } satisfies TokenRead;
});

interface TokenRoots {
  readonly codexSessions: ReadonlyArray<string>;
  readonly claudeProjects: ReadonlyArray<string>;
  readonly antigravityData: ReadonlyArray<string>;
  readonly opencodeData: ReadonlyArray<string>;
}

const isDirectory = Effect.fn("isDirectory")(function* (path: Path.Path, target: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(target).pipe(Effect.orElseSucceed(() => null));
  return info?.type === "Directory" ? target : undefined;
});

/**
 * Resolves explicit roots plus T3-managed profiles, so a real export does not
 * silently skip Antigravity conversations under the state directory.
 */
const resolveTokenRoots = Effect.fn("resolveTokenRoots")(function* (input: {
  readonly explicit: {
    readonly codexSessions: ReadonlyArray<string>;
    readonly claudeProjects: ReadonlyArray<string>;
    readonly antigravityData: ReadonlyArray<string>;
    readonly opencodeData: ReadonlyArray<string>;
  };
  readonly stateDir: string | undefined;
}) {
  const home = yield* HostProcess.HomeDirectory;
  const env = yield* HostProcess.Environment;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const normalizeRoots = (roots: ReadonlyArray<string>) =>
    roots.map((root) => path.resolve(expandHomePath(root, home)));
  const environmentRoots = (value: string | undefined) =>
    normalizeRoots(
      (value ?? "")
        .split(",")
        .map((root) => root.trim())
        .filter(Boolean),
    );
  const existing = (roots: ReadonlyArray<string>) =>
    Effect.filter(roots, (root) =>
      isDirectory(path, root).pipe(Effect.map((resolved) => resolved !== undefined)),
    );
  // The provider readers walk `conversations` when it exists, so defaults must too.
  const preferConversations = (roots: ReadonlyArray<string>) =>
    Effect.forEach(roots, (root) =>
      Effect.gen(function* () {
        const nested = path.join(root, "conversations");
        return (yield* isDirectory(path, nested)) ?? root;
      }),
    );

  const managedAntigravity: string[] = [];
  if (input.stateDir !== undefined) {
    const root = path.join(input.stateDir, "providers", "antigravity");
    const entries = yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => [] as string[]));
    for (const entry of entries) {
      const acp = path.join(root, entry, "antigravity-acp");
      const conversations = path.join(acp, "conversations");
      const resolved = (yield* isDirectory(path, conversations)) ?? (yield* isDirectory(path, acp));
      if (resolved !== undefined) managedAntigravity.push(resolved);
    }
  }

  const antigravityEnvironmentRoots = environmentRoots(env["ANTIGRAVITY_DATA_DIR"]);
  const defaultAntigravity =
    antigravityEnvironmentRoots.length > 0
      ? antigravityEnvironmentRoots
      : defaultAntigravityRoots(home, path);
  const antigravityData =
    input.explicit.antigravityData.length > 0
      ? [...normalizeRoots(input.explicit.antigravityData), ...managedAntigravity]
      : [
          ...(yield* existing(yield* preferConversations(defaultAntigravity))),
          ...managedAntigravity,
        ];

  const codexHome = env["CODEX_HOME"]?.trim();
  const codexDefaultRoots = [
    codexHome
      ? path.join(path.resolve(expandHomePath(codexHome, home)), "sessions")
      : path.join(home, ".codex", "sessions"),
  ];
  const codexSessions =
    input.explicit.codexSessions.length > 0
      ? normalizeRoots(input.explicit.codexSessions)
      : yield* existing(codexDefaultRoots);

  const claudeConfigDir = env["CLAUDE_CONFIG_DIR"]?.trim();
  const claudeDefaultRoots = [
    path.join(
      claudeConfigDir
        ? path.resolve(expandHomePath(claudeConfigDir, home))
        : path.join(home, ".claude"),
      "projects",
    ),
  ];
  const claudeProjects =
    input.explicit.claudeProjects.length > 0
      ? normalizeRoots(input.explicit.claudeProjects)
      : yield* existing(claudeDefaultRoots);

  const opencodeEnvironmentRoots = environmentRoots(env["OPENCODE_DATA_DIR"]);
  const opencodeDefault =
    opencodeEnvironmentRoots.length > 0
      ? opencodeEnvironmentRoots
      : [path.join(env["XDG_DATA_HOME"]?.trim() || path.join(home, ".local", "share"), "opencode")];
  const opencodeData =
    input.explicit.opencodeData.length > 0
      ? normalizeRoots(input.explicit.opencodeData)
      : yield* existing(opencodeDefault);

  return {
    codexSessions,
    claudeProjects,
    antigravityData,
    opencodeData,
  } satisfies TokenRoots;
});

function defaultAntigravityRoots(home: string, path: Path.Path): ReadonlyArray<string> {
  return [
    ...["antigravity", "antigravity-cli", "antigravity-ide", "antigravity-backup"].map((name) =>
      path.join(home, ".gemini", name),
    ),
    path.join(home, ".config", "antigravity"),
  ];
}

function earliestCheckedAt(records: ReadonlyArray<QuotaHistoryRecord>): number | undefined {
  let earliest: number | undefined;
  for (const record of records) {
    if (record.kind !== "reading") continue;
    const time = Date.parse(record.checkedAt);
    if (Number.isNaN(time)) continue;
    if (earliest === undefined || time < earliest) earliest = time;
  }
  return earliest;
}

export const runExport = Effect.fn("runQuotaHistoryExport")(function* (input: {
  readonly logsDir: string;
  readonly codexSessions: ReadonlyArray<string>;
  readonly claudeProjects: ReadonlyArray<string>;
  readonly antigravityData: ReadonlyArray<string>;
  readonly opencodeData: ReadonlyArray<string>;
  readonly stateDir: string | undefined;
  readonly since: string | undefined;
  readonly until: string | undefined;
  readonly output: string | undefined;
}) {
  const startedAt = yield* Clock.currentTimeMillis;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  yield* progress(`reading quota history from ${input.logsDir}`);
  const logs = yield* readQuotaLogs(input.logsDir);
  yield* progress(
    `${logs.records.length} records from ${logs.files.length} files` +
      (logs.malformedLines === 0 ? "" : ` (${logs.malformedLines} malformed lines skipped)`),
  );

  const stateDir =
    input.stateDir ??
    (path.basename(input.logsDir) === "logs" ? path.dirname(input.logsDir) : undefined);
  const roots = yield* resolveTokenRoots({
    explicit: {
      codexSessions: input.codexSessions,
      claudeProjects: input.claudeProjects,
      antigravityData: input.antigravityData,
      opencodeData: input.opencodeData,
    },
    stateDir,
  });

  let runAttribution: QuotaHistoryRunAttributionMap | undefined;
  if (stateDir !== undefined) {
    const dbPath = path.join(stateDir, "statev2.sqlite");
    const dbExists = yield* fs.exists(dbPath).pipe(Effect.orElseSucceed(() => false));
    if (dbExists) {
      yield* progress(`reading T3 run attribution from ${dbPath}`);
      runAttribution = yield* readQuotaHistoryRunAttribution(dbPath).pipe(
        Effect.catch((cause) =>
          progress(`T3 run attribution unavailable: ${cause.message}`).pipe(Effect.as(undefined)),
        ),
      );
    } else if (input.stateDir !== undefined) {
      return yield* new QuotaHistoryExportInputError({
        detail: `T3 state database does not exist: ${dbPath}`,
      });
    } else {
      yield* progress(`T3 run attribution unavailable: ${dbPath} does not exist`);
    }
  }

  const sinceMs = input.since === undefined ? undefined : Date.parse(input.since);
  const untilMs = input.until === undefined ? undefined : Date.parse(input.until);
  const inWindow = (value: string) => {
    const time = Date.parse(value);
    return (
      !Number.isNaN(time) &&
      (sinceMs === undefined || time >= sinceMs) &&
      (untilMs === undefined || time <= untilMs)
    );
  };
  // A reading observed after --since can carry a checkedAt before it; its interval
  // starts there, so tokens must be read from the earliest checkedAt too.
  const readingSince = earliestCheckedAt(
    logs.records.filter((record) => record.kind === "reading" && inWindow(record.observedAt)),
  );
  const tokenSinceMs = [sinceMs, readingSince]
    .filter((time): time is number => time !== undefined && !Number.isNaN(time))
    .reduce<number | undefined>(
      (earliest, time) => (earliest === undefined || time < earliest ? time : earliest),
      undefined,
    );

  const tokens: UsageRecord[] = [];
  let tokenFiles = 0;
  let tokenFailures = 0;
  const collect = (result: TokenRead, label: string) => {
    for (const record of result.records) tokens.push(record);
    tokenFiles += result.files;
    tokenFailures += result.failures;
    return progress(
      `${label}: ${result.records.length} records from ${result.files} files` +
        (result.failures === 0 ? "" : ` (${result.failures} unreadable)`),
    );
  };

  if (tokenSinceMs !== undefined) {
    if (roots.codexSessions.length > 0) {
      yield* progress(`reading codex tokens from ${roots.codexSessions.join(", ")}`);
      yield* collect(yield* readCodexTokens(roots.codexSessions, tokenSinceMs), "codex");
    }
    if (roots.claudeProjects.length > 0) {
      yield* progress(`reading claude tokens from ${roots.claudeProjects.join(", ")}`);
      yield* collect(yield* readClaudeTokens(roots.claudeProjects, tokenSinceMs), "claude");
    }
    if (roots.antigravityData.length > 0) {
      yield* progress("reading antigravity tokens");
      yield* collect(
        yield* readAntigravityTokens(roots.antigravityData, tokenSinceMs),
        "antigravity",
      );
    }
    for (const root of roots.opencodeData) {
      yield* progress(`reading opencode tokens from ${root}`);
      yield* collect(yield* readOpenCodeTokens([root], tokenSinceMs), "opencode");
    }
  }

  const exported = exportQuotaHistory({
    records: logs.records,
    tokens,
    ...(input.since === undefined ? {} : { since: input.since }),
    ...(input.until === undefined ? {} : { until: input.until }),
    ...(runAttribution === undefined ? {} : { runAttribution }),
  });
  const json = encodeJson(exported);
  if (input.output !== undefined) {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(input.output, `${json}\n`);
  } else {
    yield* Console.log(json);
  }

  const durationMs = (yield* Clock.currentTimeMillis) - startedAt;
  const intervals = exported.buckets.reduce((sum, bucket) => sum + bucket.intervals.length, 0);
  yield* progress(
    `exported ${exported.buckets.length} buckets, ${intervals} intervals and ` +
      `${exported.gaps.length} gaps from ${tokenFiles} token files ` +
      `(${tokenFailures} unreadable) to ${input.output ?? "stdout"} in ${durationMs} ms`,
  );
  return exported;
});

export const exportCommand = Command.make(
  "export-quota-history",
  {
    logsDir: Flag.String("logs-dir").pipe(
      Flag.withDescription(
        "The T3 server's logs directory that holds quota-history-v1-*.ndjson files.",
      ),
    ),
    codexSessions: Flag.String("codex-sessions").pipe(
      Flag.optional,
      Flag.withDescription(
        "A Codex sessions directory. Repeatable through a comma-separated list.",
      ),
    ),
    claudeProjects: Flag.String("claude-projects").pipe(
      Flag.optional,
      Flag.withDescription(
        "A Claude projects directory containing .jsonl transcripts. Repeatable through a comma-separated list.",
      ),
    ),
    antigravityData: Flag.String("antigravity-data").pipe(
      Flag.optional,
      Flag.withDescription(
        "An Antigravity conversations directory containing .db files. Comma-separate several. T3-managed profile conversations are added automatically.",
      ),
    ),
    opencodeData: Flag.String("opencode-data").pipe(
      Flag.optional,
      Flag.withDescription(
        "An OpenCode data directory containing opencode*.db files. Comma-separate several. Defaults to the local OpenCode data directory.",
      ),
    ),
    stateDir: Flag.String("state-dir").pipe(
      Flag.optional,
      Flag.withDescription(
        "The T3 state directory holding statev2.sqlite and managed provider profiles. Defaults to the parent of a --logs-dir named 'logs'.",
      ),
    ),
    since: Flag.String("since").pipe(
      Flag.optional,
      Flag.withDescription("Only export observations and tokens at or after this ISO timestamp."),
    ),
    until: Flag.String("until").pipe(
      Flag.optional,
      Flag.withDescription("Only export observations and tokens at or before this ISO timestamp."),
    ),
    output: Flag.String("output").pipe(
      Flag.optional,
      Flag.withDescription("Write the JSON export here instead of stdout."),
    ),
  },
  (config) =>
    Effect.gen(function* () {
      const since = Option.getOrUndefined(yield* normalizeBound("since", config.since));
      const until = Option.getOrUndefined(yield* normalizeBound("until", config.until));
      yield* runExport({
        logsDir: config.logsDir,
        codexSessions: splitRoots(config.codexSessions),
        claudeProjects: splitRoots(config.claudeProjects),
        antigravityData: splitRoots(config.antigravityData),
        opencodeData: splitRoots(config.opencodeData),
        stateDir: Option.getOrUndefined(config.stateDir),
        since,
        until,
        output: Option.getOrUndefined(config.output),
      });
    }),
).pipe(
  Command.withDescription(
    "Join recorded quota readings with provider token history into deterministic intervals.",
  ),
);

if (import.meta.main) {
  Command.run(exportCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
