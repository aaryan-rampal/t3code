import { assert, describe, it } from "@effect/vitest";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";

import {
  dedupeUsageRecords,
  exportQuotaHistory,
  type QuotaHistoryTokenTotals,
} from "./QuotaHistoryExport.ts";
import {
  quotaHistoryMeter,
  type QuotaHistoryGap,
  type QuotaHistoryReading,
  type QuotaHistoryWindow,
} from "./QuotaHistoryRecorder.ts";

const day = "2026-11-25";

const at = (hours: number, minutes: number): string =>
  `${day}T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00.000Z`;

interface WindowInput {
  readonly id: string;
  readonly usedPercent: number;
  readonly kind?: QuotaHistoryWindow["kind"];
  readonly label?: string;
  readonly resetsAt?: string;
  readonly windowDurationMins?: number;
  readonly spent?: number;
  readonly limit?: number;
  readonly modelIds?: ReadonlyArray<string>;
}

function window(driver: string, input: WindowInput): QuotaHistoryWindow {
  return {
    id: input.id,
    kind: input.kind ?? "session",
    label: input.label ?? input.id,
    usedPercent: input.usedPercent,
    ...(input.resetsAt === undefined ? {} : { resetsAt: input.resetsAt }),
    ...(input.windowDurationMins === undefined
      ? {}
      : { windowDurationMins: input.windowDurationMins }),
    ...(input.spent === undefined ? {} : { spent: input.spent }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
    ...(input.modelIds === undefined ? {} : { modelIds: input.modelIds }),
    meter: quotaHistoryMeter(driver, input.id),
  };
}

function reading(input: {
  readonly observedAt: string;
  readonly checkedAt?: string;
  readonly driver?: string;
  readonly providerInstanceId?: string;
  readonly accountKey?: string;
  readonly resetCredits?: QuotaHistoryReading["resetCredits"];
  readonly windows: ReadonlyArray<WindowInput>;
}): QuotaHistoryReading {
  const driver = input.driver ?? "codex";
  return {
    version: 1,
    kind: "reading",
    observedAt: input.observedAt,
    providerInstanceId: input.providerInstanceId ?? driver,
    driver,
    ...(input.accountKey === undefined ? {} : { accountKey: input.accountKey }),
    source: "probe",
    checkedAt: input.checkedAt ?? input.observedAt,
    ...(input.resetCredits === undefined ? {} : { resetCredits: input.resetCredits }),
    windows: input.windows.map((entry) => window(driver, entry)),
  };
}

function gap(input: {
  readonly observedAt: string;
  readonly providerInstanceId?: string;
  readonly driver?: string;
  readonly accountKey?: string;
  readonly reason?: QuotaHistoryGap["reason"];
}): QuotaHistoryGap {
  return {
    version: 1,
    kind: "gap",
    observedAt: input.observedAt,
    providerInstanceId: input.providerInstanceId ?? input.driver ?? "codex",
    driver: input.driver ?? "codex",
    ...(input.accountKey === undefined ? {} : { accountKey: input.accountKey }),
    source: "probe",
    reason: input.reason ?? "probeFailed",
  };
}

function firstInterval(exported: ReturnType<typeof exportQuotaHistory>) {
  const interval = exported.buckets[0]?.intervals[0];
  if (interval === undefined) throw new Error("expected an interval");
  return interval;
}

const emptyTotals: QuotaHistoryTokenTotals = {
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};

function token(input: {
  readonly at: string;
  readonly model: string;
  readonly sessionId?: string;
  readonly dedupeKey?: string | null;
  readonly provider?: UsageRecord["provider"];
  readonly upstreamProviderId?: string;
  readonly rateModel?: string;
  readonly totals?: Partial<QuotaHistoryTokenTotals>;
}): UsageRecord {
  return {
    provider: input.provider ?? "codex",
    timestampMs: Date.parse(input.at),
    model: input.model,
    ...(input.upstreamProviderId === undefined
      ? {}
      : { upstreamProviderId: input.upstreamProviderId }),
    ...(input.rateModel === undefined ? {} : { rateModel: input.rateModel }),
    sessionId: input.sessionId ?? "session-1",
    totals: { ...emptyTotals, ...input.totals },
    reportedCostUsd: null,
    speed: "standard",
    dedupeKey: input.dedupeKey === undefined ? `codex:${input.model}:${input.at}` : input.dedupeKey,
  };
}

describe("exportQuotaHistory", () => {
  it("groups intervening tokens by model and keeps token types distinct", () => {
    const records = [
      reading({
        observedAt: at(10, 0),
        accountKey: "account",
        windows: [{ id: "primary", usedPercent: 10, resetsAt: at(14, 0) }],
      }),
      reading({
        observedAt: at(10, 5),
        accountKey: "account",
        windows: [{ id: "primary", usedPercent: 14, resetsAt: at(14, 0) }],
      }),
    ];
    const tokens = [
      token({
        at: at(9, 59),
        model: "gpt-outside",
        totals: { uncachedInputTokens: 999 },
      }),
      token({
        at: at(10, 1),
        model: "gpt-large",
        sessionId: "session-a",
        totals: {
          uncachedInputTokens: 100,
          cachedInputTokens: 10,
          cacheCreationTokens: 5,
          outputTokens: 20,
          reasoningTokens: 3,
        },
      }),
      token({
        at: at(10, 3),
        model: "gpt-small",
        sessionId: "session-b",
        totals: { uncachedInputTokens: 50, outputTokens: 10 },
      }),
      token({
        at: at(10, 4),
        model: "gpt-large",
        sessionId: "session-a",
        totals: { uncachedInputTokens: 20, outputTokens: 5 },
      }),
      token({
        at: at(10, 5),
        model: "gpt-boundary",
        totals: { uncachedInputTokens: 999 },
      }),
    ];

    const exported = exportQuotaHistory({ records, tokens });
    const bucket = exported.buckets[0]!;
    const interval = bucket.intervals[0]!;

    assert.deepStrictEqual(exported.buckets.length, 1);
    assert.strictEqual(interval.quotaDeltaPercent, 4);
    assert.strictEqual(interval.reset, false);
    assert.strictEqual(interval.gap, false);
    assert.deepStrictEqual(
      interval.tokens.map((group) => [group.model, group.requests, group.totals]),
      [
        [
          "gpt-large",
          2,
          {
            uncachedInputTokens: 120,
            cachedInputTokens: 10,
            cacheCreationTokens: 5,
            outputTokens: 25,
            reasoningTokens: 3,
          },
        ],
        [
          "gpt-small",
          1,
          {
            uncachedInputTokens: 50,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 10,
            reasoningTokens: 0,
          },
        ],
      ],
    );
    assert.deepStrictEqual(interval.tokens[0]?.sessionIds, ["session-a"]);
    assert.strictEqual(bucket.totals.consumedPercent, 4);
    assert.strictEqual(bucket.tokenAttributionUncertain, false);
    assert.deepStrictEqual(bucket.totals.tokenTotals, {
      uncachedInputTokens: 170,
      cachedInputTokens: 10,
      cacheCreationTokens: 5,
      outputTokens: 35,
      reasoningTokens: 3,
    });
  });

  it("preserves a valid zero-change interval and its tokens", () => {
    const exported = exportQuotaHistory({
      records: [
        reading({ observedAt: at(10, 0), windows: [{ id: "primary", usedPercent: 30 }] }),
        reading({ observedAt: at(10, 5), windows: [{ id: "primary", usedPercent: 30 }] }),
      ],
      tokens: [
        token({
          at: at(10, 2),
          model: "gpt-5",
          totals: { uncachedInputTokens: 7, outputTokens: 3 },
        }),
      ],
    });
    const interval = firstInterval(exported);

    assert.strictEqual(interval.quotaDeltaPercent, 0);
    assert.strictEqual(exported.buckets[0]?.totals.consumedPercent, 0);
    assert.strictEqual(exported.buckets[0]?.totals.zeroChangeIntervals, 1);
    assert.strictEqual(interval.tokenTotals.uncachedInputTokens, 7);
    assert.strictEqual(interval.tokenTotals.outputTokens, 3);
  });

  it("marks a reset crossing and excludes it from quota consumption", () => {
    const exported = exportQuotaHistory({
      records: [
        reading({
          observedAt: at(10, 0),
          windows: [{ id: "primary", usedPercent: 80, resetsAt: at(12, 0) }],
        }),
        reading({
          observedAt: at(10, 5),
          windows: [{ id: "primary", usedPercent: 5, resetsAt: at(17, 0) }],
        }),
      ],
      tokens: [
        token({
          at: at(10, 2),
          model: "gpt-5",
          totals: { uncachedInputTokens: 12, outputTokens: 4 },
        }),
      ],
    });
    const interval = firstInterval(exported);

    assert.strictEqual(interval.reset, true);
    assert.strictEqual(interval.lowerReading, false);
    assert.strictEqual(interval.quotaDeltaPercent, null);
    assert.strictEqual(exported.buckets[0]?.totals.consumedPercent, 0);
    assert.strictEqual(exported.buckets[0]?.totals.resetCrossings, 1);
    assert.strictEqual(interval.tokenTotals.uncachedInputTokens, 12);
  });

  it("marks gaps, out-of-order readings and uncertain account attribution", () => {
    const exported = exportQuotaHistory({
      records: [
        reading({ observedAt: at(10, 0), windows: [{ id: "primary", usedPercent: 50 }] }),
        gap({ observedAt: at(10, 2) }),
        reading({
          observedAt: at(10, 5),
          checkedAt: at(9, 59),
          windows: [{ id: "primary", usedPercent: 40 }],
        }),
      ],
      tokens: [],
    });
    const bucket = exported.buckets[0]!;
    const interval = bucket.intervals[0]!;

    assert.strictEqual(interval.gap, true);
    assert.strictEqual(interval.outOfOrder, true);
    assert.strictEqual(interval.quotaDeltaPercent, null);
    assert.strictEqual(bucket.accountKeyUncertain, true);
    assert.strictEqual(bucket.tokenAttributionUncertain, true);
    assert.strictEqual(bucket.totals.gapIntervals, 1);
    assert.strictEqual(bucket.totals.outOfOrderReadings, 1);
    assert.strictEqual(exported.gaps.length, 1);
    assert.strictEqual(exported.gaps[0]?.accountKeyUncertain, true);
  });

  it("marks a lower reading inside the same window without treating it as a reset", () => {
    const exported = exportQuotaHistory({
      records: [
        reading({
          observedAt: at(10, 0),
          windows: [{ id: "primary", usedPercent: 50, resetsAt: at(14, 0) }],
        }),
        reading({
          observedAt: at(10, 5),
          windows: [{ id: "primary", usedPercent: 45, resetsAt: at(14, 0) }],
        }),
      ],
      tokens: [],
    });
    const interval = firstInterval(exported);

    assert.strictEqual(interval.reset, false);
    assert.strictEqual(interval.lowerReading, true);
    assert.strictEqual(interval.quotaDeltaPercent, null);
    assert.strictEqual(exported.buckets[0]?.totals.lowerReadings, 1);
  });

  it("deduplicates by provider dedupe key, merges partial copies and keeps keyless records", () => {
    const duplicated = token({
      at: at(10, 1),
      model: "gpt-5",
      dedupeKey: "codex:session-1:response-1",
      totals: { uncachedInputTokens: 10 },
    });
    const fullerCopy = { ...duplicated, totals: { ...duplicated.totals, uncachedInputTokens: 15 } };
    const keyless = token({
      at: at(10, 2),
      model: "gpt-5",
      dedupeKey: null,
      totals: { uncachedInputTokens: 5 },
    });
    const deduped = dedupeUsageRecords([duplicated, fullerCopy, keyless, { ...keyless }]);

    assert.strictEqual(deduped.records.length, 3);
    assert.strictEqual(deduped.dropped, 1);
    assert.strictEqual(deduped.records[0]?.totals.uncachedInputTokens, 15);
  });

  it("keeps Go, Console and direct upstream OpenCode tokens separate", () => {
    const exported = exportQuotaHistory({
      records: [
        reading({
          observedAt: at(10, 0),
          driver: "opencode",
          providerInstanceId: "opencode",
          accountKey: "account-a",
          windows: [
            { id: "go_rolling", usedPercent: 10, label: "Go · Session" },
            {
              id: "budget_all",
              usedPercent: 50,
              kind: "other",
              label: "Console · Shared · All spend",
              spent: 10,
              limit: 20,
            },
          ],
        }),
        reading({
          observedAt: at(10, 5),
          driver: "opencode",
          providerInstanceId: "opencode",
          accountKey: "account-a",
          windows: [
            { id: "go_rolling", usedPercent: 12, label: "Go · Session" },
            {
              id: "budget_all",
              usedPercent: 55,
              kind: "other",
              label: "Console · Shared · All spend",
              spent: 11,
              limit: 20,
            },
          ],
        }),
      ],
      tokens: [
        token({
          at: at(10, 1),
          provider: "opencode",
          upstreamProviderId: "opencode-go",
          model: "deepseek",
          totals: { uncachedInputTokens: 100 },
        }),
        token({
          at: at(10, 2),
          provider: "opencode",
          upstreamProviderId: "anthropic",
          model: "claude-sonnet",
          totals: { uncachedInputTokens: 200 },
        }),
        token({
          at: at(10, 3),
          provider: "opencode",
          upstreamProviderId: "openai",
          model: "gpt-5",
          totals: { uncachedInputTokens: 300 },
        }),
      ],
    });

    const go = exported.buckets.find((bucket) => bucket.bucketId === "go_rolling")!;
    const consoleBudget = exported.buckets.find((bucket) => bucket.bucketId === "budget_all")!;

    assert.deepStrictEqual(
      go.intervals[0]?.tokens.map((group) => [group.upstreamProviderId, group.model]),
      [["opencode-go", "deepseek"]],
    );
    assert.strictEqual(go.intervals[0]?.tokenTotals.uncachedInputTokens, 100);
    assert.strictEqual(go.tokenAttributionUncertain, false);

    assert.deepStrictEqual(
      consoleBudget.intervals[0]?.tokens.map((group) => [group.upstreamProviderId, group.model]),
      [
        ["anthropic", "claude-sonnet"],
        ["openai", "gpt-5"],
      ],
    );
    assert.strictEqual(consoleBudget.intervals[0]?.tokenTotals.uncachedInputTokens, 500);
    // An all-spend budget has no provider or model scope.
    assert.strictEqual(consoleBudget.tokenAttributionUncertain, true);
  });

  it("marks Antigravity's untouched reset time and tolerates one-second drift", () => {
    const untouched = exportQuotaHistory({
      records: [
        reading({
          observedAt: at(10, 0),
          driver: "antigravity",
          windows: [{ id: "5h", usedPercent: 80, resetsAt: at(12, 0) }],
        }),
        reading({
          observedAt: at(12, 5),
          driver: "antigravity",
          windows: [{ id: "5h", usedPercent: 0 }],
        }),
      ],
      tokens: [],
    });
    assert.strictEqual(firstInterval(untouched).reset, true);
    assert.strictEqual(firstInterval(untouched).lowerReading, false);
    assert.strictEqual(firstInterval(untouched).quotaDeltaPercent, null);

    const jitter = exportQuotaHistory({
      records: [
        reading({
          observedAt: at(10, 0),
          driver: "antigravity",
          windows: [{ id: "5h", usedPercent: 40, resetsAt: at(14, 0) }],
        }),
        reading({
          observedAt: at(10, 5),
          driver: "antigravity",
          windows: [
            { id: "5h", usedPercent: 42, resetsAt: at(14, 0).replace("00.000Z", "01.000Z") },
          ],
        }),
      ],
      tokens: [],
    });
    assert.strictEqual(firstInterval(jitter).reset, false);
    assert.strictEqual(firstInterval(jitter).quotaDeltaPercent, 2);
  });

  it("treats a reset-credit redemption that lowers usage as a reset", () => {
    const exported = exportQuotaHistory({
      records: [
        reading({
          observedAt: at(10, 0),
          windows: [{ id: "primary", usedPercent: 80, resetsAt: at(14, 0) }],
          resetCredits: { availableCount: 2 },
        }),
        reading({
          observedAt: at(10, 5),
          windows: [{ id: "primary", usedPercent: 10, resetsAt: at(14, 0) }],
          resetCredits: { availableCount: 1 },
        }),
      ],
      tokens: [],
    });
    assert.strictEqual(firstInterval(exported).reset, true);
    assert.strictEqual(firstInterval(exported).lowerReading, false);
  });

  it("marks tokens uncertain when one driver has several accounts", () => {
    const exported = exportQuotaHistory({
      records: [
        reading({
          observedAt: at(10, 0),
          driver: "opencode",
          providerInstanceId: "opencode-a",
          accountKey: "account-a",
          windows: [{ id: "go_rolling", usedPercent: 10 }],
        }),
        reading({
          observedAt: at(10, 5),
          driver: "opencode",
          providerInstanceId: "opencode-a",
          accountKey: "account-a",
          windows: [{ id: "go_rolling", usedPercent: 12 }],
        }),
        reading({
          observedAt: at(10, 0),
          driver: "opencode",
          providerInstanceId: "opencode-b",
          accountKey: "account-b",
          windows: [{ id: "go_rolling", usedPercent: 20 }],
        }),
        reading({
          observedAt: at(10, 5),
          driver: "opencode",
          providerInstanceId: "opencode-b",
          accountKey: "account-b",
          windows: [{ id: "go_rolling", usedPercent: 21 }],
        }),
      ],
      tokens: [
        token({
          at: at(10, 1),
          provider: "opencode",
          upstreamProviderId: "opencode-go",
          model: "deepseek",
          dedupeKey: "go-1",
        }),
      ],
    });
    assert.strictEqual(exported.buckets.length, 2);
    assert.isTrue(exported.buckets.every((bucket) => bucket.tokenAttributionUncertain));
  });

  it("marks a mid-week coverage change and unions the bucket's reported coverage", () => {
    const exported = exportQuotaHistory({
      records: [
        reading({
          observedAt: at(10, 0),
          driver: "opencode",
          windows: [
            {
              id: "budget_shared",
              usedPercent: 50,
              kind: "other",
              modelIds: ["anthropic/claude-sonnet"],
            },
          ],
        }),
        reading({
          observedAt: at(10, 5),
          driver: "opencode",
          windows: [
            {
              id: "budget_shared",
              usedPercent: 55,
              kind: "other",
              modelIds: ["anthropic/claude-sonnet", "openai/gpt-5"],
            },
          ],
        }),
      ],
      tokens: [
        token({
          at: at(10, 2),
          provider: "opencode",
          upstreamProviderId: "anthropic",
          model: "claude-sonnet",
        }),
        token({
          at: at(10, 4),
          provider: "opencode",
          upstreamProviderId: "openai",
          model: "gpt-5",
        }),
      ],
    });
    const bucket = exported.buckets[0]!;
    assert.strictEqual(bucket.intervals[0]?.coverageChanged, true);
    assert.deepStrictEqual(bucket.modelIds, ["anthropic/claude-sonnet", "openai/gpt-5"]);
    assert.strictEqual(bucket.totals.coverageChanges, 1);
    assert.deepStrictEqual(
      bucket.intervals[0]?.tokens.map((group) => group.upstreamProviderId),
      ["anthropic", "openai"],
    );
    // The interval's tokens are filtered by the new scope, so changed coverage is ambiguous.
    assert.strictEqual(bucket.intervals[0]?.tokenScopeUncertain, true);
    assert.strictEqual(bucket.tokenAttributionUncertain, true);
  });

  it("does not claim token scope certainty when a coverage change drops the only tokens", () => {
    const exported = exportQuotaHistory({
      records: [
        reading({
          observedAt: at(10, 0),
          driver: "opencode",
          windows: [
            {
              id: "budget_shared",
              usedPercent: 50,
              kind: "other",
              modelIds: ["anthropic/claude-sonnet"],
            },
          ],
        }),
        reading({
          observedAt: at(10, 5),
          driver: "opencode",
          windows: [
            {
              id: "budget_shared",
              usedPercent: 55,
              kind: "other",
              modelIds: ["openai/gpt-5"],
            },
          ],
        }),
      ],
      tokens: [
        token({
          at: at(10, 2),
          provider: "opencode",
          upstreamProviderId: "anthropic",
          model: "claude-sonnet",
        }),
      ],
    });
    const interval = firstInterval(exported);
    assert.deepStrictEqual(interval.tokens, []);
    assert.strictEqual(interval.coverageChanged, true);
    assert.strictEqual(interval.tokenScopeUncertain, true);
  });

  it("marks attribution uncertain when no token carries a session ID", () => {
    const exported = exportQuotaHistory({
      records: [
        reading({
          observedAt: at(10, 0),
          windows: [{ id: "primary", usedPercent: 10 }],
        }),
        reading({
          observedAt: at(10, 5),
          windows: [{ id: "primary", usedPercent: 12 }],
        }),
      ],
      tokens: [token({ at: at(10, 1), model: "gpt-5", sessionId: "" })],
      runAttribution: new Map(),
    });
    const group = exported.buckets[0]?.intervals[0]?.tokens[0];
    assert.deepStrictEqual(group?.sessionIds, []);
    assert.deepStrictEqual(group?.t3RunIds, []);
    assert.strictEqual(group?.runAttributionUncertain, true);
  });

  it("attaches T3 and native run IDs and marks uncertain attribution", () => {
    const exported = exportQuotaHistory({
      records: [
        reading({
          observedAt: at(10, 0),
          windows: [{ id: "primary", usedPercent: 10 }],
        }),
        reading({
          observedAt: at(10, 5),
          windows: [{ id: "primary", usedPercent: 12 }],
        }),
      ],
      tokens: [
        token({ at: at(10, 1), model: "gpt-5", sessionId: "session-known" }),
        token({ at: at(10, 2), model: "gpt-5", sessionId: "session-unknown" }),
      ],
      runAttribution: new Map([
        [
          "session-known",
          {
            runIds: ["run-1"],
            threadIds: ["thread-1"],
            nativeRunIds: ["turn-1"],
            uncertain: false,
          },
        ],
      ]),
    });
    const group = exported.buckets[0]?.intervals[0]?.tokens[0];
    assert.deepStrictEqual(group?.t3RunIds, ["run-1"]);
    assert.deepStrictEqual(group?.t3ThreadIds, ["thread-1"]);
    assert.deepStrictEqual(group?.nativeRunIds, ["turn-1"]);
    assert.strictEqual(group?.runAttributionUncertain, true);
    assert.strictEqual(exported.runAttribution, "state-db");

    const unavailable = exportQuotaHistory({
      records: [],
      tokens: [],
    });
    assert.strictEqual(unavailable.runAttribution, "unavailable");
  });

  it("counts token records only inside the requested window", () => {
    const exported = exportQuotaHistory({
      since: at(10, 0),
      until: at(10, 5),
      records: [
        reading({
          observedAt: at(10, 0),
          checkedAt: at(9, 59),
          windows: [{ id: "primary", usedPercent: 10 }],
        }),
        reading({
          observedAt: at(10, 5),
          windows: [{ id: "primary", usedPercent: 12 }],
        }),
      ],
      tokens: [
        token({
          at: "2026-11-25T09:59:30.000Z",
          model: "before",
          dedupeKey: "a",
          totals: { uncachedInputTokens: 3 },
        }),
        token({
          at: at(10, 1),
          model: "inside",
          dedupeKey: "b",
          totals: { uncachedInputTokens: 7 },
        }),
        token({ at: at(10, 6), model: "after", dedupeKey: "c" }),
      ],
    });
    assert.strictEqual(exported.tokenRecords, 1);
    assert.strictEqual(exported.duplicateTokenRecords, 0);
    // The first in-window reading starts before --since, so its tokens still count.
    assert.strictEqual(firstInterval(exported).tokenTotals.uncachedInputTokens, 10);
  });

  it("produces the same JSON regardless of input order", () => {
    const records = [
      reading({
        observedAt: at(10, 0),
        accountKey: "account",
        windows: [
          { id: "primary", usedPercent: 10 },
          { id: "secondary", usedPercent: 40, kind: "weekly" },
        ],
      }),
      reading({
        observedAt: at(10, 5),
        accountKey: "account",
        windows: [
          { id: "primary", usedPercent: 12 },
          { id: "secondary", usedPercent: 41, kind: "weekly" },
        ],
      }),
      gap({ observedAt: at(10, 7), accountKey: "account" }),
      reading({
        observedAt: at(10, 10),
        accountKey: "account",
        windows: [
          { id: "primary", usedPercent: 13 },
          { id: "secondary", usedPercent: 42, kind: "weekly" },
        ],
      }),
    ];
    const tokens = [
      token({ at: at(10, 1), model: "gpt-5", dedupeKey: "a", totals: { outputTokens: 2 } }),
      token({ at: at(10, 6), model: "gpt-6", dedupeKey: "b", totals: { outputTokens: 3 } }),
    ];

    const forward = exportQuotaHistory({ records, tokens });
    const reversed = exportQuotaHistory({
      records: records.toReversed(),
      tokens: tokens.toReversed(),
    });

    assert.strictEqual(JSON.stringify(reversed), JSON.stringify(forward));
  });
});
