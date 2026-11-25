import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerProviderUsageRead,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  advanceQuotaHistory,
  type QuotaHistoryRecord,
  type QuotaHistorySourceSnapshot,
  QuotaHistoryRecorder,
  collectorLayer,
  quotaHistoryFilePath,
  quotaHistorySampleIds,
  encodeQuotaHistoryRecord,
  layer as quotaHistoryRecorderLayer,
} from "./QuotaHistoryRecorder.ts";

const observedAt = "2026-11-25T10:00:00.000Z";

function read(
  attemptedAt: string,
  outcome: "success" | "failed" | "unsupported" = "success",
  source: "probe" | "notification" = "probe",
): ServerProviderUsageRead {
  return { attemptedAt, source, outcome };
}

function snapshot(
  input: Partial<QuotaHistorySourceSnapshot> & {
    readonly usageLimits?: ServerProviderUsageLimits;
  } = {},
): QuotaHistorySourceSnapshot {
  return {
    providerInstanceId: "opencode",
    driver: "opencode",
    checkedAt: "2026-11-25T09:59:55.000Z",
    auth: { workspaceId: "opaque-account" },
    usageRead: read("2026-11-25T09:59:55.000Z"),
    ...input,
  };
}

function usage(
  checkedAt: string,
  overrides: Partial<ServerProviderUsageLimits> = {},
): ServerProviderUsageLimits {
  return {
    checkedAt,
    windows: [
      {
        id: "go_rolling",
        kind: "session",
        label: "Go · Session",
        usedPercent: 23,
        resetsAt: "2026-11-25T14:00:00.000Z",
        windowDurationMins: 300,
      },
    ],
    ...overrides,
  };
}

