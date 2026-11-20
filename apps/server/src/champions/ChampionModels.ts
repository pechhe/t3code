/**
 * Which model a Champion's own run uses (T3-814): the machine default or the Champion's override, then its backup
 * when no account can run the main model. "At its limit" is the thread definition: an account skipped after a
 * usage-limit failure, or a provider window at 100%. Pure so the service and its tests share one reading.
 */
import type {
  ChampionModelDefaults,
  ChampionModelOverrides,
  ChampionNextModels,
  ModelSelection,
  ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  accountIdOf,
  activeSkip,
  pooledModelKeyOf,
  isAccountFree,
  isProviderUsageExhausted,
  pooledModelOf,
  pooledModels,
  selectionOnAccount,
  type AccountRoutingSettings,
} from "@t3tools/shared/accountPools";

import { invalidOptionSelections } from "../provider/modelSelectionValidation.ts";

export type ChampionModelKind = "checks" | "advice";

export interface ModelSource {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: Pick<AccountRoutingSettings, "pooledModelKeys" | "accountSkips"> &
    Partial<AccountRoutingSettings>;
  readonly nowMs: number;
}

export type Assessment =
  | { readonly status: "ready"; readonly selection: ModelSelection }
  /** Every account is at its limit; `until` is the earliest return the provider gave, or null when it gave none. */
  | { readonly status: "limited"; readonly until: string | null; readonly pooled: boolean }
  /** The model is not installed, enabled or signed in on this machine. */
  | { readonly status: "missing" };

const earliest = (times: ReadonlyArray<string | null>): string | null => {
  const known = times.filter(
    (time): time is string => time !== null && Number.isFinite(Date.parse(time)),
  );
  if (known.length < times.length || known.length === 0) return null;
  return known.reduce((a, b) => (Date.parse(a) <= Date.parse(b) ? a : b));
};

const windowReset = (provider: ServerProvider, nowMs: number): string | null => {
  const exhausted =
    provider.usageLimits?.windows.filter(
      (window) =>
        window.usedPercent >= 100 &&
        (window.resetsAt === undefined || Date.parse(window.resetsAt) > nowMs),
    ) ?? [];
  const times = exhausted.map((window) => window.resetsAt ?? null);
  if (times.length === 0 || times.includes(null)) return null;
  // The last window to reset is the one that holds the provider back.
  return times.reduce((a, b) => (Date.parse(a!) >= Date.parse(b!) ? a : b));
};

const optionsAllowed = (provider: ServerProvider, selection: ModelSelection) =>
  invalidOptionSelections(
    selection.options ?? [],
    provider.models.find((model) => model.slug === selection.model)?.capabilities
      ?.optionDescriptors,
  ).length === 0;

const providerRunnable = (provider: ServerProvider | undefined, selection: ModelSelection) =>
  provider !== undefined &&
  provider.enabled !== false &&
  provider.installed !== false &&
  provider.status !== "error" &&
  provider.status !== "disabled" &&
  provider.availability !== "unavailable" &&
  provider.models.some((model) => model.slug === selection.model) &&
  optionsAllowed(provider, selection);

/** Whether one model can take a run now, resolving a pooled model to its first account that is not at its limit. */
export const assess = (selection: ModelSelection, source: ModelSource): Assessment => {
  const { providers, settings, nowMs } = source;
  const pool =
    selection.pinned === true
      ? undefined
      : pooledModelOf(pooledModels(providers, settings), selection);
  if (pool !== undefined) {
    const usable = pool.accounts.filter(
      (entry) =>
        !entry.removed && providerRunnable(entry.provider, { ...selection, model: entry.model }),
    );
    if (usable.length === 0) return { status: "missing" };
    const free = usable.find(
      (entry) =>
        isAccountFree(pool, entry, settings.accountSkips, nowMs) &&
        !isProviderUsageExhausted(entry.provider, nowMs),
    );
    if (free !== undefined)
      return { status: "ready", selection: selectionOnAccount(free, selection.options) };
    return {
      status: "limited",
      pooled: true,
      until: earliest(
        usable.map((entry) => {
          const skip = activeSkip(settings.accountSkips, entry.account.id, pool.key, nowMs);
          const window = isProviderUsageExhausted(entry.provider, nowMs)
            ? windowReset(entry.provider, nowMs)
            : null;
          return (skip?.reportedReset === true ? skip.until : null) ?? window;
        }),
      ),
    };
  }
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  if (!providerRunnable(provider, selection)) return { status: "missing" };
  if (isProviderUsageExhausted(provider!, nowMs))
    return { status: "limited", pooled: false, until: windowReset(provider!, nowMs) };
  // A model one account serves has no pool, yet a usage-limit failure still skips its account by key.
  const model = provider!.models.find((candidate) => candidate.slug === selection.model);
  const key =
    model === undefined || typeof model.name !== "string"
      ? undefined
      : pooledModelKeyOf(provider!, model);
  if (key !== undefined) {
    const skip = activeSkip(
      settings.accountSkips,
      accountIdOf(provider!, selection.model),
      key,
      nowMs,
    );
    if (skip !== undefined)
      return { status: "limited", pooled: false, until: skip.reportedReset ? skip.until : null };
  }
  return { status: "ready", selection };
};

