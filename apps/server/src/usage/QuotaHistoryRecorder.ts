// @effect-diagnostics nodeBuiltinImport:off -- shared with the offline quota-history export.
import * as NodePath from "node:path";

import {
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
  type ServerProvider,
  type ServerProviderResetCredits,
  type ServerProviderUsageLimits,
  type ServerProviderUsageRead,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";

export const QUOTA_HISTORY_VERSION = 1 as const;

export type QuotaHistoryMeter = "opencode_go" | "opencode_console" | "upstream";

export interface QuotaHistoryWindow extends ServerProviderUsageWindow {
  readonly meter: QuotaHistoryMeter;
}

export interface QuotaHistoryReading {
  readonly version: typeof QUOTA_HISTORY_VERSION;
  readonly kind: "reading";
  readonly observedAt: string;
  readonly providerInstanceId: string;
  readonly driver: string;
  readonly accountKey?: string;
  readonly source: "probe" | "notification";
  readonly checkedAt: string;
  readonly windows: ReadonlyArray<QuotaHistoryWindow>;
  readonly resetCredits?: Pick<ServerProviderResetCredits, "availableCount" | "nextExpiresAt">;
  readonly zeroSpendCap?: true;
}

export interface QuotaHistoryGap {
  readonly version: typeof QUOTA_HISTORY_VERSION;
  readonly kind: "gap";
  readonly observedAt: string;
  readonly providerInstanceId: string;
  readonly driver: string;
  readonly accountKey?: string;
  readonly source: "probe";
  readonly reason: "probeFailed" | "unsupported";
}

export type QuotaHistoryRecord = QuotaHistoryReading | QuotaHistoryGap;

export interface QuotaHistorySourceSnapshot {
  readonly providerInstanceId: string;
  readonly driver: string;
  readonly checkedAt: string;
  readonly auth: {
    readonly workspaceId?: string | undefined;
    readonly profileId?: string | undefined;
    readonly email?: string | undefined;
    readonly label?: string | undefined;
  };
  readonly usageLimits?: ServerProviderUsageLimits;
  readonly usageRead?: ServerProviderUsageRead;
}

export interface QuotaHistoryInstanceState {
  /** The last processed read attempt, so republished snapshots are not recorded twice. */
  readonly lastReadAt: string;
  readonly hasReading: boolean;
  readonly lastReadingCheckedAt?: string;
  readonly accountKey?: string;
  readonly unsupported?: true;
}

function quotaAccountKey(snapshot: QuotaHistorySourceSnapshot): string | undefined {
  const usageKey =
    snapshot.usageLimits?.accountKey?.trim() || snapshot.usageLimits?.credentialFingerprint?.trim();
  if (usageKey) return usageKey;
  return snapshot.auth.workspaceId?.trim() || snapshot.auth.profileId?.trim() || undefined;
}

export function quotaHistoryMeter(driver: string, windowId: string): QuotaHistoryMeter {
  if (driver === "opencode" && windowId.startsWith("go_")) return "opencode_go";
  if (driver === "opencode" && windowId.startsWith("budget_")) return "opencode_console";
  return "upstream";
}

function reportWindow(driver: string, window: ServerProviderUsageWindow): QuotaHistoryWindow {
  return {
    id: window.id,
    kind: window.kind,
    label: window.label,
    usedPercent: window.usedPercent,
    ...(window.modelIds === undefined ? {} : { modelIds: window.modelIds }),
    ...(window.providerIds === undefined ? {} : { providerIds: window.providerIds }),
    ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
    ...(window.windowDurationMins === undefined
      ? {}
      : { windowDurationMins: window.windowDurationMins }),
    ...(window.spent === undefined ? {} : { spent: window.spent }),
    ...(window.limit === undefined ? {} : { limit: window.limit }),
    meter: quotaHistoryMeter(driver, window.id),
  };
}

function gapRecord(input: {
  readonly snapshot: QuotaHistorySourceSnapshot;
  readonly observedAt: string;
  readonly accountKey: string | undefined;
  readonly reason: QuotaHistoryGap["reason"];
}): QuotaHistoryGap {
  return {
    version: QUOTA_HISTORY_VERSION,
    kind: "gap",
    observedAt: input.observedAt,
    providerInstanceId: input.snapshot.providerInstanceId,
    driver: input.snapshot.driver,
    ...(input.accountKey === undefined ? {} : { accountKey: input.accountKey }),
    source: "probe",
    reason: input.reason,
  };
}

function timeOf(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function notAfter(left: string, right: string | undefined): boolean {
  if (right === undefined) return false;
  const leftTime = timeOf(left);
  const rightTime = timeOf(right);
  return leftTime !== undefined && rightTime !== undefined && leftTime <= rightTime;
}

export function advanceQuotaHistory(input: {
  readonly previous: QuotaHistoryInstanceState | undefined;
  readonly snapshot: QuotaHistorySourceSnapshot;
  readonly observedAt: string;
}): {
  readonly records: ReadonlyArray<QuotaHistoryRecord>;
  readonly next: QuotaHistoryInstanceState | undefined;
} {
  const { previous, snapshot, observedAt } = input;
  const usage = snapshot.usageLimits;
  const read = snapshot.usageRead;
  const accountKey = quotaAccountKey(snapshot);

  // Providers publish snapshots for enrichment and for unrelated health checks; only an
  // explicit read attempt describes usage. Inferring failures from checkedAt reported a gap
  // for every Antigravity health check before its asynchronous usage probe finished.
  if (read === undefined) return { records: [], next: previous };
  if (notAfter(read.attemptedAt, previous?.lastReadAt)) {
    return { records: [], next: previous };
  }

  // A new account starts fresh: its first failed probe is not a gap in the old account.
  const accountChanged =
    accountKey !== undefined &&
    previous?.accountKey !== undefined &&
    accountKey !== previous.accountKey;
  const carriedAccountKey = accountChanged ? accountKey : (accountKey ?? previous?.accountKey);
  const base = {
    lastReadAt: read.attemptedAt,
    hasReading: !accountChanged && previous?.hasReading === true,
    ...(carriedAccountKey === undefined ? {} : { accountKey: carriedAccountKey }),
    ...(!accountChanged && previous?.lastReadingCheckedAt !== undefined
      ? { lastReadingCheckedAt: previous.lastReadingCheckedAt }
      : {}),
  } satisfies QuotaHistoryInstanceState;

  if (read.outcome === "success" && usage !== undefined && usage.windows.length > 0) {
    // A cached value keeps its original timestamp and is not a new reading.
    if (notAfter(usage.checkedAt, previous?.lastReadingCheckedAt)) {
      return { records: [], next: base };
    }
    const record: QuotaHistoryReading = {
      version: QUOTA_HISTORY_VERSION,
      kind: "reading",
      observedAt,
      providerInstanceId: snapshot.providerInstanceId,
      driver: snapshot.driver,
      ...(accountKey === undefined ? {} : { accountKey }),
      source: read.source,
      checkedAt: usage.checkedAt,
      windows: usage.windows.map((window) => reportWindow(snapshot.driver, window)),
      ...(usage.resetCredits
        ? {
            resetCredits: {
              availableCount: usage.resetCredits.availableCount,
              ...(usage.resetCredits.nextExpiresAt === undefined
                ? {}
                : { nextExpiresAt: usage.resetCredits.nextExpiresAt }),
            },
          }
        : {}),
      ...(usage.zeroSpendCap ? { zeroSpendCap: true } : {}),
    };
    return {
      records: [record],
      next: {
        lastReadAt: read.attemptedAt,
        hasReading: true,
        lastReadingCheckedAt: usage.checkedAt,
        ...(accountKey === undefined ? {} : { accountKey }),
      },
    };
  }

  const reason =
    read.outcome === "unsupported" || usage?.unavailable?.reason === "unsupported"
      ? "unsupported"
      : "probeFailed";

  if (!base.hasReading) return { records: [], next: base };
  // An unsupported provider does not recover by retrying; record the transition once.
  if (reason === "unsupported" && previous?.unsupported === true) {
    return { records: [], next: { ...base, unsupported: true } };
  }

  const gapAccountKey = accountKey ?? previous?.accountKey;
  return {
    records: [
      gapRecord({
        snapshot,
        observedAt,
        accountKey: gapAccountKey,
        reason,
      }),
    ],
    next: {
      ...base,
      ...(gapAccountKey === undefined ? {} : { accountKey: gapAccountKey }),
      ...(reason === "unsupported" ? { unsupported: true as const } : {}),
    },
  };
}

export function quotaHistoryFilePath(logsDir: string, observedAt: string): string {
  return NodePath.join(
    logsDir,
    `quota-history-v${QUOTA_HISTORY_VERSION}-${observedAt.slice(0, 10)}.ndjson`,
  );
}

export function encodeQuotaHistoryRecord(record: QuotaHistoryRecord): string {
  return JSON.stringify(record);
}

const appendRecords = Effect.fn("QuotaHistoryRecorder.appendRecords")(function* (
  fs: FileSystem.FileSystem,
  logsDir: string,
  records: ReadonlyArray<QuotaHistoryRecord>,
) {
  if (records.length === 0) return;
  const byDay = new Map<string, string[]>();
  for (const record of records) {
    const filePath = quotaHistoryFilePath(logsDir, record.observedAt);
    const lines = byDay.get(filePath) ?? [];
    lines.push(encodeQuotaHistoryRecord(record));
    byDay.set(filePath, lines);
  }
  yield* fs.makeDirectory(logsDir, { recursive: true });
  yield* Effect.forEach(
    byDay,
    ([filePath, lines]) => fs.writeFileString(filePath, `${lines.join("\n")}\n`, { flag: "a" }),
    { discard: true },
  );
});

const OBSERVED_DRIVERS: ReadonlySet<string> = new Set(["antigravity", "codex", "opencode"]);

function sourceSnapshot(provider: ServerProvider): QuotaHistorySourceSnapshot {
  return {
    providerInstanceId: provider.instanceId,
    driver: provider.driver,
    checkedAt: provider.checkedAt,
    auth: provider.auth,
    ...(provider.usageLimits === undefined ? {} : { usageLimits: provider.usageLimits }),
    ...(provider.usageRead === undefined ? {} : { usageRead: provider.usageRead }),
  };
}

function isObservedInstance(provider: ServerProvider): boolean {
  return provider.enabled && provider.installed && OBSERVED_DRIVERS.has(provider.driver);
}

function shouldObserve(provider: ServerProvider): boolean {
  return (
    // Antigravity can read quota before a session reveals its sign-in state.
    provider.auth.status !== "unauthenticated" &&
    (provider.usageLimits !== undefined || provider.usageRead !== undefined)
  );
}

export class QuotaHistoryRecorder extends Context.Service<
  QuotaHistoryRecorder,
  {
    readonly observe: (providers: ReadonlyArray<ServerProvider>) => Effect.Effect<void>;
  }
>()("t3/usage/QuotaHistoryRecorder") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const states = yield* Ref.make(new Map<string, QuotaHistoryInstanceState>());
  const observeLock = yield* Semaphore.make(1);

  const observeProviders = Effect.fn("QuotaHistoryRecorder.observeProviders")(function* (
    providers: ReadonlyArray<ServerProvider>,
  ) {
    yield* Effect.forEach(
      providers,
      (provider) =>
        Effect.gen(function* () {
          if (!isObservedInstance(provider)) return;
          if (provider.auth.status === "unauthenticated") {
            // A signed-out instance must not lend its old account to the next sign-in.
            yield* Ref.update(states, (current) => {
              if (!current.has(provider.instanceId)) return current;
              const updated = new Map(current);
              updated.delete(provider.instanceId);
              return updated;
            });
            return;
          }
          if (!shouldObserve(provider)) return;
          const observedAt = DateTime.formatIso(yield* DateTime.now);
          const records = yield* Ref.modify(states, (current) => {
            const { records, next } = advanceQuotaHistory({
              previous: current.get(provider.instanceId),
              snapshot: sourceSnapshot(provider),
              observedAt,
            });
            const updated = new Map(current);
            if (next === undefined) updated.delete(provider.instanceId);
            else updated.set(provider.instanceId, next);
            return [records, updated] as const;
          });
          yield* appendRecords(fs, config.logsDir, records).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("quota history write failed", {
                providerInstanceId: provider.instanceId,
                cause,
              }),
            ),
          );
        }),
      { discard: true },
    );
  });

  const observe = Effect.fn("QuotaHistoryRecorder.observe")(function* (
    providers: ReadonlyArray<ServerProvider>,
  ) {
    yield* observeLock.withPermit(observeProviders(providers));
  });

  return QuotaHistoryRecorder.of({ observe });
});