describe("advanceQuotaHistory", () => {
  it("records a baseline reading the first time a provider returns usage", () => {
    const { records, next } = advanceQuotaHistory({
      previous: undefined,
      snapshot: snapshot({ usageLimits: usage("2026-11-25T09:59:55.000Z") }),
      observedAt,
    });

    assert.strictEqual(records.length, 1);
    assert.deepStrictEqual(records[0], {
      version: 1,
      kind: "reading",
      observedAt,
      providerInstanceId: "opencode",
      driver: "opencode",
      accountKey: "opaque-account",
      source: "probe",
      checkedAt: "2026-11-25T09:59:55.000Z",
      windows: [
        {
          id: "go_rolling",
          kind: "session",
          label: "Go · Session",
          usedPercent: 23,
          resetsAt: "2026-11-25T14:00:00.000Z",
          windowDurationMins: 300,
          meter: "opencode_go",
        },
      ],
    });
    assert.isDefined(next);
  });

  it("appends a fresh reading when only its checkedAt advances, even unchanged", () => {
    const first = advanceQuotaHistory({
      previous: undefined,
      snapshot: snapshot({ usageLimits: usage("2026-11-25T09:59:55.000Z") }),
      observedAt,
    });
    const second = advanceQuotaHistory({
      previous: first.next,
      snapshot: snapshot({
        checkedAt: "2026-11-25T10:05:00.000Z",
        usageLimits: usage("2026-11-25T10:05:00.000Z"),
        usageRead: read("2026-11-25T10:05:00.000Z"),
      }),
      observedAt: "2026-11-25T10:05:01.000Z",
    });

    assert.strictEqual(second.records.length, 1);
    assert.strictEqual(second.records[0]?.kind, "reading");
    assert.strictEqual(second.records[0]?.kind === "reading" && second.records[0].source, "probe");
    assert.strictEqual(
      second.records[0]?.kind === "reading" && second.records[0].windows[0]?.usedPercent,
      23,
    );
  });

  it("records a gap when an explicit probe fails and the cached reading remains", () => {
    const first = advanceQuotaHistory({
      previous: undefined,
      snapshot: snapshot({ usageLimits: usage("2026-11-25T09:59:55.000Z") }),
      observedAt,
    });
    const second = advanceQuotaHistory({
      previous: first.next,
      snapshot: snapshot({
        checkedAt: "2026-11-25T10:05:00.000Z",
        usageLimits: usage("2026-11-25T09:59:55.000Z"),
        usageRead: read("2026-11-25T10:05:00.000Z", "failed"),
      }),
      observedAt: "2026-11-25T10:05:01.000Z",
    });

    assert.deepStrictEqual(second.records, [
      {
        version: 1,
        kind: "gap",
        observedAt: "2026-11-25T10:05:01.000Z",
        providerInstanceId: "opencode",
        driver: "opencode",
        accountKey: "opaque-account",
        source: "probe",
        reason: "probeFailed",
      },
    ]);
  });

  it("captures a quota notification that arrives between provider probes", () => {
    const first = advanceQuotaHistory({
      previous: undefined,
      snapshot: snapshot({ usageLimits: usage("2026-11-25T09:59:55.000Z") }),
      observedAt,
    });
    const second = advanceQuotaHistory({
      previous: first.next,
      snapshot: snapshot({
        usageRead: read("2026-11-25T10:01:00.000Z", "success", "notification"),
        usageLimits: usage("2026-11-25T10:01:00.000Z", {
          windows: [
            {
              id: "go_rolling",
              kind: "session",
              label: "Go · Session",
              usedPercent: 41,
              resetsAt: "2026-11-25T14:00:00.000Z",
            },
          ],
        }),
      }),
      observedAt: "2026-11-25T10:01:01.000Z",
    });

    assert.strictEqual(second.records[0]?.kind, "reading");
    assert.strictEqual(
      second.records[0]?.kind === "reading" && second.records[0].source,
      "notification",
    );
  });

  it("ignores unsupported or failed probes before a baseline exists", () => {
    const failed = advanceQuotaHistory({
      previous: undefined,
      snapshot: snapshot({
        usageRead: read("2026-11-25T09:59:55.000Z", "failed"),
        usageLimits: {
          checkedAt: "2026-11-25T09:59:55.000Z",
          windows: [],
          unavailable: { reason: "probeFailed" },
        },
      }),
      observedAt,
    });
    const unsupported = advanceQuotaHistory({
      previous: undefined,
      snapshot: snapshot({
        usageRead: read("2026-11-25T09:59:55.000Z", "unsupported"),
        usageLimits: {
          checkedAt: "2026-11-25T09:59:55.000Z",
          windows: [],
          unavailable: { reason: "unsupported" },
        },
      }),
      observedAt,
    });

    assert.deepStrictEqual(failed.records, []);
    assert.isFalse(failed.next?.hasReading);
    assert.deepStrictEqual(unsupported.records, []);
    assert.isFalse(unsupported.next?.hasReading);
  });

  it("records nothing for a republished snapshot with no new read attempt", () => {
    const first = advanceQuotaHistory({
      previous: undefined,
      snapshot: snapshot({ usageLimits: usage("2026-11-25T09:59:55.000Z") }),
      observedAt,
    });
    const second = advanceQuotaHistory({
      previous: first.next,
      snapshot: snapshot({
        checkedAt: "2026-11-25T10:05:00.000Z",
        usageLimits: usage("2026-11-25T09:59:55.000Z"),
      }),
      observedAt: "2026-11-25T10:05:01.000Z",
    });

    assert.deepStrictEqual(second.records, []);
    assert.deepStrictEqual(second.next, first.next);
  });

  it("ignores a probe that finishes after a newer notification was recorded", () => {
    const first = advanceQuotaHistory({
      previous: undefined,
      snapshot: snapshot({ usageLimits: usage("2026-11-25T09:59:55.000Z") }),
      observedAt,
    });
    const notified = advanceQuotaHistory({
      previous: first.next,
      snapshot: snapshot({
        usageRead: read("2026-11-25T10:02:00.000Z", "success", "notification"),
        usageLimits: usage("2026-11-25T10:02:00.000Z", {
          windows: [
            {
              id: "go_rolling",
              kind: "session",
              label: "Go · Session",
              usedPercent: 45,
            },
          ],
        }),
      }),
      observedAt: "2026-11-25T10:02:01.000Z",
    });
    const supersededProbe = advanceQuotaHistory({
      previous: notified.next,
      snapshot: snapshot({
        usageRead: read("2026-11-25T10:01:00.000Z"),
        usageLimits: usage("2026-11-25T10:01:00.000Z", {
          windows: [
            {
              id: "go_rolling",
              kind: "session",
              label: "Go · Session",
              usedPercent: 40,
            },
          ],
        }),
      }),
      observedAt: "2026-11-25T10:02:02.000Z",
    });

    assert.strictEqual(notified.records.length, 1);
    assert.deepStrictEqual(supersededProbe.records, []);
    assert.deepStrictEqual(supersededProbe.next, notified.next);
  });

  it("records an unavailability gap once usage was known", () => {
    const first = advanceQuotaHistory({
      previous: undefined,
      snapshot: snapshot({ usageLimits: usage("2026-11-25T09:59:55.000Z") }),
      observedAt,
    });
    const second = advanceQuotaHistory({
      previous: first.next,
      snapshot: snapshot({
        checkedAt: "2026-11-25T10:05:00.000Z",
        usageRead: read("2026-11-25T10:05:00.000Z", "unsupported"),
        usageLimits: {
          checkedAt: "2026-11-25T10:05:00.000Z",
          windows: [],
          unavailable: { reason: "unsupported" },
        },
      }),
      observedAt: "2026-11-25T10:05:01.000Z",
    });

    assert.strictEqual(second.records[0]?.kind, "gap");
    assert.strictEqual(
      second.records[0]?.kind === "gap" && second.records[0].reason,
      "unsupported",
    );
  });

  it("keeps Go, Console and upstream meters distinct and retains Console spend and budget", () => {
    const { records } = advanceQuotaHistory({
      previous: undefined,
      snapshot: snapshot({
        driver: "opencode",
        usageLimits: usage("2026-11-25T09:59:55.000Z", {
          windows: [
            {
              id: "go_rolling",
              kind: "session",
              label: "Go · Session",
              usedPercent: 23,
            },
            {
              id: "budget_all",
              kind: "other",
              label: "Console · Shared · All spend",
              usedPercent: 75,
              spent: 15,
              limit: 20,
            },
          ],
        }),
      }),
      observedAt,
    });
    const codex = advanceQuotaHistory({
      previous: undefined,
      snapshot: {
        providerInstanceId: "codex",
        driver: "codex",
        checkedAt: "2026-11-25T09:59:55.000Z",
        auth: { workspaceId: "codex-account" },
        usageRead: read("2026-11-25T09:59:55.000Z"),
        usageLimits: {
          checkedAt: "2026-11-25T09:59:55.000Z",
          windows: [{ id: "primary", kind: "session", label: "Session", usedPercent: 10 }],
        },
      },
      observedAt,
    });

    const reading = records[0];
    assert.strictEqual(reading?.kind, "reading");
    if (reading?.kind !== "reading") return;
    assert.deepStrictEqual(
      reading.windows.map((window) => [window.id, window.meter]),
      [
        ["go_rolling", "opencode_go"],
        ["budget_all", "opencode_console"],
      ],
    );
    assert.strictEqual(reading.windows[1]?.spent, 15);
    assert.strictEqual(reading.windows[1]?.limit, 20);
    const codexReading = codex.records[0];
    assert.strictEqual(codexReading?.kind, "reading");
    if (codexReading?.kind !== "reading") return;
    assert.strictEqual(codexReading.windows[0]?.meter, "upstream");
  });

  it("writes only allowlisted fields", () => {
    const { records } = advanceQuotaHistory({
      previous: undefined,
      snapshot: snapshot({
        auth: {
          email: "person@example.test",
          workspaceId: "opaque-account",
          label: "person@example.test",
        },
        usageLimits: usage("2026-11-25T09:59:55.000Z", {
          credentialFingerprint: "fingerprint",
        }),
      }),
      observedAt,
    });
    const serialized = encodeQuotaHistoryRecord(records[0]!);

    assert.notInclude(serialized, "person@example.test");
    assert.notInclude(serialized, "email");
    assert.include(serialized, "fingerprint");
  });

  it("keeps the last opaque account on a gap after the probe loses it", () => {
    const first = advanceQuotaHistory({
      previous: undefined,
      snapshot: snapshot({
        auth: {},
        usageLimits: usage("2026-11-25T09:59:55.000Z", {
          credentialFingerprint: "fingerprint",
        }),
      }),
      observedAt,
    });
    const second = advanceQuotaHistory({
      previous: first.next,
      snapshot: snapshot({
        checkedAt: "2026-11-25T10:05:00.000Z",
        auth: {},
        usageRead: read("2026-11-25T10:05:00.000Z", "failed"),
        usageLimits: {
          checkedAt: "2026-11-25T10:05:00.000Z",
          windows: [],
          unavailable: { reason: "probeFailed" },
        },
      }),
      observedAt: "2026-11-25T10:05:01.000Z",
    });

    assert.strictEqual(second.records[0]?.kind, "gap");
    assert.strictEqual(
      second.records[0]?.kind === "gap" && second.records[0].accountKey,
      "fingerprint",
    );
    assert.strictEqual(second.next?.accountKey, "fingerprint");
  });

  it("prefers a provider-reported opaque account key over its workspace id", () => {
    const { records } = advanceQuotaHistory({
      previous: undefined,
      snapshot: snapshot({
        auth: { workspaceId: "auth-account" },
        usageLimits: usage("2026-11-25T09:59:55.000Z", {
          accountKey: "provider-account",
        }),
      }),
      observedAt,
    });

    assert.strictEqual(records[0]?.kind, "reading");
    assert.strictEqual(records[0]?.kind === "reading" && records[0].accountKey, "provider-account");
  });

  it("marks an instance without an opaque account key", () => {
    const { records } = advanceQuotaHistory({
      previous: undefined,
      snapshot: snapshot({
        auth: {},
        usageLimits: usage("2026-11-25T09:59:55.000Z"),
      }),
      observedAt,
    });

    assert.strictEqual(records[0]?.kind, "reading");
    assert.strictEqual(records[0]?.kind === "reading" && records[0].accountKey, undefined);
  });

  it("starts a new account fresh instead of gapping its failed first probe", () => {
    const first = advanceQuotaHistory({
      previous: undefined,
      snapshot: snapshot({
        auth: { workspaceId: "first-account" },
        usageLimits: usage("2026-11-25T09:59:55.000Z"),
      }),
      observedAt,
    });
    const second = advanceQuotaHistory({
      previous: first.next,
      snapshot: snapshot({
        checkedAt: "2026-11-25T10:05:00.000Z",
        auth: { workspaceId: "second-account" },
        usageRead: read("2026-11-25T10:05:00.000Z", "failed"),
        usageLimits: {
          checkedAt: "2026-11-25T10:05:00.000Z",
          windows: [],
          unavailable: { reason: "probeFailed" },
        },
      }),
      observedAt: "2026-11-25T10:05:01.000Z",
    });

    assert.deepStrictEqual(second.records, []);
    assert.isFalse(second.next?.hasReading);
    assert.strictEqual(second.next?.accountKey, "second-account");
  });
});

