/**
 * Model pools: a named, ordered list of `(providerInstanceId, model)` slots across
 * providers and Pi sub-providers, routed by the same allowance rules as account pools.
 *
 * @module modelPools
 */
import {
  isModelPoolSlotEnabled,
  resolveModelPoolEnabled,
  type ModelPoolConfig,
  type ModelPoolId,
  type ModelPoolSlot,
  type ModelSelection,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";

import {
  type AccountStanding,
  antigravityWindowGoverns,
  isProviderRoutable,
  piAccountKeyOf,
  USAGE_REFRESH_NEAR_LIMIT_PERCENT,
  USAGE_REFRESH_STALE_MS,
  windowsSpendUrgency,
  usageMeterOf,
  windowsUsableAgainMs,
} from "./providerPools.ts";

interface ModelPoolSlotTarget {
  readonly slot: ModelPoolSlot;
  readonly provider: ServerProvider;
}

const STANDING_RANK: Record<AccountStanding, number> = { available: 0, unknown: 1, out: 2 };
const REASONING_OPTION_IDS = new Set([
  "reasoningEffort",
  "reasoning_effort",
  "effort",
  "thinking",
  "thought_level",
]);

export const modelPoolLimitPercentOf = (pool: Pick<ModelPoolConfig, "policy">): number =>
  pool.policy?.reservePercent ?? 100;

/**
 * The usage reading governing `(provider, model)`: a Pi slot reads its own sub-provider
 * entry (leaving unprobed slots with `undefined`, never the instance), while single-account
 * providers read `provider.usageLimits`.
 */
const slotUsageLimits = (
  provider: ServerProvider | undefined,
  model: string,
): ServerProviderUsageLimits | undefined => {
  if (provider === undefined) return undefined;
  if (provider.driver === "pi") {
    const accountKey = piAccountKeyOf(model);
    return accountKey === undefined
      ? undefined
      : provider.usageSlots?.find((slot) => slot.accountKey === accountKey)?.usageLimits;
  }
  return provider.usageLimits;
};

/** Usage windows governing `model` on `provider`, preserving driver-specific window scoping. */
export const applicableSlotUsageWindows = (
  provider: ServerProvider | undefined,
  model: string,
): ReadonlyArray<ServerProviderUsageWindow> => {
  const windows = (slotUsageLimits(provider, model)?.windows ?? []).filter(
    (window) =>
      (window.modelIds === undefined || window.modelIds.includes(model)) &&
      (window.providerIds === undefined || window.providerIds.includes(model.split("/")[0] ?? "")),
  );
  if (provider === undefined) return windows;
  switch (usageMeterOf(provider, model)) {
    case "cursor": {
      const api = windows.filter((window) => window.id === "apiPercentUsed");
      const auto = windows.filter((window) => window.id === "autoPercentUsed");
      return /^(auto|default|grok|composer)/.test(model) ? [...auto, ...api] : api;
    }
    case "antigravity":
      return windows.filter((window) => antigravityWindowGoverns(window.id, model));
    case "codex": {
      const hasPlanWindows = windows.some(
        (window) => window.id === "primary" || window.id === "secondary",
      );
      return windows.filter((window) => window.id !== "individual" || !hasPlanWindows);
    }
    case "opencode":
      return windows.filter(
        (window) => !window.id.startsWith("go_") || model.startsWith("opencode-go/"),
      );
    default:
      return windows;
  }
};

export const isSlotUsageExhausted = (
  provider: ServerProvider | undefined,
  model: string,
  nowMs: number,
  limitPercent = 100,
): boolean =>
  slotUsageLimits(provider, model)?.assumedAvailable !== true &&
  applicableSlotUsageWindows(provider, model).some(
    (window) =>
      (window.usedPercent ?? 0) >= limitPercent &&
      (window.resetsAt === undefined ||
        !Number.isFinite(Date.parse(window.resetsAt)) ||
        Date.parse(window.resetsAt) > nowMs),
  );

export const needsSlotUsageRefresh = (
  provider: ServerProvider | undefined,
  model: string,
  nowMs: number,
): boolean => {
  const usage = slotUsageLimits(provider, model);
  if (usage === undefined || nowMs - Date.parse(usage.checkedAt) < USAGE_REFRESH_STALE_MS) {
    return false;
  }
  return applicableSlotUsageWindows(provider, model).some(
    (window) =>
      window.usedPercent >= USAGE_REFRESH_NEAR_LIMIT_PERCENT &&
      (window.resetsAt === undefined || Date.parse(window.resetsAt) > nowMs),
  );
};

export const slotStanding = (
  provider: ServerProvider | undefined,
  model: string,
  nowMs: number,
  limitPercent = 100,
): AccountStanding => {
  if (isSlotUsageExhausted(provider, model, nowMs, limitPercent)) return "out";
  return applicableSlotUsageWindows(provider, model).length > 0 ? "available" : "unknown";
};

export const isModelPoolSlotConserved = (provider: ServerProvider, model: string): boolean => {
  const conservation = provider.subagentConservation;
  return (
    conservation !== undefined &&
    conservation.state !== "ready" &&
    conservation.models.includes(model)
  );
};

const isModelPoolSlotRoutable = (
  slot: ModelPoolSlot,
  provider: ServerProvider | undefined,
  options?: {
    readonly readOnly?: boolean | undefined;
    readonly enforceConservation?: boolean | undefined;
  },
): provider is ServerProvider => {
  if (!isModelPoolSlotEnabled(slot)) return false;
  if (provider === undefined || provider.poolMembers !== undefined || !isProviderRoutable(provider))
    return false;
  if (provider.models.length > 0 && !provider.models.some((model) => model.slug === slot.model))
    return false;
  if (options?.readOnly && provider.readOnlySourceAccess !== "enforced") return false;
  if (options?.enforceConservation && isModelPoolSlotConserved(provider, slot.model)) return false;
  return true;
};

const routableModelPoolSlots = (
  pool: ModelPoolConfig,
  providers: ReadonlyArray<ServerProvider>,
  options?: {
    readonly readOnly?: boolean | undefined;
    readonly enforceConservation?: boolean | undefined;
  },
): ReadonlyArray<ModelPoolSlotTarget> => {
  if (!resolveModelPoolEnabled(pool)) return [];
  const seen = new Set<string>();
  return pool.slots.flatMap((slot) => {
    const key = `${slot.providerInstanceId}\0${slot.model}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const provider = providers.find(
      (candidate) => candidate.instanceId === slot.providerInstanceId,
    );
    return isModelPoolSlotRoutable(slot, provider, options) ? [{ slot, provider }] : [];
  });
};

export const rankModelPoolSlots = (input: {
  readonly pool: ModelPoolConfig;
  readonly targets: ReadonlyArray<ModelPoolSlotTarget>;
  readonly nowMs: number;
}): ReadonlyArray<ModelPoolSlotTarget> => {
  const limitPercent = modelPoolLimitPercentOf(input.pool);
  const strategy = input.pool.policy?.strategy ?? "spend";
  const indexOf = new Map(input.targets.map((target, index) => [target, index]));
  return [...input.targets].sort((a, b) => {
    const aStanding = slotStanding(a.provider, a.slot.model, input.nowMs, limitPercent);
    const bStanding = slotStanding(b.provider, b.slot.model, input.nowMs, limitPercent);
    // Under My order a slot with no reading counts as available, so it keeps its place.
    const rank = (standing: AccountStanding) =>
      strategy === "order" && standing === "unknown"
        ? STANDING_RANK.available
        : STANDING_RANK[standing];
    const standingDiff = rank(aStanding) - rank(bStanding);
    if (standingDiff !== 0) return standingDiff;
    if (aStanding === "out") {
      const aUntil = windowsUsableAgainMs(
        applicableSlotUsageWindows(a.provider, a.slot.model),
        input.nowMs,
        limitPercent,
      );
      const bUntil = windowsUsableAgainMs(
        applicableSlotUsageWindows(b.provider, b.slot.model),
        input.nowMs,
        limitPercent,
      );
      return aUntil - bUntil || (indexOf.get(a) ?? 0) - (indexOf.get(b) ?? 0);
    }
    if (strategy === "order") {
      return (indexOf.get(a) ?? 0) - (indexOf.get(b) ?? 0);
    }
    const urgencyA = windowsSpendUrgency(
      applicableSlotUsageWindows(a.provider, a.slot.model),
      input.nowMs,
    );
    const urgencyB = windowsSpendUrgency(
      applicableSlotUsageWindows(b.provider, b.slot.model),
      input.nowMs,
    );
    return (
      urgencyA.tier - urgencyB.tier ||
      urgencyA.deadlineMs - urgencyB.deadlineMs ||
      (indexOf.get(a) ?? 0) - (indexOf.get(b) ?? 0)
    );
  });
};

export const pickModelPoolSlot = (input: {
  readonly pool: ModelPoolConfig;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly nowMs: number;
  readonly current?:
    | { readonly instanceId: ProviderInstanceId; readonly model: string }
    | undefined;
  readonly readOnly?: boolean | undefined;
  readonly enforceConservation?: boolean | undefined;
}): ModelPoolSlotTarget | undefined => {
  const targets = routableModelPoolSlots(input.pool, input.providers, {
    readOnly: input.readOnly,
    enforceConservation: input.enforceConservation,
  });
  if (targets.length === 0) return undefined;
  if (input.current !== undefined) {
    const current = targets.find(
      (target) =>
        target.slot.providerInstanceId === input.current?.instanceId &&
        target.slot.model === input.current.model,
    );
    if (
      current !== undefined &&
      !isSlotUsageExhausted(current.provider, current.slot.model, input.nowMs, 100)
    ) {
      return current;
    }
  }
  return rankModelPoolSlots({ pool: input.pool, targets, nowMs: input.nowMs })[0];
};

export const pickModelPoolFailoverSlot = (input: {
  readonly pool: ModelPoolConfig;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly nowMs: number;
  readonly limited: { readonly instanceId: ProviderInstanceId; readonly model: string };
  readonly readOnly?: boolean | undefined;
  readonly enforceConservation?: boolean | undefined;
}): ModelPoolSlotTarget | undefined => {
  const limitPercent = modelPoolLimitPercentOf(input.pool);
  const targets = routableModelPoolSlots(input.pool, input.providers, {
    readOnly: input.readOnly,
    enforceConservation: input.enforceConservation,
  }).filter(
    (target) =>
      !(
        target.slot.providerInstanceId === input.limited.instanceId &&
        target.slot.model === input.limited.model
      ) && !isSlotUsageExhausted(target.provider, target.slot.model, input.nowMs, limitPercent),
  );
  return rankModelPoolSlots({ pool: input.pool, targets, nowMs: input.nowMs })[0];
};

const isReasoningDescriptor = (descriptor: ProviderOptionDescriptor): boolean =>
  (descriptor.type === "select" && descriptor.role === "reasoning") ||
  REASONING_OPTION_IDS.has(descriptor.id);

/**
 * Resolves a concrete `ModelSelection` for `slot`, carrying `poolId` and translating
 * compatible reasoning/trait options to the target slot's descriptors while dropping
 * options the target slot does not offer.
 */
export const adaptModelSelectionForSlot = (input: {
  readonly poolId: ModelPoolId;
  readonly slot: ModelPoolSlot;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly baseOptions?: ReadonlyArray<ProviderOptionSelection> | undefined;
}): ModelSelection => {
  const provider = input.providers.find(
    (candidate) => candidate.instanceId === input.slot.providerInstanceId,
  );
  const model = provider?.models.find((candidate) => candidate.slug === input.slot.model);
  const descriptors = model?.capabilities?.optionDescriptors;
  if (descriptors === undefined) {
    // Minimal tests with empty model catalogs pass options straight through; real catalogs with
    // no descriptors drop incompatible options from another driver.
    const keepOptions =
      provider !== undefined && provider.models.length === 0 ? input.baseOptions : undefined;
    return {
      instanceId: input.slot.providerInstanceId,
      model: input.slot.model,
      poolId: input.poolId,
      ...(keepOptions !== undefined && keepOptions.length > 0 ? { options: keepOptions } : {}),
    };
  }
  const nextOptions: ProviderOptionSelection[] = [];
  const baseOptions = input.baseOptions ?? [];
  const requestedReasoning = baseOptions.find(
    (option) => typeof option.value === "string" && REASONING_OPTION_IDS.has(option.id),
  );
  for (const descriptor of descriptors) {
    const exact = baseOptions.find((option) => option.id === descriptor.id);
    if (exact !== undefined) {
      if (
        descriptor.type === "select" &&
        typeof exact.value === "string" &&
        descriptor.options.some((choice) => choice.id === exact.value)
      ) {
        nextOptions.push({ id: descriptor.id, value: exact.value });
        continue;
      }
      if (descriptor.type === "boolean" && typeof exact.value === "boolean") {
        nextOptions.push({ id: descriptor.id, value: exact.value });
        continue;
      }
    }
    if (
      descriptor.type === "select" &&
      isReasoningDescriptor(descriptor) &&
      requestedReasoning !== undefined &&
      typeof requestedReasoning.value === "string" &&
      descriptor.options.some((choice) => choice.id === requestedReasoning.value)
    ) {
      nextOptions.push({ id: descriptor.id, value: requestedReasoning.value });
    }
  }
  return {
    instanceId: input.slot.providerInstanceId,
    model: input.slot.model,
    poolId: input.poolId,
    ...(nextOptions.length > 0 ? { options: nextOptions } : {}),
  };
};

/** The pool's accounts in order, as the picker shows them beneath its name. */
export const formatModelPoolSummary = (
  pool: ModelPoolConfig,
  providers: ReadonlyArray<ServerProvider>,
): string => {
  const enabled = pool.slots.filter(isModelPoolSlotEnabled);
  if (enabled.length === 0) return "No accounts switched on";
  const labels = enabled.map((slot) => {
    const provider = providers.find(
      (candidate) => candidate.instanceId === slot.providerInstanceId,
    );
    const accountKey = provider?.driver === "pi" ? piAccountKeyOf(slot.model) : undefined;
    if (accountKey !== undefined) {
      return (
        provider?.usageSlots?.find((entry) => entry.accountKey === accountKey)?.label ?? accountKey
      );
    }
    return provider?.displayName ?? String(slot.providerInstanceId);
  });
  return labels.length > 3
    ? `${labels.slice(0, 3).join(" → ")} +${labels.length - 3}`
    : labels.join(" → ");
};