export const layer = Layer.effect(QuotaHistoryRecorder, make);

/**
 * Providers whose last explicit usage read is older than the refresh interval.
 * A fresh `usageRead` means the foreground tick, a notification or an earlier
 * background sample already covered this interval.
 */
export function quotaHistorySampleIds(
  providers: ReadonlyArray<ServerProvider>,
  nowMs: number,
  intervalMs: number,
): ReadonlyArray<ServerProvider["instanceId"]> {
  if (intervalMs <= 0) return [];
  const due: Array<ServerProvider["instanceId"]> = [];
  for (const provider of providers) {
    if (!isObservedInstance(provider)) continue;
    if (provider.auth.status === "unauthenticated") continue;
    // An unsupported account has nothing to read; a missing reading can still recover.
    if (provider.usageLimits?.unavailable?.reason === "unsupported") continue;
    const attemptedAt = provider.usageRead?.attemptedAt;
    const attemptedMs = attemptedAt === undefined ? undefined : Date.parse(attemptedAt);
    if (
      attemptedMs !== undefined &&
      !Number.isNaN(attemptedMs) &&
      nowMs - attemptedMs < intervalMs
    ) {
      continue;
    }
    due.push(provider.instanceId);
  }
  return due;
}

export const collectorLayer: Layer.Layer<
  never,
  never,
  | ProviderRegistry.ProviderRegistry
  | ServerConfig.ServerConfig
  | FileSystem.FileSystem
  | BackgroundPolicy.BackgroundPolicy
  | ServerSettings.ServerSettingsService
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* ProviderRegistry.ProviderRegistry;
    const recorder = yield* QuotaHistoryRecorder;
    const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
    const serverSettings = yield* ServerSettings.ServerSettingsService;

    const subscription = yield* registry.subscribeChanges;
    // Read after subscribing, so a publication between the two is still observed.
    yield* registry.getProviders.pipe(
      Effect.flatMap(recorder.observe),
      Effect.catchCause((cause) =>
        Effect.logWarning("quota history baseline read failed", { cause }),
      ),
    );
    yield* Stream.fromSubscription(subscription).pipe(
      Stream.runForEach(recorder.observe),
      Effect.catchCause((cause) => Effect.logWarning("quota history collector stopped", { cause })),
      Effect.forkScoped,
    );

    // Foreground provider ticks pause without a foreground lease. This fallback keeps the
    // five-minute cadence during unfocused use, but only for a usage-only read and only
    // while a client is connected and the host is not suspended, locked or overheating.
    const sampleInterval = serverSettings.getSettings.pipe(
      Effect.map(
        (settings) =>
          resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
      ),
      Effect.orElseSucceed(() => DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL),
    );
    yield* Effect.forever(
      sampleInterval.pipe(
        Effect.flatMap((wait) => Effect.sleep(Duration.isPositive(wait) ? wait : "60 seconds")),
        Effect.andThen(
          Effect.gen(function* () {
            const intervalMs = Duration.toMillis(yield* sampleInterval);
            if (intervalMs <= 0) return;
            const providers = yield* registry.getProviders;
            const due = quotaHistorySampleIds(
              providers,
              yield* Clock.currentTimeMillis,
              intervalMs,
            );
            if (due.length === 0) return;
            if (!(yield* backgroundPolicy.shouldRunUsageSampling)) return;
            yield* Effect.logDebug("sampling provider usage for quota history", {
              instanceIds: due,
            });
            yield* Effect.forEach(due, registry.sampleUsage, {
              concurrency: 1,
              discard: true,
            });
          }),
        ),
        Effect.ignoreCause({ log: true }),
      ),
    ).pipe(Effect.forkScoped);
  }),
).pipe(Layer.provide(layer));