describe("quotaHistoryFilePath", () => {
  it("uses a versioned daily file in the logs directory", () => {
    assert.strictEqual(
      quotaHistoryFilePath("/tmp/t3/logs", observedAt),
      "/tmp/t3/logs/quota-history-v1-2026-11-25.ndjson",
    );
  });
});

describe("quotaHistorySampleIds", () => {
  const now = Date.parse("2026-11-25T10:05:00.000Z");
  const intervalMs = 5 * 60_000;

  it("selects only observed providers whose last usage read is due", () => {
    const due = quotaHistorySampleIds(
      [
        provider({
          instanceId: "codex",
          driver: "codex",
          checkedAt: "2026-11-25T10:00:00.000Z",
          usageLimits: limits("2026-11-25T10:00:00.000Z", []),
          usageRead: read("2026-11-25T10:00:00.000Z"),
        }),
        provider({
          instanceId: "antigravity",
          driver: "antigravity",
          authStatus: "unknown",
          checkedAt: "2026-11-25T10:01:00.000Z",
          usageLimits: limits("2026-11-25T10:01:00.000Z", []),
          usageRead: read("2026-11-25T10:01:00.000Z"),
        }),
        provider({
          instanceId: "opencode",
          driver: "opencode",
          checkedAt: "2026-11-25T10:00:00.000Z",
          usageLimits: limits("2026-11-25T10:00:00.000Z", []),
          usageRead: read("2026-11-25T10:00:00.000Z"),
        }),
        provider({
          instanceId: "signed-out",
          driver: "opencode",
          authStatus: "unauthenticated",
          checkedAt: "2026-11-25T10:00:00.000Z",
          usageLimits: limits("2026-11-25T10:00:00.000Z", []),
          usageRead: read("2026-11-25T10:00:00.000Z"),
        }),
        provider({
          instanceId: "claude",
          driver: "claude",
          checkedAt: "2026-11-25T10:00:00.000Z",
          usageLimits: limits("2026-11-25T10:00:00.000Z", []),
          usageRead: read("2026-11-25T10:00:00.000Z"),
        }),
        provider({
          instanceId: "unsupported",
          driver: "codex",
          checkedAt: "2026-11-25T10:00:00.000Z",
          usageLimits: {
            checkedAt: "2026-11-25T10:00:00.000Z",
            windows: [],
            unavailable: { reason: "unsupported" },
          },
          usageRead: read("2026-11-25T10:00:00.000Z", "unsupported"),
        }),
      ],
      now,
      intervalMs,
    );

    assert.deepStrictEqual(due, [
      ProviderInstanceId.make("codex"),
      ProviderInstanceId.make("opencode"),
    ]);
  });

  it("samples nothing when the refresh interval is disabled", () => {
    assert.deepStrictEqual(
      quotaHistorySampleIds(
        [
          provider({
            instanceId: "codex",
            driver: "codex",
            checkedAt: "2026-11-25T10:00:00.000Z",
            usageLimits: limits("2026-11-25T10:00:00.000Z", []),
            usageRead: read("2026-11-25T10:00:00.000Z"),
          }),
        ],
        now,
        0,
      ),
      [],
    );
  });
});

