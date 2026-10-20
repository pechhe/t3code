import type {
  ProviderInstanceConfig,
  ProviderInstanceId,
  ProviderPoolPolicy,
} from "@t3tools/contracts";

/** Reserve choices offered in settings; any stored 1–99 value still applies. */
export const POOL_RESERVE_PRESETS = [70, 80, 90, 95] as const;

export type PoolSwitchOnLimit = "global" | "always" | "never";

export const poolSwitchOnLimitOf = (policy: ProviderPoolPolicy | undefined): PoolSwitchOnLimit =>
  policy?.switchOnLimit === undefined ? "global" : policy.switchOnLimit ? "always" : "never";

/**
 * The instance with `patch` applied to its pool policy. A field set back to its
 * default is dropped, and an empty policy is dropped whole, so a pool that
 * never left the defaults stays as the user wrote it.
 */
export function withPoolPolicy(
  instance: ProviderInstanceConfig,
  patch: {
    readonly strategy?: "spend" | "order";
    readonly disabledMembers?: ReadonlyArray<ProviderInstanceId>;
    readonly reservePercent?: number | null;
    readonly switchOnLimit?: PoolSwitchOnLimit;
  },
): ProviderInstanceConfig {
  const { poolPolicy: current, ...rest } = instance;
  const strategy = patch.strategy ?? current?.strategy;
  const disabledMembers = patch.disabledMembers ?? current?.disabledMembers;
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
  const next: ProviderPoolPolicy = {
    ...(strategy === "order" ? { strategy } : {}),
    ...(disabledMembers !== undefined && disabledMembers.length > 0 ? { disabledMembers } : {}),
    ...(reservePercent === undefined ? {} : { reservePercent }),
    ...(switchOnLimit === undefined ? {} : { switchOnLimit }),
  };
  return Object.keys(next).length === 0 ? rest : { ...rest, poolPolicy: next };
}
