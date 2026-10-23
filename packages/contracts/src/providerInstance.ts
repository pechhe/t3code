import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const PROVIDER_SLUG_MAX_CHARS = 64;
const PROVIDER_SLUG_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const ENVIRONMENT_VARIABLE_NAME_MAX_CHARS = 128;
const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

const slugSchema = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PROVIDER_SLUG_MAX_CHARS),
  Schema.isPattern(PROVIDER_SLUG_PATTERN),
);

export const ProviderDriverKind = slugSchema.pipe(Schema.brand("ProviderDriverKind"));
export type ProviderDriverKind = typeof ProviderDriverKind.Type;

const isProviderDriverKindValue = Schema.is(ProviderDriverKind);
export const isProviderDriverKind = (value: unknown): value is ProviderDriverKind =>
  isProviderDriverKindValue(value);

export const ProviderInstanceId = slugSchema.pipe(Schema.brand("ProviderInstanceId"));
export type ProviderInstanceId = typeof ProviderInstanceId.Type;

export const ProviderInstanceRef = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
});
export type ProviderInstanceRef = typeof ProviderInstanceRef.Type;

export const ProviderInstanceEnvironmentVariableName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(ENVIRONMENT_VARIABLE_NAME_MAX_CHARS),
  Schema.isPattern(ENVIRONMENT_VARIABLE_NAME_PATTERN),
);
export type ProviderInstanceEnvironmentVariableName =
  typeof ProviderInstanceEnvironmentVariableName.Type;

export const ProviderInstanceEnvironmentVariable = Schema.Struct({
  name: ProviderInstanceEnvironmentVariableName,
  value: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  sensitive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  valueRedacted: Schema.optionalKey(Schema.Boolean),
});
export type ProviderInstanceEnvironmentVariable = typeof ProviderInstanceEnvironmentVariable.Type;

export const ProviderInstanceEnvironment = Schema.Array(ProviderInstanceEnvironmentVariable);
export type ProviderInstanceEnvironment = typeof ProviderInstanceEnvironment.Type;

export const ProviderPoolStrategy = Schema.Literals(["spend", "order"]);
export type ProviderPoolStrategy = typeof ProviderPoolStrategy.Type;

/** How an account pool picks and moves between its members; every field defaults when absent. */
export const ProviderPoolPolicy = Schema.Struct({
  /**
   * `spend` (the default) uses the member whose allowance would lapse unused
   * soonest; `order` uses the first member in the pool's list with allowance.
   */
  strategy: Schema.optionalKey(ProviderPoolStrategy),
  /** Members kept in the pool's list but never routed to. */
  disabledMembers: Schema.optionalKey(Schema.Array(ProviderInstanceId)),
  /**
   * New threads and failover treat a member as out once a window is this
   * percent used, keeping the rest in reserve. A running thread stays until
   * the member's real limit.
   */
  reservePercent: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 99 })),
  ),
  /** Overrides the global "Switch pooled account on limit" for this pool. */
  switchOnLimit: Schema.optionalKey(Schema.Boolean),
});
export type ProviderPoolPolicy = typeof ProviderPoolPolicy.Type;

/**
 * The driver-specific config payload is left as `Schema.Unknown`; each driver
 * registers its own decoder with the runtime registry, and envelopes for
 * unknown drivers are preserved verbatim so they round-trip across version
 * changes without data loss.
 */
export const ProviderInstanceConfig = Schema.Struct({
  driver: ProviderDriverKind,
  displayName: Schema.optional(TrimmedNonEmptyString),
  accentColor: Schema.optional(TrimmedNonEmptyString),
  environment: Schema.optionalKey(ProviderInstanceEnvironment),
  enabled: Schema.optionalKey(Schema.Boolean),
  config: Schema.optionalKey(Schema.Unknown),
  /**
   * Makes this entry an account pool over other instances of `driver`. No
   * driver runs for a pool: each new thread or turn that selects it is routed
   * to one member. Its `config` holds the settings its members share, for the
   * fields a driver marks `sharedInPool`.
   */
  pool: Schema.optionalKey(Schema.Array(ProviderInstanceId)),
  /**
   * The pool member new threads use first while it has allowance; without it
   * the pool spends whichever allowance would lapse unused soonest.
   */
  preferredMember: Schema.optionalKey(ProviderInstanceId),
  poolPolicy: Schema.optionalKey(ProviderPoolPolicy),
});
export type ProviderInstanceConfig = typeof ProviderInstanceConfig.Type;

export const ProviderInstanceMutation = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("create"),
    instanceId: ProviderInstanceId,
    instance: ProviderInstanceConfig,
  }),
  Schema.Struct({
    operation: Schema.Literal("upsert"),
    instanceId: ProviderInstanceId,
    instance: ProviderInstanceConfig,
  }),
  Schema.Struct({
    operation: Schema.Literal("remove"),
    instanceId: ProviderInstanceId,
  }),
]);
export type ProviderInstanceMutation = typeof ProviderInstanceMutation.Type;

export const ProviderInstanceConfigMap = Schema.Record(ProviderInstanceId, ProviderInstanceConfig);
export type ProviderInstanceConfigMap = typeof ProviderInstanceConfigMap.Type;

/**
 * The legacy single-instance-per-driver world used the driver kind itself as
 * the instance id; preserving that mapping keeps existing persisted threads,
 * bindings, and cache files routable across the migration without rewriting
 * their stored selection payloads.
 */
export const defaultInstanceIdForDriver = (driver: ProviderDriverKind): ProviderInstanceId =>
  ProviderInstanceId.make(driver);
