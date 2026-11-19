import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * One thing a turn can be routed to: a provider instance's id, or `instanceId:subProvider` for
 * one Pi sub-provider (all of Pi's Antigravity logins are one account).
 */
export const AccountId = TrimmedNonEmptyString;
export type AccountId = typeof AccountId.Type;

/** A model as several accounts serve it: its id with provider labels removed. */
export const PooledModelKey = TrimmedNonEmptyString;
export type PooledModelKey = typeof PooledModelKey.Type;

/** An account passed over for a model after it failed with a usage limit. */
export const AccountSkip = Schema.Struct({
  until: IsoDateTime,
  /** False when the provider reported no reset, so the skip lasts until the server's midnight. */
  reportedReset: Schema.Boolean,
});
export type AccountSkip = typeof AccountSkip.Type;

/** Each skipped account's skips, by the model it ran out on. */
export const AccountSkips = Schema.Record(AccountId, Schema.Record(PooledModelKey, AccountSkip));
export type AccountSkips = typeof AccountSkips.Type;
