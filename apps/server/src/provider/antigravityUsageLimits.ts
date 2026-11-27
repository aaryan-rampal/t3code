import type { AntigravitySettings, ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import { spawnAndCollect } from "@t3tools/provider-core/server/snapshotProbe";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

/** Older releases send `/usage` to the model as an ordinary, billed prompt. */
const MINIMUM_VERSION = "1.1.11";
const WINDOWS = {
  "5h": { kind: "session", label: "5-hour", minutes: 5 * 60 },
  weekly: { kind: "weekly", label: "Weekly", minutes: 7 * 24 * 60 },
} as const;
/** These would move `agy` off the Google account whose quota this instance reports. */
const OTHER_CREDENTIAL_KEYS = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_GENAI_USE_VERTEXAI",
];

const Bucket = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.optional(Schema.String),
  window: Schema.optional(Schema.String),
  remaining_fraction: Schema.optional(Schema.Number),
  reset_time: Schema.optional(Schema.String),
  disabled: Schema.optional(Schema.Boolean),
});
const Group = Schema.Struct({
  name: Schema.optional(Schema.String),
  buckets: Schema.optional(Schema.Array(Bucket)),
});
const Reply = Schema.Struct({
  status: Schema.String,
  num_turns: Schema.Number,
  usage: Schema.Struct({ total_tokens: Schema.Number }),
  error: Schema.optional(Schema.String),
  command: Schema.optional(
    Schema.Struct({
      name: Schema.String,
      data: Schema.optional(Schema.Struct({ groups: Schema.Array(Group) })),
    }),
  ),
});
const decodeReply = Schema.decodeEffect(Schema.fromJsonString(Reply));

function usageWindow(
  group: typeof Group.Type,
  bucket: typeof Bucket.Type,
  checkedAt: DateTime.Utc,
): ServerProviderUsageWindow | undefined {
  const remaining = bucket.remaining_fraction;
  if (bucket.disabled || remaining === undefined || !Number.isFinite(remaining)) return undefined;
  const window = bucket.window === "5h" || bucket.window === "weekly" ? bucket.window : undefined;
  const known = window ? WINDOWS[window] : undefined;
  const family =
    bucket.id === `gemini-${window}`
      ? "Gemini"
      : bucket.id.startsWith("3p-")
        ? "Claude & GPT (shared)"
        : group.name?.trim() || bucket.id;
  // An unused pool reports the Unix epoch as its reset.
  const resetsAt = Option.filter(DateTime.make(bucket.reset_time ?? ""), (reset) =>
    DateTime.isGreaterThan(reset, checkedAt),
  );
  return {
    id: bucket.id,
    kind: known?.kind ?? "other",
    label: `${family} · ${known?.label ?? (bucket.name?.trim() || "Quota")}`,
    usedPercent: (1 - Math.max(0, Math.min(1, remaining))) * 100,
    ...(Option.isSome(resetsAt) ? { resetsAt: DateTime.formatIso(resetsAt.value) } : {}),
    ...(known ? { windowDurationMins: known.minutes } : {}),
  };
}

/** Anything other than the `/usage` command's own answer means `agy` ran it as a prompt. */
function ranAsPrompt(reply: typeof Reply.Type): boolean {
  return (
    reply.num_turns > 0 ||
    reply.usage.total_tokens > 0 ||
    (reply.status === "SUCCESS" && reply.command?.name !== "usage")
  );
}

/**
 * Reads Antigravity limits by asking the official CLI for `/usage`; T3 never calls Google's APIs or
 * reads its credentials. `agy` ignores GEMINI_HOME here, so every instance reports the account of
 * the CLI's own sign-in in `~/.gemini`, which is wrong for an instance signed in to another one.
 */
export const makeAntigravityUsageProbe = Effect.fn("makeAntigravityUsageProbe")(function* <
  E,
>(input: {
  readonly authMethod: AntigravitySettings["authMethod"];
  readonly environment: NodeJS.ProcessEnv;
  readonly executable: Effect.Effect<
    { readonly executablePath: string; readonly version: string | null },
    E
  >;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  let spentQuota = false;

  const environment: NodeJS.ProcessEnv = {
    ...input.environment,
    // agy then prints a sign-in link when signed out instead of opening a browser.
    SSH_CONNECTION: input.environment.SSH_CONNECTION || "127.0.0.1 0 127.0.0.1 0",
    AGY_CLI_DISABLE_AUTO_UPDATE: "true",
  };
  for (const key of OTHER_CREDENTIAL_KEYS) delete environment[key];

  const failed = (checkedAt: string, message: string) =>
    makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed", message });

  const run = (executablePath: string, args: ReadonlyArray<string>, cwd: string) =>
    spawnAndCollect(
      executablePath,
      ChildProcess.make(executablePath, args, {
        cwd,
        env: environment,
        extendEnv: false,
        stdin: "ignore",
      }),
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

  const read = Effect.gen(function* () {
    const now = yield* DateTime.now;
    const checkedAt = DateTime.formatIso(now);
    if (input.authMethod !== "oauth-personal" && input.authMethod !== "oauth-business") {
      return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
    }
    if (spentQuota) {
      return failed(checkedAt, "agy treated /usage as a prompt, so T3 stopped reading limits.");
    }
    const executable = yield* input.executable;
    const { executablePath } = executable;
    // Removed with the scope, so periodic reads leave no CLI logs behind.
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-antigravity-usage-" });
    // T3 knows its own installs' versions, but not one found on PATH or set by the user.
    const version =
      executable.version ?? (yield* run(executablePath, ["--version"], cwd)).stdout.trim();
    if (!parseSemver(version) || compareSemverVersions(version, MINIMUM_VERSION) < 0) {
      return failed(checkedAt, `Update agy to ${MINIMUM_VERSION} or newer to see limits.`);
    }
    const args = ["-p", "/usage", "--output-format", "json", "--print-timeout", "20s"];
    const output = yield* run(
      executablePath,
      [...args, "--log-file", path.join(cwd, "agy.log")],
      cwd,
    );
    const reply = yield* decodeReply(output.stdout);
    if (ranAsPrompt(reply)) {
      spentQuota = true;
      yield* Effect.logWarning("Antigravity usage read ran as a prompt; no further reads", {
        version,
        turns: reply.num_turns,
        tokens: reply.usage.total_tokens,
      });
      return failed(checkedAt, "agy treated /usage as a prompt, so T3 stopped reading limits.");
    }
    const windows = (reply.command?.data?.groups ?? []).flatMap((group) =>
      (group.buckets ?? []).flatMap((bucket) => usageWindow(group, bucket, now) ?? []),
    );
    if (output.code !== 0 || windows.length === 0) {
      yield* Effect.logWarning("Antigravity usage read returned no limits", {
        version,
        exitCode: output.code,
        status: reply.status,
        error: reply.error,
      });
      return failed(
        checkedAt,
        "agy returned no limits. Check that it is signed in by running agy in a terminal.",
      );
    }
    return makeUsageLimits({ checkedAt, windows });
  });

  const probe = read.pipe(
    Effect.scoped,
    // A signed-out agy waits a minute for a pasted code; closing the scope kills it.
    Effect.timeout("30 seconds"),
    Effect.catch((cause) =>
      Effect.logWarning("Antigravity usage read failed", { cause }).pipe(
        Effect.andThen(DateTime.now),
        Effect.map((now) =>
          failed(
            DateTime.formatIso(now),
            "Could not read limits from agy. Check that it is signed in by running agy.",
          ),
        ),
      ),
    ),
  );
  return { probe };
});
