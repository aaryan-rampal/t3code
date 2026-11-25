import type { ServerProviderUsageWindow, UsageProviderKind } from "@t3tools/contracts";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";

import type {
  QuotaHistoryGap,
  QuotaHistoryMeter,
  QuotaHistoryReading,
  QuotaHistoryRecord,
} from "./QuotaHistoryRecorder.ts";
import { mergeUsageCopies } from "./usageAggregation.ts";

const QUOTA_HISTORY_EXPORT_VERSION = 1 as const;
const RESET_JITTER_MS = 60_000;

export interface QuotaHistoryTokenTotals {
  readonly uncachedInputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens: number;
  readonly outputTokens: number;
  /** Reasoning tokens are a subset of output tokens and must not be added again. */
  readonly reasoningTokens: number;
}

export interface QuotaHistoryRunAttribution {
  readonly runIds: ReadonlyArray<string>;
  readonly threadIds: ReadonlyArray<string>;
  readonly nativeRunIds: ReadonlyArray<string>;
  /** True when a session maps to several runs or turns, so a request cannot pick one. */
  readonly uncertain: boolean;
}

/** Native session ID to the T3 runs and native turns that session used. */
export type QuotaHistoryRunAttributionMap = ReadonlyMap<string, QuotaHistoryRunAttribution>;

export interface QuotaHistoryTokenGroup {
  readonly model: string;
  /** The provider OpenCode routed through: Go, Console or a direct upstream. */
  readonly upstreamProviderId?: string;
  readonly requests: number;
  readonly sessionIds: ReadonlyArray<string>;
  readonly t3RunIds: ReadonlyArray<string>;
  readonly t3ThreadIds: ReadonlyArray<string>;
  readonly nativeRunIds: ReadonlyArray<string>;
  readonly runAttributionUncertain: boolean;
  readonly totals: QuotaHistoryTokenTotals;
}

export interface QuotaHistoryObservation {
  readonly observedAt: string;
  readonly checkedAt: string;
  readonly usedPercent: number;
  /** The provider's label for this bucket at this observation. */
  readonly label: string;
  readonly resetsAt?: string;
  readonly windowDurationMins?: number;
  readonly spent?: number;
  readonly limit?: number;
  /** The coverage the provider reported for this bucket at this observation. */
  readonly modelIds?: ReadonlyArray<string>;
  readonly providerIds?: ReadonlyArray<string>;
}

export interface QuotaHistoryInterval {
  readonly providerInstanceId: string;
  readonly driver: string;
  readonly meter: QuotaHistoryMeter;
  readonly bucketId: string;
  readonly bucketKind: ServerProviderUsageWindow["kind"];
  readonly bucketLabel: string;
  readonly accountKey?: string;
  readonly accountKeyUncertain: boolean;
  readonly from: QuotaHistoryObservation;
  readonly to: QuotaHistoryObservation;
  /**
   * Percentage points consumed; null when a reset, lower or out-of-order reading
   * breaks the pair.
   */
  readonly quotaDeltaPercent: number | null;
  readonly reset: boolean;
  readonly lowerReading: boolean;
  readonly outOfOrder: boolean;
  readonly gap: boolean;
  /** True when this interval's reported coverage differs from its predecessor. */
  readonly coverageChanged: boolean;
  /** True when the token scope for this meter cannot be applied exactly. */
  readonly tokenScopeUncertain: boolean;
  readonly tokens: ReadonlyArray<QuotaHistoryTokenGroup>;
  readonly tokenTotals: QuotaHistoryTokenTotals;
}

export interface QuotaHistoryBucketTotals {
  readonly readings: number;
  readonly intervals: number;
  readonly consumedPercent: number;
  readonly zeroChangeIntervals: number;
  readonly resetCrossings: number;
  readonly lowerReadings: number;
  readonly outOfOrderReadings: number;
  readonly gapIntervals: number;
  readonly coverageChanges: number;
  readonly tokenTotals: QuotaHistoryTokenTotals;
}

export interface QuotaHistoryBucketExport {
  readonly providerInstanceId: string;
  readonly driver: string;
  readonly meter: QuotaHistoryMeter;
  readonly bucketId: string;
  readonly bucketKind: ServerProviderUsageWindow["kind"];
  readonly bucketLabel: string;
  readonly modelIds?: ReadonlyArray<string>;
  readonly providerIds?: ReadonlyArray<string>;
  readonly accountKey?: string;
  readonly accountKeyUncertain: boolean;
  /** Provider token readers carry no account identity, so tokens belong to the driver. */
  readonly tokenAttributionUncertain: boolean;
  readonly intervals: ReadonlyArray<QuotaHistoryInterval>;
  readonly totals: QuotaHistoryBucketTotals;
}

