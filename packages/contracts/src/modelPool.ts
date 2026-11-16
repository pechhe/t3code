import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId, ProviderPoolStrategy } from "./providerInstance.ts";

const MODEL_POOL_SLUG_MAX_CHARS = 64;
const MODEL_POOL_SLUG_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

export const ModelPoolId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(MODEL_POOL_SLUG_MAX_CHARS),
  Schema.isPattern(MODEL_POOL_SLUG_PATTERN),
).pipe(Schema.brand("ModelPoolId"));
export type ModelPoolId = typeof ModelPoolId.Type;

export const isModelPoolId = Schema.is(ModelPoolId);

export const ModelPoolSlot = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  enabled: Schema.optionalKey(Schema.Boolean),
});
export type ModelPoolSlot = typeof ModelPoolSlot.Type;

export const ModelPoolPolicy = Schema.Struct({
  /**
   * `spend` (the default) uses the slot whose allowance would lapse unused
   * soonest; `order` uses the first enabled slot in the pool's list with allowance.
   */
  strategy: Schema.optionalKey(ProviderPoolStrategy),
  /**
   * New threads and failover treat a slot as out once a window is this
   * percent used, keeping the rest in reserve. A running thread stays until
   * the slot's real limit.
   */
  reservePercent: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 99 })),
  ),
  /** Overrides the global "Switch pooled account on limit" for this pool. */
  switchOnLimit: Schema.optionalKey(Schema.Boolean),
});
export type ModelPoolPolicy = typeof ModelPoolPolicy.Type;

export const ModelPoolConfig = Schema.Struct({
  displayName: TrimmedNonEmptyString,
  enabled: Schema.optionalKey(Schema.Boolean),
  slots: Schema.Array(ModelPoolSlot),
  policy: Schema.optionalKey(ModelPoolPolicy),
});
export type ModelPoolConfig = typeof ModelPoolConfig.Type;

export const resolveModelPoolEnabled = (pool: Pick<ModelPoolConfig, "enabled">): boolean =>
  pool.enabled !== false;

export const isModelPoolSlotEnabled = (slot: Pick<ModelPoolSlot, "enabled">): boolean =>
  slot.enabled !== false;
