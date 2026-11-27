import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { makeAntigravityUsageProbe } from "./antigravityUsageLimits.ts";

const usageReply = {
  status: "SUCCESS",
  num_turns: 0,
  usage: { total_tokens: 0 },
  command: {
    name: "usage",
    data: {
      groups: [
        {
          name: "Gemini Models",
          buckets: [
            {
              id: "gemini-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remaining_fraction: 0.75,
              reset_time: "2999-01-08T00:00:00Z",
            },
            {
              id: "gemini-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 0.5,
              reset_time: "2999-01-01T05:00:00Z",
            },
          ],
        },
        {
          name: "Claude and GPT models",
          buckets: [
            {
              id: "3p-5h",
              name: "Five Hour Limit Remaining",
              window: "5h",
              remaining_fraction: 1,
              reset_time: "1970-01-01T00:00:00Z",
            },
          ],
        },
      ],
    },
  },
};

/** A stand-in `agy` that records how it was called and prints a fixed reply. */
const fixture = Effect.fn("AntigravityUsageTest.fixture")(function* (
  options: {
    readonly reply?: unknown;
    /** What `agy --version` prints. */
    readonly version?: string;
    /** The command T3 runs; the stand-in is installed as `agy` on PATH. */
    readonly command?: string;
    readonly exitCode?: number;
    readonly authMethod?: "oauth-personal" | "gemini-api-key";
    readonly platform?: NodeJS.Platform;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-agy-usage-test-" });
  const executablePath = path.join(directory, "agy");
  const callsPath = path.join(directory, "calls");
  const replyPath = path.join(directory, "reply.json");
  const userHome = path.join(directory, "user-home");
  const bareHome = path.join(directory, "bare-home");
  yield* fs.writeFileString(replyPath, JSON.stringify(options.reply ?? usageReply));
  yield* fs.writeFileString(
    executablePath,
    [
      "#!/bin/sh",
      `[ "$1" = --version ] && { echo '${options.version ?? "1.5.18"}'; exit 0; }`,
      `echo "args=$* ssh=$SSH_CONNECTION update=$AGY_CLI_DISABLE_AUTO_UPDATE` +
        ` key=$GEMINI_API_KEY$google_api_key home=$HOME stdin=$(cat)" >>'${callsPath}'`,
      `cat '${replyPath}'`,
      `exit ${options.exitCode ?? 0}`,
    ].join("\n"),
  );
  yield* fs.chmod(executablePath, 0o755);
  const { probe } = yield* makeAntigravityUsageProbe({
    authMethod: options.authMethod ?? "oauth-personal",
    environment: {
      PATH: `${directory}:/usr/bin:/bin`,
      GEMINI_API_KEY: "leaked",
      google_api_key: "leaked",
    },
    command: options.command ?? "agy",
    bareHome,
  }).pipe(
    Effect.provideService(HostProcess.Platform, options.platform ?? "linux"),
    Effect.provideService(HostProcess.HomeDirectory, userHome),
  );
  const calls = fs.readFileString(callsPath).pipe(
    Effect.map((text) => text.trim().split("\n")),
    Effect.orElseSucceed((): string[] => []),
  );
  return { probe, calls, userHome, bareHome };
});

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "Antigravity usage from agy",
  () => {
    it.live("reports each quota bucket and omits a reset that already passed", () =>
      Effect.gen(function* () {
        const { probe, calls } = yield* fixture();
        const limits = yield* probe;

        expect(limits.unavailable).toBeUndefined();
        expect(limits.windows).toEqual([
          {
            id: "3p-5h",
            kind: "session",
            label: "Claude & GPT (shared) · 5-hour",
            usedPercent: 0,
            windowDurationMins: 300,
          },
          {
            id: "gemini-5h",
            kind: "session",
            label: "Gemini · 5-hour",
            usedPercent: 50,
            resetsAt: "2999-01-01T05:00:00.000Z",
            windowDurationMins: 300,
          },
          {
            id: "gemini-weekly",
            kind: "weekly",
            label: "Gemini · Weekly",
            usedPercent: 25,
            resetsAt: "2999-01-08T00:00:00.000Z",
            windowDurationMins: 10080,
          },
        ]);
        const [call, ...rest] = yield* calls;
        expect(rest).toEqual([]);
        expect(call).toContain("-p /usage --output-format json --print-timeout 20s --log-file ");
        expect(call).toContain("ssh=127.0.0.1 0 127.0.0.1 0 update=true key= home=");
        expect(call).not.toContain("--disable-slash-commands");
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.live("runs agy bare on macOS: a reused home that only links the keychain", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { probe, calls, userHome, bareHome } = yield* fixture({ platform: "darwin" });

        yield* probe;
        expect((yield* probe).windows).toHaveLength(3);

        expect(yield* fs.readLink(path.join(bareHome, "Library", "Keychains"))).toBe(
          path.join(userHome, "Library", "Keychains"),
        );
        expect(yield* fs.readDirectory(bareHome)).toEqual(["Library"]);
        for (const call of yield* calls) expect(call).toContain(`home=${bareHome} `);
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.live("leaves HOME alone where the sign-in is not found through a keychain", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { probe, calls, bareHome } = yield* fixture({ platform: "linux" });

        yield* probe;

        expect(yield* fs.exists(bareHome)).toBe(false);
        expect((yield* calls)[0]).not.toContain(bareHome);
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.live.each<[string, Parameters<typeof fixture>[0], string]>([
      ["an agy that predates /usage in print mode", { version: "1.1.10" }, "probeFailed"],
      ["an agy whose version is not a version", { version: "runtime two" }, "probeFailed"],
      ["a command that is not installed", { command: "agy-missing" }, "probeFailed"],
      ["an API key instance", { authMethod: "gemini-api-key" }, "unsupported"],
    ])("never runs %s", ([, options, reason]) =>
      Effect.gen(function* () {
        const { probe, calls } = yield* fixture(options);

        expect((yield* probe).unavailable?.reason).toBe(reason);
        expect(yield* calls).toEqual([]);
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.live.each([
      ["a model turn", { ...usageReply, num_turns: 1 }],
      ["token use", { ...usageReply, usage: { total_tokens: 12 } }],
      ["a prompt answer", { status: "SUCCESS", num_turns: 0, usage: { total_tokens: 0 } }],
    ])("stops asking after agy reports %s", ([, reply]) =>
      Effect.gen(function* () {
        const { probe, calls } = yield* fixture({ reply });

        expect((yield* probe).unavailable?.reason).toBe("probeFailed");
        expect((yield* probe).unavailable?.reason).toBe("probeFailed");
        expect(yield* calls).toHaveLength(1);
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.live("keeps asking after a failed read, such as a signed-out CLI", () =>
      Effect.gen(function* () {
        const { probe, calls } = yield* fixture({
          reply: { status: "ERROR", num_turns: 0, usage: { total_tokens: 0 } },
          exitCode: 1,
        });

        expect((yield* probe).unavailable?.message).toContain("signed in");
        yield* probe;
        expect(yield* calls).toHaveLength(2);
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  },
);