export interface QuotaHistoryExportedGap extends QuotaHistoryGap {
  readonly accountKeyUncertain: boolean;
}

export interface QuotaHistoryExport {
  readonly version: typeof QUOTA_HISTORY_EXPORT_VERSION;
  readonly since?: string;
  readonly until?: string;
  readonly buckets: ReadonlyArray<QuotaHistoryBucketExport>;
  readonly gaps: ReadonlyArray<QuotaHistoryExportedGap>;
  readonly tokenRecords: number;
  readonly duplicateTokenRecords: number;
  /** Whether run and native turn IDs could be resolved from T3's state database. */
  readonly runAttribution: "state-db" | "unavailable";
}

const TOKEN_PROVIDERS: ReadonlyMap<string, UsageProviderKind> = new Map([
  ["antigravity", "antigravity"],
  ["codex", "codex"],
  ["opencode", "opencode"],
]);

const ZERO_TOKENS: QuotaHistoryTokenTotals = {
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function roundPercent(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function timestamp(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function inRange(value: string, since: number | undefined, until: number | undefined): boolean {
  const time = timestamp(value);
  if (time === undefined) return false;
  return (since === undefined || time >= since) && (until === undefined || time <= until);
}

function tokenInRange(record: UsageRecord, since: number | undefined, until: number | undefined) {
  return (
    (since === undefined || record.timestampMs >= since) &&
    (until === undefined || record.timestampMs <= until)
  );
}

function tokenTimestamp(record: UsageRecord): number {
  return record.timestampMs;
}

function addTokenTotals(
  left: QuotaHistoryTokenTotals,
  right: QuotaHistoryTokenTotals,
): QuotaHistoryTokenTotals {
  return {
    uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheCreationTokens: left.cacheCreationTokens + right.cacheCreationTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
  };
}

function tokenTotals(record: UsageRecord): QuotaHistoryTokenTotals {
  return {
    uncachedInputTokens: record.totals.uncachedInputTokens,
    cachedInputTokens: record.totals.cachedInputTokens,
    cacheCreationTokens: record.totals.cacheCreationTokens,
    outputTokens: record.totals.outputTokens,
    reasoningTokens: record.totals.reasoningTokens,
  };
}

function tokenIdentity(record: UsageRecord): string | undefined {
  if (record.dedupeKey === null) return undefined;
  return JSON.stringify([record.provider, record.dedupeKey]);
}

/**
 * Providers' dedupe keys are stable across copied files, and partial copies merge by channel
 * the same way billed usage does. Records without a key stay distinct.
 */
export function dedupeUsageRecords(records: ReadonlyArray<UsageRecord>): {
  readonly records: ReadonlyArray<UsageRecord>;
  readonly dropped: number;
} {
  const ordered = records
    .map((record, index) => ({ record, index }))
    .toSorted(
      (left, right) =>
        compareText(left.record.provider, right.record.provider) ||
        tokenTimestamp(left.record) - tokenTimestamp(right.record) ||
        compareText(left.record.model, right.record.model) ||
        compareText(left.record.sessionId, right.record.sessionId) ||
        compareText(left.record.dedupeKey ?? "", right.record.dedupeKey ?? "") ||
        left.index - right.index,
    );
  const slots: UsageRecord[] = [];
  const slotByIdentity = new Map<string, number>();
  let dropped = 0;
  for (const { record } of ordered) {
    const identity = tokenIdentity(record);
    if (identity === undefined) {
      slots.push(record);
      continue;
    }
    const slot = slotByIdentity.get(identity);
    if (slot === undefined) {
      slotByIdentity.set(identity, slots.length);
      slots.push(record);
      continue;
    }
    slots[slot] = mergeUsageCopies(slots[slot]!, record);
    dropped += 1;
  }
  return { records: slots, dropped };
}

function groupTokensByProvider(
  records: ReadonlyArray<UsageRecord>,
): ReadonlyMap<UsageProviderKind, ReadonlyArray<UsageRecord>> {
  const grouped = new Map<UsageProviderKind, UsageRecord[]>();
  for (const record of records) {
    const list = grouped.get(record.provider) ?? [];
    list.push(record);
    grouped.set(record.provider, list);
  }
  for (const list of grouped.values()) {
    list.sort((left, right) => tokenTimestamp(left) - tokenTimestamp(right));
  }
  return grouped;
}

function lowerBound(records: ReadonlyArray<UsageRecord>, time: number): number {
  let low = 0;
  let high = records.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (tokenTimestamp(records[middle]!) < time) low = middle + 1;
    else high = middle;
  }
  return low;
}

function tokensBetween(
  grouped: ReadonlyMap<UsageProviderKind, ReadonlyArray<UsageRecord>>,
  provider: UsageProviderKind | undefined,
  from: string,
  to: string,
): ReadonlyArray<UsageRecord> {
  if (provider === undefined) return [];
  const start = timestamp(from);
  const end = timestamp(to);
  if (start === undefined || end === undefined || end <= start) return [];
  const records = grouped.get(provider);
  if (records === undefined) return [];
  const first = lowerBound(records, start);
  const last = lowerBound(records, end);
  return records.slice(first, last);
}

function tokenProviderId(record: UsageRecord): string | undefined {
  if (record.upstreamProviderId !== undefined) return record.upstreamProviderId;
  const rateModel = record.rateModel;
  if (rateModel?.startsWith("opencode_go/")) return "opencode-go";
  return undefined;
}

/**
 * OpenCode buckets describe Go, Console budgets or direct upstream usage, so a
 * bucket only owns the tokens its meter and coverage identify.
 */
function tokenMatchesWindow(
  record: UsageRecord,
  driver: string,
  window: QuotaHistoryReading["windows"][number],
): boolean {
  if (driver !== "opencode") return true;
  const providerId = tokenProviderId(record);
  if (window.meter === "opencode_go") return providerId === "opencode-go";
  if (window.meter === "opencode_console") {
    if (providerId === "opencode-go") return false;
    const modelIds = window.modelIds ?? [];
    if (modelIds.length > 0) {
      return providerId !== undefined && modelIds.includes(`${providerId}/${record.model}`);
    }
    const providerIds = window.providerIds ?? [];
    if (providerIds.length > 0) {
      return providerId !== undefined && providerIds.includes(providerId);
    }
  }
  return true;
}

function tokenScopeUncertain(
  driver: string,
  window: QuotaHistoryReading["windows"][number],
): boolean {
  if (driver !== "opencode" || window.meter !== "opencode_console") return false;
  return (window.modelIds ?? []).length === 0 && (window.providerIds ?? []).length === 0;
}

function resolveRunAttribution(
  sessions: Iterable<string>,
  attribution: QuotaHistoryRunAttributionMap | undefined,
): Pick<
  QuotaHistoryTokenGroup,
  "t3RunIds" | "t3ThreadIds" | "nativeRunIds" | "runAttributionUncertain"
> {
  const runIds = new Set<string>();
  const threadIds = new Set<string>();
  const nativeRunIds = new Set<string>();
  const sessionList = [...sessions];
  // Records with no session ID cannot match a run, even when the state database was read.
  let uncertain = attribution === undefined || sessionList.length === 0;
  for (const sessionId of sessionList) {
    const entry = attribution?.get(sessionId);
    if (entry === undefined) {
      uncertain = true;
      continue;
    }
    for (const runId of entry.runIds) runIds.add(runId);
    for (const threadId of entry.threadIds) threadIds.add(threadId);
    for (const nativeRunId of entry.nativeRunIds) nativeRunIds.add(nativeRunId);
    if (entry.uncertain) uncertain = true;
  }
  return {
    t3RunIds: [...runIds].toSorted(compareText),
    t3ThreadIds: [...threadIds].toSorted(compareText),
    nativeRunIds: [...nativeRunIds].toSorted(compareText),
    runAttributionUncertain: uncertain,
  };
}

function groupTokenRecords(
  records: ReadonlyArray<UsageRecord>,
  attribution: QuotaHistoryRunAttributionMap | undefined,
): {
  readonly groups: ReadonlyArray<QuotaHistoryTokenGroup>;
  readonly totals: QuotaHistoryTokenTotals;
  readonly unattributed: number;
} {
  const byModel = new Map<
    string,
    {
      readonly model: string;
      readonly upstreamProviderId?: string;
      requests: number;
      sessions: Set<string>;
      totals: QuotaHistoryTokenTotals;
    }
  >();
  let totals = ZERO_TOKENS;
  let unattributed = 0;
  for (const record of records) {
    const upstreamProviderId = tokenProviderId(record);
    if (record.provider === "opencode" && upstreamProviderId === undefined) unattributed += 1;
    const key = JSON.stringify([upstreamProviderId ?? null, record.model]);
    const entry = byModel.get(key) ?? {
      model: record.model,
      ...(upstreamProviderId === undefined ? {} : { upstreamProviderId }),
      requests: 0,
      sessions: new Set<string>(),
      totals: ZERO_TOKENS,
    };
    entry.requests += 1;
    if (record.sessionId.length > 0) entry.sessions.add(record.sessionId);
    entry.totals = addTokenTotals(entry.totals, tokenTotals(record));
    byModel.set(key, entry);
    totals = addTokenTotals(totals, tokenTotals(record));
  }
  const groups = [...byModel.entries()]
    .toSorted(
      ([leftKey, left], [rightKey, right]) =>
        compareText(left.upstreamProviderId ?? "", right.upstreamProviderId ?? "") ||
        compareText(left.model, right.model) ||
        compareText(leftKey, rightKey),
    )
    .map(([, entry]) => ({
      model: entry.model,
      ...(entry.upstreamProviderId === undefined
        ? {}
        : { upstreamProviderId: entry.upstreamProviderId }),
      requests: entry.requests,
      sessionIds: [...entry.sessions].toSorted(compareText),
      ...resolveRunAttribution(entry.sessions, attribution),
      totals: entry.totals,
    }));
  return { groups, totals, unattributed };
}

function observationOf(
  reading: QuotaHistoryReading,
  window: QuotaHistoryReading["windows"][number],
): QuotaHistoryObservation {
  return {
    observedAt: reading.observedAt,
    checkedAt: reading.checkedAt,
    usedPercent: window.usedPercent,
    label: window.label,
    ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
    ...(window.windowDurationMins === undefined
      ? {}
      : { windowDurationMins: window.windowDurationMins }),
    ...(window.spent === undefined ? {} : { spent: window.spent }),
    ...(window.limit === undefined ? {} : { limit: window.limit }),
    ...(window.modelIds === undefined ? {} : { modelIds: window.modelIds }),
    ...(window.providerIds === undefined ? {} : { providerIds: window.providerIds }),
  };
}

function sameCoverage(left: QuotaHistoryObservation, right: QuotaHistoryObservation): boolean {
  return (
    JSON.stringify(left.modelIds ?? null) === JSON.stringify(right.modelIds ?? null) &&
    JSON.stringify(left.providerIds ?? null) === JSON.stringify(right.providerIds ?? null)
  );
}

function resetCrossed(input: {
  readonly from: QuotaHistoryObservation;
  readonly to: QuotaHistoryObservation;
  readonly previous: QuotaHistoryReading;
  readonly reading: QuotaHistoryReading;
}): boolean {
  const fromReset = timestamp(input.from.resetsAt);
  const toReset = timestamp(input.to.resetsAt);
  const toCheckedAt = timestamp(input.to.checkedAt);
  // Reaching the reported reset time is enough, even when the provider omits a
  // new reset time for an untouched bucket.
  if (fromReset !== undefined && toCheckedAt !== undefined && toCheckedAt >= fromReset) return true;
  // Small rounding drift within one window is not a reset.
  if (fromReset !== undefined && toReset !== undefined && toReset - fromReset > RESET_JITTER_MS) {
    return true;
  }
  const creditsBefore = input.previous.resetCredits?.availableCount ?? 0;
  const creditsAfter = input.reading.resetCredits?.availableCount ?? 0;
  return creditsAfter < creditsBefore && input.to.usedPercent < input.from.usedPercent;
}

function intervalTokens(
  groupedTokens: ReadonlyMap<UsageProviderKind, ReadonlyArray<UsageRecord>>,
  driver: string,
  window: QuotaHistoryReading["windows"][number],
  from: QuotaHistoryObservation,
  to: QuotaHistoryObservation,
  attribution: QuotaHistoryRunAttributionMap | undefined,
): ReturnType<typeof groupTokenRecords> & { readonly scopeUncertain: boolean } {
  const candidates = tokensBetween(
    groupedTokens,
    TOKEN_PROVIDERS.get(driver),
    from.checkedAt,
    to.checkedAt,
  );
  // The interval's tokens are filtered by the new coverage. When coverage changed,
  // tokens billed under the previous scope have no bucket to land in.
  const scopeUncertain = !sameCoverage(from, to) && candidates.length > 0;
  return {
    ...groupTokenRecords(
      candidates.filter((record) => tokenMatchesWindow(record, driver, window)),
      attribution,
    ),
    scopeUncertain,
  };
}

function buildInterval(input: {
  readonly reading: QuotaHistoryReading;
  readonly window: QuotaHistoryReading["windows"][number];
  readonly previous: QuotaHistoryReading;
  readonly previousWindow: QuotaHistoryReading["windows"][number];
  readonly gap: boolean;
  readonly tokens: ReturnType<typeof intervalTokens>;
}): QuotaHistoryInterval {
  const from = observationOf(input.previous, input.previousWindow);
  const to = observationOf(input.reading, input.window);
  const reset = resetCrossed({
    from,
    to,
    previous: input.previous,
    reading: input.reading,
  });
  const lowerReading = !reset && to.usedPercent < from.usedPercent;
  const fromCheckedAt = timestamp(from.checkedAt);
  const toCheckedAt = timestamp(to.checkedAt);
  const outOfOrder =
    fromCheckedAt !== undefined && toCheckedAt !== undefined && toCheckedAt < fromCheckedAt;
  const quotaDeltaPercent =
    reset || lowerReading || outOfOrder ? null : roundPercent(to.usedPercent - from.usedPercent);
  return {
    providerInstanceId: input.reading.providerInstanceId,
    driver: input.reading.driver,
    meter: input.window.meter,
    bucketId: input.window.id,
    bucketKind: input.window.kind,
    bucketLabel: input.window.label,
    ...(input.reading.accountKey === undefined ? {} : { accountKey: input.reading.accountKey }),
    accountKeyUncertain: input.reading.accountKey === undefined,
    from,
    to,
    quotaDeltaPercent,
    reset,
    lowerReading,
    outOfOrder,
    gap: input.gap,
    coverageChanged: !sameCoverage(from, to),
    tokenScopeUncertain:
      tokenScopeUncertain(input.reading.driver, input.window) ||
      input.tokens.scopeUncertain ||
      input.tokens.unattributed > 0,
    tokens: input.tokens.groups,
    tokenTotals: input.tokens.totals,
  };
}

interface BucketObservation {
  readonly reading: QuotaHistoryReading;
  readonly window: QuotaHistoryReading["windows"][number];
  readonly index: number;
}

interface BucketGroup {
  readonly key: string;
  readonly observations: ReadonlyArray<BucketObservation>;
}

function bucketKey(reading: QuotaHistoryReading, windowId: string): string {
  return JSON.stringify([reading.providerInstanceId, reading.accountKey ?? null, windowId]);
}

function groupReadings(readings: ReadonlyArray<QuotaHistoryReading>): ReadonlyArray<BucketGroup> {
  const groups = new Map<string, BucketObservation[]>();
  for (const [index, reading] of readings.entries()) {
    for (const window of reading.windows) {
      const key = bucketKey(reading, window.id);
      const observations = groups.get(key) ?? [];
      observations.push({ reading, window, index });
      groups.set(key, observations);
    }
  }
  return [...groups.entries()]
    .map(([key, observations]) => ({
      key,
      observations: observations.toSorted(
        (left, right) =>
          (timestamp(left.reading.observedAt) ?? 0) - (timestamp(right.reading.observedAt) ?? 0) ||
          (timestamp(left.reading.checkedAt) ?? 0) - (timestamp(right.reading.checkedAt) ?? 0) ||
          compareText(JSON.stringify(left.reading), JSON.stringify(right.reading)) ||
          left.index - right.index,
      ),
    }))
    .toSorted((left, right) => compareText(left.key, right.key));
}

function gapKey(record: Pick<QuotaHistoryGap, "providerInstanceId" | "accountKey">): string {
  return JSON.stringify([record.providerInstanceId, record.accountKey ?? null]);
}

function groupGaps(
  gaps: ReadonlyArray<QuotaHistoryGap>,
): ReadonlyMap<string, ReadonlyArray<QuotaHistoryGap>> {
  const grouped = new Map<string, QuotaHistoryGap[]>();
  for (const gap of gaps) {
    const key = gapKey(gap);
    const list = grouped.get(key) ?? [];
    list.push(gap);
    grouped.set(key, list);
  }
  return grouped;
}

function hasGapBetween(
  gaps: ReadonlyMap<string, ReadonlyArray<QuotaHistoryGap>>,
  reading: QuotaHistoryReading,
  from: string,
  to: string,
): boolean {
  const list = gaps.get(gapKey(reading));
  if (list === undefined) return false;
  const fromTime = timestamp(from) ?? 0;
  const toTime = timestamp(to) ?? 0;
  return list.some((gap) => {
    const time = timestamp(gap.observedAt);
    return time !== undefined && time > fromTime && time <= toTime;
  });
}

function bucketTotals(intervals: ReadonlyArray<QuotaHistoryInterval>): QuotaHistoryBucketTotals {
  let consumedPercent = 0;
  let zeroChangeIntervals = 0;
  let resetCrossings = 0;
  let lowerReadings = 0;
  let outOfOrderReadings = 0;
  let gapIntervals = 0;
  let coverageChanges = 0;
  let tokenTotals = ZERO_TOKENS;
  for (const interval of intervals) {
    if (interval.quotaDeltaPercent !== null) {
      consumedPercent += interval.quotaDeltaPercent;
      if (interval.quotaDeltaPercent === 0) zeroChangeIntervals += 1;
    }
    if (interval.reset) resetCrossings += 1;
    if (interval.lowerReading) lowerReadings += 1;
    if (interval.outOfOrder) outOfOrderReadings += 1;
    if (interval.gap) gapIntervals += 1;
    if (interval.coverageChanged) coverageChanges += 1;
    tokenTotals = addTokenTotals(tokenTotals, interval.tokenTotals);
  }
  return {
    readings: intervals.length + 1,
    intervals: intervals.length,
    consumedPercent: roundPercent(consumedPercent),
    zeroChangeIntervals,
    resetCrossings,
    lowerReadings,
    outOfOrderReadings,
    gapIntervals,
    coverageChanges,
    tokenTotals,
  };
}

function unionCoverage(
  observations: ReadonlyArray<BucketObservation>,
  field: "modelIds" | "providerIds",
): ReadonlyArray<string> | undefined {
  const values = new Set<string>();
  let reported = false;
  for (const { window } of observations) {
    const current = window[field];
    if (current === undefined) continue;
    reported = true;
    for (const value of current) values.add(value);
  }
  return reported ? [...values].toSorted(compareText) : undefined;
}

function buildBucket(input: {
  readonly group: BucketGroup;
  readonly gaps: ReadonlyMap<string, ReadonlyArray<QuotaHistoryGap>>;
  readonly groupedTokens: ReadonlyMap<UsageProviderKind, ReadonlyArray<UsageRecord>>;
  readonly runAttribution: QuotaHistoryRunAttributionMap | undefined;
}): QuotaHistoryBucketExport {
  const first = input.group.observations[0]!;
  const intervals: QuotaHistoryInterval[] = [];
  for (let index = 1; index < input.group.observations.length; index += 1) {
    const previous = input.group.observations[index - 1]!;
    const current = input.group.observations[index]!;
    const gap = hasGapBetween(
      input.gaps,
      current.reading,
      previous.reading.observedAt,
      current.reading.observedAt,
    );
    const tokens = intervalTokens(
      input.groupedTokens,
      current.reading.driver,
      current.window,
      observationOf(previous.reading, previous.window),
      observationOf(current.reading, current.window),
      input.runAttribution,
    );
    intervals.push(
      buildInterval({
        reading: current.reading,
        window: current.window,
        previous: previous.reading,
        previousWindow: previous.window,
        gap,
        tokens,
      }),
    );
  }
  const reading = first.reading;
  const window = first.window;
  const modelIds = unionCoverage(input.group.observations, "modelIds");
  const providerIds = unionCoverage(input.group.observations, "providerIds");
  return {
    providerInstanceId: reading.providerInstanceId,
    driver: reading.driver,
    meter: window.meter,
    bucketId: window.id,
    bucketKind: window.kind,
    bucketLabel: window.label,
    ...(modelIds === undefined ? {} : { modelIds }),
    ...(providerIds === undefined ? {} : { providerIds }),
    ...(reading.accountKey === undefined ? {} : { accountKey: reading.accountKey }),
    accountKeyUncertain: reading.accountKey === undefined,
    tokenAttributionUncertain:
      reading.accountKey === undefined ||
      intervals.some((interval) => interval.tokenScopeUncertain),
    intervals,
    totals: bucketTotals(intervals),
  };
}

function markTokenAttribution(
  buckets: ReadonlyArray<QuotaHistoryBucketExport>,
): ReadonlyArray<QuotaHistoryBucketExport> {
  // Token readers carry no account identity, so all tokens of a driver are pooled.
  // A driver with several accounts therefore cannot attribute them to one bucket.
  const accountsByDriver = new Map<string, Set<string>>();
  for (const bucket of buckets) {
    const keys = accountsByDriver.get(bucket.driver) ?? new Set<string>();
    keys.add(bucket.accountKey ?? "");
    accountsByDriver.set(bucket.driver, keys);
  }
  return buckets.map((bucket) => {
    const keys = accountsByDriver.get(bucket.driver)!;
    return {
      ...bucket,
      tokenAttributionUncertain: bucket.tokenAttributionUncertain || keys.size > 1 || keys.has(""),
    };
  });
}

function compareBuckets(left: QuotaHistoryBucketExport, right: QuotaHistoryBucketExport): number {
  return (
    compareText(left.providerInstanceId, right.providerInstanceId) ||
    compareText(left.accountKey ?? "", right.accountKey ?? "") ||
    compareText(left.bucketId, right.bucketId) ||
    compareText(left.meter, right.meter) ||
    compareText(left.modelIds?.join(",") ?? "", right.modelIds?.join(",") ?? "") ||
    compareText(left.providerIds?.join(",") ?? "", right.providerIds?.join(",") ?? "")
  );
}

function sortGaps(gaps: ReadonlyArray<QuotaHistoryGap>): ReadonlyArray<QuotaHistoryExportedGap> {
  return gaps
    .map((gap, index) => ({ gap, index }))
    .toSorted(
      (left, right) =>
        (timestamp(left.gap.observedAt) ?? 0) - (timestamp(right.gap.observedAt) ?? 0) ||
        compareText(left.gap.providerInstanceId, right.gap.providerInstanceId) ||
        compareText(left.gap.accountKey ?? "", right.gap.accountKey ?? "") ||
        compareText(left.gap.reason, right.gap.reason) ||
        compareText(left.gap.driver, right.gap.driver) ||
        left.index - right.index,
    )
    .map(({ gap }) => ({ ...gap, accountKeyUncertain: gap.accountKey === undefined }));
}

export function exportQuotaHistory(input: {
  readonly records: ReadonlyArray<QuotaHistoryRecord>;
  readonly tokens: ReadonlyArray<UsageRecord>;
  readonly since?: string;
  readonly until?: string;
  readonly runAttribution?: QuotaHistoryRunAttributionMap;
}): QuotaHistoryExport {
  const since = timestamp(input.since);
  const until = timestamp(input.until);
  const readings: QuotaHistoryReading[] = [];
  const gaps: QuotaHistoryGap[] = [];
  for (const record of input.records) {
    if (!inRange(record.observedAt, since, until)) continue;
    if (record.kind === "reading") readings.push(record);
    else gaps.push(record);
  }

  const deduped = dedupeUsageRecords(input.tokens);
  const inWindow = dedupeUsageRecords(
    input.tokens.filter((record) => tokenInRange(record, since, until)),
  );
  const groupedTokens = groupTokensByProvider(deduped.records);
  const groupedGaps = groupGaps(gaps);
  const buckets = markTokenAttribution(
    groupReadings(readings)
      .map((group) =>
        buildBucket({
          group,
          gaps: groupedGaps,
          groupedTokens,
          runAttribution: input.runAttribution,
        }),
      )
      .toSorted(compareBuckets),
  );

  return {
    version: QUOTA_HISTORY_EXPORT_VERSION,
    ...(input.since === undefined ? {} : { since: input.since }),
    ...(input.until === undefined ? {} : { until: input.until }),
    buckets,
    gaps: sortGaps(gaps),
    tokenRecords: inWindow.records.length,
    duplicateTokenRecords: inWindow.dropped,
    runAttribution: input.runAttribution === undefined ? "unavailable" : "state-db",
  };
}
