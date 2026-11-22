import * as Effect from "effect/Effect";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * One thing a turn can be routed to: a provider instance's id, or `instanceId:providerId` for
 * one Pi credential.
 */
export const AccountId = TrimmedNonEmptyString;
export type AccountId = typeof AccountId.Type;

/** A model as several accounts serve it: its id with provider labels removed. */
export const PooledModelKey = TrimmedNonEmptyString;
export type PooledModelKey = typeof PooledModelKey.Type;

/** How Primary is tried: the account whose longest usage window resets soonest, or top to bottom. */
export const PrimaryOrder = Schema.Literals(["soonest", "manual"]);
export type PrimaryOrder = typeof PrimaryOrder.Type;

/** Remaining usage, in percent, at or below which an account is held back for a model. */
export const ReservePercent = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 99 }));
export type ReservePercent = typeof ReservePercent.Type;

/**
 * Which accounts serve one routed model. Primary is tried first, Overflow only once no Primary
 * account is available above its reserve; an account in neither is not used for the model.
 */
export const ModelRoute = Schema.Struct({
  primary: Schema.Array(AccountId),
  overflow: Schema.Array(AccountId).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  primaryOrder: PrimaryOrder.pipe(Schema.withDecodingDefault(Effect.succeed("soonest" as const))),
  /** By account; an account without one has no reserve for this model. */
  reserves: Schema.Record(AccountId, ReservePercent).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type ModelRoute = typeof ModelRoute.Type;

/** What a run reported when it failed on an account. */
export const AccountBlockReason = Schema.Literals(["usage-limit", "rate-limit", "overload"]);
export type AccountBlockReason = typeof AccountBlockReason.Type;

/**
 * An account the server holds back for one model after runs on it failed. Held in memory only, so
 * a restart forgets it, and a usage reading newer than `since` with room to spare clears it.
 */
export const AccountBlock = Schema.Struct({
  account: AccountId,
  model: PooledModelKey,
  reason: AccountBlockReason,
  since: IsoDateTime,
  until: IsoDateTime,
  /** The provider reported `until`; otherwise it is a backoff (2, 10, then 30 minutes). */
  reportedReset: Schema.Boolean,
  /** Failed attempts since the account last served the model. */
  attempts: NonNegativeInt,
  /** The usage windows governing the model when it failed; a reading clears it only with all of them. */
  windowIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});
export type AccountBlock = typeof AccountBlock.Type;

export const AccountRoutingState = Schema.Struct({
  /** Blocks still in force. */
  blocks: Schema.Array(AccountBlock),
});
export type AccountRoutingState = typeof AccountRoutingState.Type;

export const AccountRoutingClearInput = Schema.Struct({
  account: AccountId,
  /** Omit to clear the account's blocks for every model. */
  model: Schema.optionalKey(PooledModelKey),
});
export type AccountRoutingClearInput = typeof AccountRoutingClearInput.Type;

export const ACCOUNT_ROUTING_WS_METHODS = {
  accountRoutingSubscribe: "accountRouting.subscribe",
  accountRoutingClear: "accountRouting.clear",
} as const;

/** Model routing's runtime state (fork/differences.md `account-pools`). */
export const WsAccountRoutingRpcs = RpcGroup.make(
  Rpc.make(ACCOUNT_ROUTING_WS_METHODS.accountRoutingSubscribe, {
    payload: Schema.Struct({}),
    success: AccountRoutingState,
    error: EnvironmentAuthorizationError,
    stream: true,
  }),
  Rpc.make(ACCOUNT_ROUTING_WS_METHODS.accountRoutingClear, {
    payload: AccountRoutingClearInput,
    success: AccountRoutingState,
    error: EnvironmentAuthorizationError,
  }),
);