/** The source with the failed run's account skipped for its model; a time that was not reported stays unknown. */
const withFailedAccountSkipped = (
  source: ModelSource,
  failed: { readonly selection: ModelSelection; readonly until: string | null },
): ModelSource | undefined => {
  const provider = source.providers.find(
    (candidate) => candidate.instanceId === failed.selection.instanceId,
  );
  const model = provider?.models.find((candidate) => candidate.slug === failed.selection.model);
  if (provider === undefined || model === undefined || typeof model.name !== "string")
    return undefined;
  const key = pooledModelKeyOf(provider, model);
  if (key === undefined) return undefined;
  const account = accountIdOf(provider, failed.selection.model);
  const until =
    failed.until ?? DateTime.formatIso(DateTime.makeUnsafe(source.nowMs + 60 * 60 * 1000));
  return {
    ...source,
    settings: {
      ...source.settings,
      accountSkips: {
        ...source.settings.accountSkips,
        [account]: {
          ...source.settings.accountSkips[account],
          [key]: { until, reportedReset: failed.until !== null },
        },
      },
    },
  };
};

export interface SlotChoice {
  readonly main: ModelSelection;
  readonly backup?: ModelSelection | undefined;
}

export interface SlotAssessment {
  readonly main: Assessment;
  readonly backup: Assessment | null;
}

/**
 * The slot a run uses: the main model, else the backup. `failed` is a run that just ended on a usage limit on
 * `selection`: the provider's own reading may not show it yet, so that model counts as limited until `until`.
 */
export const pickSlot = (
  slot: SlotChoice,
  source: ModelSource,
  options?: {
    readonly failed?:
      | { readonly selection: ModelSelection; readonly until: string | null }
      | undefined;
  },
): {
  readonly use: { selection: ModelSelection; slot: "main" | "backup" } | null;
} & SlotAssessment => {
  // A run that just died on the limit proves its account limited before the skip or the provider's own reading
  // lands, so a same-model judgement counts that account as skipped: another account still serves a pooled model.
  const failed = options?.failed;
  const skipped = failed === undefined ? undefined : withFailedAccountSkipped(source, failed);
  const judge = (selection: ModelSelection): Assessment => {
    const current = assess(selection, skipped ?? source);
    // A model with no pool key (a generic slug such as `default`) cannot be skipped by key: the failed model itself is limited.
    return failed !== undefined &&
      skipped === undefined &&
      current.status === "ready" &&
      failed.selection.instanceId === current.selection.instanceId &&
      failed.selection.model === current.selection.model
      ? { status: "limited", pooled: false, until: failed.until }
      : current;
  };
  const main = judge(slot.main);
  const backup = slot.backup === undefined ? null : judge(slot.backup);
  if (main.status === "ready")
    return { use: { selection: main.selection, slot: "main" }, main, backup };
  if (backup?.status === "ready")
    return { use: { selection: backup.selection, slot: "backup" }, main, backup };
  return { use: null, main, backup };
};

/** The default and override for one kind, as one slot: the override replaces only the main model. */
export const slotFor = (
  kind: ChampionModelKind,
  defaults: ChampionModelDefaults | undefined,
  overrides: ChampionModelOverrides | undefined,
): { readonly slot: SlotChoice; readonly source: "default" | "champion" } | null => {
  const base = defaults?.[kind];
  const own = overrides?.[kind];
  if (own !== undefined) return { slot: { main: own, backup: base?.backup }, source: "champion" };
  return base === undefined
    ? null
    : { slot: { main: base.model, backup: base.backup }, source: "default" };
};

export const nextModels = (
  defaults: ChampionModelDefaults | undefined,
  overrides: ChampionModelOverrides | undefined,
): ChampionNextModels => {
  const checks = slotFor("checks", defaults, overrides);
  const advice = slotFor("advice", defaults, overrides);
  return {
    ...(checks === null
      ? {}
      : {
          checks: {
            model: checks.slot.main,
            ...(checks.slot.backup === undefined ? {} : { backup: checks.slot.backup }),
            source: checks.source,
          },
        }),
    ...(advice === null
      ? {}
      : {
          advice: {
            model: advice.slot.main,
            ...(advice.slot.backup === undefined ? {} : { backup: advice.slot.backup }),
            source: advice.source,
          },
        }),
  };
};

const modelName = (providers: ReadonlyArray<ServerProvider>, selection: ModelSelection) =>
  providers
    .find((provider) => provider.instanceId === selection.instanceId)
    ?.models.find((model) => model.slug === selection.model)?.name ?? selection.model;

/** Henry reads times in London, labelled with the zone. */
export const formatLondon = (iso: string): string => {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(DateTime.toDate(DateTime.makeUnsafe(iso)));
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("day")} ${part("month")}, ${part("hour")}:${part("minute")} ${part("timeZoneName")}`;
};

const unavailable = (
  providers: ReadonlyArray<ServerProvider>,
  selection: ModelSelection,
  assessment: Assessment,
) => {
  const name = modelName(providers, selection);
  if (assessment.status === "missing") return `${name} is not available on this machine`;
  if (assessment.status === "limited")
    return `${name} is at its limit${assessment.pooled ? " on every account" : ""} until ${
      assessment.until === null
        ? "a time the provider did not give"
        : formatLondon(assessment.until)
    }`;
  return name;
};

/** The one line a skipped run leaves for Henry: both models, when each returns, and when the next check starts. */
export const skipMessage = (input: {
  readonly what: "check" | "setup" | "advice";
  readonly slot: SlotChoice;
  readonly assessed: SlotAssessment;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly nextCheckAt?: string | null | undefined;
}): string => {
  const main = unavailable(input.providers, input.slot.main, input.assessed.main);
  const backup =
    input.slot.backup === undefined || input.assessed.backup === null
      ? ""
      : `, and the backup ${unavailable(input.providers, input.slot.backup, input.assessed.backup)}`;
  const next =
    input.what === "check" && input.nextCheckAt != null
      ? ` Next check ${formatLondon(input.nextCheckAt)}.`
      : "";
  return `Skipped this ${input.what}: ${main}${backup}.${next}`;
};