function provider(input: {
  readonly instanceId: string;
  readonly driver: string;
  readonly checkedAt: string;
  readonly authStatus?: "authenticated" | "unknown" | "unauthenticated";
  readonly usageLimits?: ServerProviderUsageLimits;
  readonly usageRead?: ServerProvider["usageRead"];
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: input.driver,
    status: "ready",
    enabled: true,
    installed: true,
    auth: {
      status: input.authStatus ?? "authenticated",
      ...(input.authStatus === "authenticated" || input.authStatus === undefined
        ? { workspaceId: `${input.instanceId}-account` }
        : {}),
    },
    checkedAt: input.checkedAt,
    usageRead: input.usageRead ?? read(input.checkedAt),
    version: "1.0.0",
    models: [],
    slashCommands: [],
    skills: [],
    ...(input.usageLimits === undefined ? {} : { usageLimits: input.usageLimits }),
  } as unknown as ServerProvider;
}

function limits(
  checkedAt: string,
  windows: ServerProviderUsageLimits["windows"],
): ServerProviderUsageLimits {
  return { checkedAt, windows };
}

const layerQuotaHistory = () =>
  quotaHistoryRecorderLayer.pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-quota-history-test-" })),
    Layer.provideMerge(NodeServices.layer),
  );

describe("QuotaHistoryRecorder", () => {
  it.effect(
    "samples Codex, Antigravity and OpenCode probes, notifications and gaps into NDJSON",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-11-25T10:00:00.000Z"));
        const recorder = yield* QuotaHistoryRecorder;
        const { logsDir } = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const codexUsage = limits("2026-11-25T10:00:00.000Z", [
          {
            id: "primary",
            kind: "session",
            label: "Session",
            usedPercent: 10,
            resetsAt: "2026-11-25T14:00:00.000Z",
            windowDurationMins: 300,
          },
        ]);
        const antigravityUsage = limits("2026-11-25T10:00:00.000Z", [
          {
            id: "5h",
            kind: "session",
            label: "5h",
            usedPercent: 20,
            resetsAt: "2026-11-25T13:00:00.000Z",
            windowDurationMins: 300,
          },
        ]);
        const openCodeBaseline = limits("2026-11-25T10:00:00.000Z", [
          {
            id: "go_rolling",
            kind: "session",
            label: "Go · Session",
            usedPercent: 30,
            resetsAt: "2026-11-25T14:00:00.000Z",
            windowDurationMins: 300,
          },
          {
            id: "budget_all",
            kind: "other",
            label: "Console · Shared · All spend",
            usedPercent: 75,
            spent: 15,
            limit: 20,
          },
        ]);
        const baseline = [
          provider({
            instanceId: "codex",
            driver: "codex",
            checkedAt: "2026-11-25T10:00:00.000Z",
            usageLimits: codexUsage,
          }),
          // Antigravity publishes usage before a session reveals its sign-in state.
          provider({
            instanceId: "antigravity",
            driver: "antigravity",
            authStatus: "unknown",
            checkedAt: "2026-11-25T10:00:00.000Z",
            usageLimits: antigravityUsage,
          }),
          provider({
            instanceId: "opencode",
            driver: "opencode",
            checkedAt: "2026-11-25T10:00:00.000Z",
            usageLimits: openCodeBaseline,
          }),
          // Only Codex, Antigravity and OpenCode belong in the quota history.
          provider({
            instanceId: "claude",
            driver: "claude",
            checkedAt: "2026-11-25T10:00:00.000Z",
            usageLimits: limits("2026-11-25T10:00:00.000Z", [
              { id: "claude", kind: "session", label: "Session", usedPercent: 5 },
            ]),
          }),
        ];
        yield* recorder.observe(baseline);
        yield* recorder.observe(baseline);

        yield* TestClock.setTime(Date.parse("2026-11-25T10:05:00.000Z"));
        yield* recorder.observe([
          provider({
            instanceId: "codex",
            driver: "codex",
            checkedAt: "2026-11-25T10:05:00.000Z",
            usageLimits: limits("2026-11-25T10:05:00.000Z", codexUsage.windows),
          }),
          // The health check republishes before the asynchronous usage read finishes.
          provider({
            instanceId: "antigravity",
            driver: "antigravity",
            authStatus: "unknown",
            checkedAt: "2026-11-25T10:05:00.000Z",
            usageRead: read("2026-11-25T10:00:00.000Z"),
            usageLimits: antigravityUsage,
          }),
          provider({
            instanceId: "opencode",
            driver: "opencode",
            checkedAt: "2026-11-25T10:00:00.000Z",
            usageRead: read("2026-11-25T10:02:00.000Z", "success", "notification"),
            usageLimits: limits("2026-11-25T10:02:00.000Z", [
              {
                id: "go_rolling",
                kind: "session",
                label: "Go · Session",
                usedPercent: 45,
                resetsAt: "2026-11-25T14:00:00.000Z",
                windowDurationMins: 300,
              },
              {
                id: "budget_all",
                kind: "other",
                label: "Console · Shared · All spend",
                usedPercent: 80,
                spent: 16,
                limit: 20,
              },
            ]),
          }),
        ]);

        yield* TestClock.setTime(Date.parse("2026-11-25T10:06:00.000Z"));
        yield* recorder.observe([
          provider({
            instanceId: "antigravity",
            driver: "antigravity",
            authStatus: "unknown",
            checkedAt: "2026-11-25T10:06:00.000Z",
            usageLimits: limits("2026-11-25T10:06:00.000Z", [
              {
                id: "5h",
                kind: "session",
                label: "5h",
                usedPercent: 26,
                resetsAt: "2026-11-25T13:00:00.000Z",
                windowDurationMins: 300,
              },
            ]),
          }),
        ]);

        yield* TestClock.setTime(Date.parse("2026-11-25T10:07:00.000Z"));
        yield* recorder.observe([
          provider({
            instanceId: "opencode",
            driver: "opencode",
            checkedAt: "2026-11-25T10:07:00.000Z",
            usageLimits: limits("2026-11-25T10:07:00.000Z", [
              {
                id: "go_rolling",
                kind: "session",
                label: "Go · Session",
                usedPercent: 45,
                resetsAt: "2026-11-25T14:00:00.000Z",
                windowDurationMins: 300,
              },
              {
                id: "budget_all",
                kind: "other",
                label: "Console · Shared · All spend",
                usedPercent: 80,
                spent: 16,
                limit: 20,
              },
            ]),
          }),
        ]);

        yield* TestClock.setTime(Date.parse("2026-11-25T10:08:00.000Z"));
        yield* recorder.observe([
          provider({
            instanceId: "antigravity",
            driver: "antigravity",
            authStatus: "unknown",
            checkedAt: "2026-11-25T10:08:00.000Z",
            usageRead: read("2026-11-25T10:08:00.000Z", "failed"),
            usageLimits: limits("2026-11-25T10:06:00.000Z", [
              {
                id: "5h",
                kind: "session",
                label: "5h",
                usedPercent: 26,
                resetsAt: "2026-11-25T13:00:00.000Z",
                windowDurationMins: 300,
              },
            ]),
          }),
        ]);

        const names = (yield* fs.readDirectory(logsDir)).filter((name) =>
          name.startsWith("quota-history-"),
        );
        assert.deepStrictEqual(names, ["quota-history-v1-2026-11-25.ndjson"]);
        const content = yield* fs.readFileString(path.join(logsDir, names[0]!));
        const records = content
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as QuotaHistoryRecord);

        assert.strictEqual(records.length, 8);
        assert.deepStrictEqual(
          records.map((record) =>
            record.kind === "reading" ? ["reading", record.source] : ["gap", record.reason],
          ),
          [
            ["reading", "probe"],
            ["reading", "probe"],
            ["reading", "probe"],
            ["reading", "probe"],
            ["reading", "notification"],
            ["reading", "probe"],
            ["reading", "probe"],
            ["gap", "probeFailed"],
          ],
        );
        const openCode = records[2];
        assert.strictEqual(openCode?.kind, "reading");
        if (openCode?.kind === "reading") {
          assert.deepStrictEqual(
            openCode.windows.map((window) => [window.id, window.meter, window.spent ?? null]),
            [
              ["go_rolling", "opencode_go", null],
              ["budget_all", "opencode_console", 15],
            ],
          );
        }
        const notification = records[4];
        assert.strictEqual(notification?.kind, "reading");
        if (notification?.kind === "reading") {
          assert.strictEqual(notification.windows[0]?.usedPercent, 45);
          assert.strictEqual(notification.windows[1]?.spent, 16);
        }
      }).pipe(Effect.provide(layerQuotaHistory())),
  );

  it.effect("forgets a signed-out account's baseline", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-25T10:00:00.000Z"));
      const recorder = yield* QuotaHistoryRecorder;
      const { logsDir } = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      yield* recorder.observe([
        provider({
          instanceId: "opencode",
          driver: "opencode",
          checkedAt: "2026-11-25T10:00:00.000Z",
          usageLimits: limits("2026-11-25T10:00:00.000Z", [
            {
              id: "go_rolling",
              kind: "session",
              label: "Go · Session",
              usedPercent: 30,
            },
          ]),
        }),
      ]);

      yield* TestClock.setTime(Date.parse("2026-11-25T10:05:00.000Z"));
      yield* recorder.observe([
        provider({
          instanceId: "opencode",
          driver: "opencode",
          authStatus: "unauthenticated",
          checkedAt: "2026-11-25T10:05:00.000Z",
          usageRead: read("2026-11-25T10:05:00.000Z", "failed"),
        }),
      ]);

      yield* TestClock.setTime(Date.parse("2026-11-25T10:06:00.000Z"));
      yield* recorder.observe([
        provider({
          instanceId: "opencode",
          driver: "opencode",
          checkedAt: "2026-11-25T10:06:00.000Z",
          usageRead: read("2026-11-25T10:06:00.000Z", "failed"),
          usageLimits: {
            checkedAt: "2026-11-25T10:06:00.000Z",
            windows: [],
            unavailable: { reason: "probeFailed" },
          },
        }),
      ]);

      const names = (yield* fs.readDirectory(logsDir)).filter((name) =>
        name.startsWith("quota-history-"),
      );
      const content = yield* fs.readFileString(path.join(logsDir, names[0]!));
      const records = content
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as QuotaHistoryRecord);
      assert.deepStrictEqual(
        records.map((record) => record.kind),
        ["reading"],
      );
    }).pipe(Effect.provide(layerQuotaHistory())),
  );

  it.effect("samples a stale provider on the fallback interval only while allowed", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-11-25T10:00:00.000Z"));
      const sampled = yield* Ref.make<Array<ServerProvider["instanceId"]>>([]);
      const allowed = yield* Ref.make(false);
      const providers = [
        provider({
          instanceId: "opencode",
          driver: "opencode",
          checkedAt: "2026-11-25T10:00:00.000Z",
          usageLimits: limits("2026-11-25T10:00:00.000Z", [
            { id: "go_rolling", kind: "session", label: "Go · Session", usedPercent: 30 },
          ]),
          usageRead: read("2026-11-25T09:00:00.000Z"),
        }),
      ];
      const registry = Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed(providers),
        sampleUsage: (instanceId) => Ref.update(sampled, (ids) => [...ids, instanceId]),
        subscribeChanges: Effect.flatMap(
          PubSub.unbounded<ReadonlyArray<ServerProvider>>(),
          PubSub.subscribe,
        ),
      });
      const background = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunUsageSampling: Ref.get(allowed),
      });
      const collector = collectorLayer.pipe(
        Layer.provideMerge(registry),
        Layer.provideMerge(background),
        Layer.provideMerge(ServerSettings.layerTest()),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-quota-history-collector-test-" }),
        ),
        Layer.provideMerge(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        yield* TestClock.adjust("5 minutes");
        yield* Effect.yieldNow;
        assert.deepStrictEqual(yield* Ref.get(sampled), []);

        yield* Ref.set(allowed, true);
        yield* TestClock.adjust("5 minutes");
        yield* Effect.yieldNow;
        assert.deepStrictEqual(yield* Ref.get(sampled), [ProviderInstanceId.make("opencode")]);
      }).pipe(Effect.provide(collector));
    }),
  );
});
