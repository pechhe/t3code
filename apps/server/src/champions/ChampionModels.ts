/**
 * Which model a Champion's own run uses (T3-814): the machine default or the Champion's override, then its backup
 * when no account can run the main model. "At its limit" is Model routing's one evaluator: an account out of usage,
 * held at its reserve or cooling down after failed runs. Pure so the service and its tests share one reading.
 */
import type {
  AccountBlock,
  ChampionModelDefaults,
  ChampionModelOverrides,
  ChampionNextModels,
  ModelSelection,
  ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  accountIdOf,
  pooledKeyIn,
  pooledModelOf,
  pooledModels,
  rankAccounts,
  selectionOnAccount,
  standaloneAvailability,
  type AccountRoutingSettings,
} from "@t3tools/shared/accountPools";

import { ACCOUNT_BACKOFF_MS } from "../provider/AccountAvailability.ts";
import { invalidOptionSelections } from "../provider/modelSelectionValidation.ts";

export type ChampionModelKind = "checks" | "advice";

export interface ModelSource {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: AccountRoutingSettings;
  /** The server's runtime blocks on accounts. */
  readonly blocks: ReadonlyArray<AccountBlock>;
  readonly nowMs: number;
}

export type Assessment =
  | { readonly status: "ready"; readonly selection: ModelSelection }
  /** Every account is held back; `until` is the earliest known return, or null when none is known. */
  | { readonly status: "limited"; readonly until: string | null; readonly pooled: boolean }
  /** The model is not installed, enabled or signed in on this machine. */
  | { readonly status: "missing" };

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

const earliest = (times: ReadonlyArray<string | undefined>): string | null => {
  const known = times.flatMap((time) =>
    time !== undefined && Number.isFinite(Date.parse(time)) ? [Date.parse(time)] : [],
  );
  return known.length === 0 ? null : DateTime.formatIso(DateTime.makeUnsafe(Math.min(...known)));
};

/** Whether one model can take a run now, resolving a routed model to the first available account. */
export const assess = (selection: ModelSelection, source: ModelSource): Assessment => {
  const { providers, settings } = source;
  const context = { blocks: source.blocks, nowMs: source.nowMs };
  const pool =
    selection.pinned === true
      ? undefined
      : pooledModelOf(pooledModels(providers, settings), selection);
  if (pool !== undefined) {
    const usable = rankAccounts(pool, context).filter(({ entry }) =>
      providerRunnable(entry.provider, { ...selection, model: entry.model }),
    );
    if (usable.length === 0) return { status: "missing" };
    const free = usable.find(({ availability }) => availability.state === "available");
    if (free !== undefined)
      return { status: "ready", selection: selectionOnAccount(free.entry, selection.options) };
    return {
      status: "limited",
      pooled: usable.length > 1,
      until: earliest(usable.map(({ availability }) => availability.returnsAt)),
    };
  }
  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  if (!providerRunnable(provider, selection)) return { status: "missing" };
  const availability = standaloneAvailability(settings, provider!, selection.model, context);
  return availability.state === "available"
    ? { status: "ready", selection }
    : { status: "limited", pooled: false, until: availability.returnsAt ?? null };
};

/** The source with the failed run's account blocked for its model, as the server will block it: to its reset, else its first backoff. */
const withFailedAccountBlocked = (
  source: ModelSource,
  failed: { readonly selection: ModelSelection; readonly until: string | null },
): ModelSource | undefined => {
  const provider = source.providers.find(
    (candidate) => candidate.instanceId === failed.selection.instanceId,
  );
  const model = provider?.models.find((candidate) => candidate.slug === failed.selection.model);
  if (provider === undefined || model === undefined || typeof model.name !== "string")
    return undefined;
  const key = pooledKeyIn(source.settings, provider, model);
  if (key === undefined) return undefined;
  const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
  const block: AccountBlock = {
    account: accountIdOf(provider, failed.selection.model),
    model: key,
    reason: "usage-limit",
    since: iso(source.nowMs),
    until: failed.until ?? iso(source.nowMs + ACCOUNT_BACKOFF_MS[0]!),
    reportedReset: failed.until !== null,
    attempts: 1,
  };
  return { ...source, blocks: [block, ...source.blocks] };
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
  // A run that just died on the limit proves its account limited before the server's block or the provider's own
  // reading lands, so a same-model judgement counts that account as blocked: another account still serves a routed model.
  const failed = options?.failed;
  const blocked = failed === undefined ? undefined : withFailedAccountBlocked(source, failed);
  const judge = (selection: ModelSelection): Assessment => {
    const current = assess(selection, blocked ?? source);
    // A model with no pool key (a generic slug such as `default`) cannot be blocked by key: the failed model itself is limited.
    return failed !== undefined &&
      blocked === undefined &&
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
  readonly what: "check" | "setup" | "advice" | "review";
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
