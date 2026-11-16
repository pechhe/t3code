import type {
  ModelPoolConfig,
  ModelPoolId,
  ModelPoolPolicy,
  ModelPoolSlot,
  ServerProvider,
} from "@t3tools/contracts";
import { isModelPoolId } from "@t3tools/contracts";
import { piAccountKeyOf } from "@t3tools/shared/providerPools";

import type { PoolSwitchOnLimit } from "./PoolAccountsSection.logic";

export const slotKeyOf = (slot: Pick<ModelPoolSlot, "providerInstanceId" | "model">): string =>
  `${slot.providerInstanceId}\u0000${slot.model}`;

/** A fresh pool id derived from its name, unique among `existing`. */
export function modelPoolIdFor(name: string, existing: ReadonlyArray<string>): ModelPoolId {
  const base =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^[^a-z]+/, "")
      .replace(/-+$/, "")
      .slice(0, 56) || "pool";
  let candidate = base;
  for (let suffix = 2; existing.includes(candidate); suffix += 1) {
    candidate = `${base}-${suffix}`;
  }
  if (!isModelPoolId(candidate)) throw new Error(`Invalid model pool id: ${candidate}`);
  return candidate;
}

/** The provider account a slot draws on: a Pi sub-provider's own label, or the instance. */
export function slotAccountLabel(
  slot: Pick<ModelPoolSlot, "providerInstanceId" | "model">,
  providers: ReadonlyArray<ServerProvider>,
): string {
  const provider = providers.find((candidate) => candidate.instanceId === slot.providerInstanceId);
  const instanceLabel = provider?.displayName ?? String(slot.providerInstanceId);
  const accountKey = provider?.driver === "pi" ? piAccountKeyOf(slot.model) : undefined;
  if (accountKey === undefined) return instanceLabel;
  const account =
    provider?.usageSlots?.find((entry) => entry.accountKey === accountKey)?.label ?? accountKey;
  return `${instanceLabel} · ${account}`;
}

export function slotModelLabel(
  slot: Pick<ModelPoolSlot, "providerInstanceId" | "model">,
  providers: ReadonlyArray<ServerProvider>,
): string {
  const provider = providers.find((candidate) => candidate.instanceId === slot.providerInstanceId);
  return provider?.models.find((model) => model.slug === slot.model)?.name ?? slot.model;
}

interface SlotChoice {
  readonly slot: ModelPoolSlot;
  readonly account: string;
  readonly model: string;
}

/** Every `(instance, model)` a pool can add, grouped by account, minus the slots it already has. */
export function slotChoices(
  pool: ModelPoolConfig,
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<{ readonly account: string; readonly choices: ReadonlyArray<SlotChoice> }> {
  const taken = new Set(pool.slots.map(slotKeyOf));
  const groups = new Map<string, SlotChoice[]>();
  for (const provider of providers) {
    if (provider.poolMembers !== undefined || !provider.enabled) continue;
    for (const model of provider.models) {
      const slot: ModelPoolSlot = { providerInstanceId: provider.instanceId, model: model.slug };
      if (taken.has(slotKeyOf(slot))) continue;
      const account = slotAccountLabel(slot, providers);
      const choices = groups.get(account) ?? [];
      choices.push({ slot, account, model: model.name });
      groups.set(account, choices);
    }
  }
  return [...groups].map(([account, choices]) => ({ account, choices }));
}

export function withSlots(pool: ModelPoolConfig, slots: ReadonlyArray<ModelPoolSlot>) {
  return { ...pool, slots };
}

export function withSlotEnabled(
  pool: ModelPoolConfig,
  key: string,
  enabled: boolean,
): ModelPoolConfig {
  return withSlots(
    pool,
    pool.slots.map((slot) => {
      if (slotKeyOf(slot) !== key) return slot;
      const { enabled: _enabled, ...rest } = slot;
      return enabled ? rest : { ...rest, enabled: false };
    }),
  );
}

export const modelPoolSwitchOnLimitOf = (policy: ModelPoolPolicy | undefined): PoolSwitchOnLimit =>
  policy?.switchOnLimit === undefined ? "global" : policy.switchOnLimit ? "always" : "never";

/** The pool with `patch` applied to its policy, dropping fields set back to their default. */
export function withModelPoolPolicy(
  pool: ModelPoolConfig,
  patch: {
    readonly strategy?: "spend" | "order";
    readonly reservePercent?: number | null;
    readonly switchOnLimit?: PoolSwitchOnLimit;
  },
): ModelPoolConfig {
  const { policy: current, ...rest } = pool;
  const strategy = patch.strategy ?? current?.strategy;
  const reservePercent =
    patch.reservePercent === undefined
      ? current?.reservePercent
      : (patch.reservePercent ?? undefined);
  const switchOnLimit =
    patch.switchOnLimit === undefined
      ? current?.switchOnLimit
      : patch.switchOnLimit === "global"
        ? undefined
        : patch.switchOnLimit === "always";
  const next: ModelPoolPolicy = {
    ...(strategy === "order" ? { strategy } : {}),
    ...(reservePercent === undefined ? {} : { reservePercent }),
    ...(switchOnLimit === undefined ? {} : { switchOnLimit }),
  };
  return Object.keys(next).length === 0 ? rest : { ...rest, policy: next };
}
