/**
 * Build Home as T3's Build button shows it (pechhe/yardsmith Specs #4070, #4367). The server reads
 * it from HQ through T3's HQ connection, as the person, and trims it to what the dropdown draws.
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** A Spec as Build Home names it; the label comes from `number` and `ref` as everywhere else. */
export const BuildHomeItem = Schema.Struct({
  id: Schema.String,
  number: PositiveInt,
  ref: Schema.optionalKey(Schema.NullOr(Schema.String)),
  title: Schema.String,
  status: Schema.String,
});
export type BuildHomeItem = typeof BuildHomeItem.Type;

/** What an owner card showed; a decision carries it back so Build can tell the Spec has changed. */
export const BuildHomeCard = Schema.Struct({
  bodyRevision: Schema.Int,
  published: Schema.Array(Schema.Struct({ repository: Schema.String, revision: Schema.String })),
  reviewRunId: Schema.String,
});
export type BuildHomeCard = typeof BuildHomeCard.Type;

export const BuildHomeRow = Schema.Struct({
  rowId: Schema.String,
  text: Schema.String,
  verdict: Schema.Literals(["met", "not_met", "missing", "stale"]),
  evidence: Schema.NullOr(Schema.String),
});
export type BuildHomeRow = typeof BuildHomeRow.Type;

export const BuildHomeCheck = Schema.Struct({
  label: Schema.String,
  met: Schema.NullOr(Schema.Boolean),
});
export type BuildHomeCheck = typeof BuildHomeCheck.Type;

export const BuildHomeAcceptanceNeed = Schema.Struct({
  kind: Schema.Literal("acceptance"),
  spec: BuildHomeItem,
  url: Schema.String,
  repositories: Schema.Array(Schema.String),
  /** Build's objective checks, as HQ's build-home projection words them; `met: null` is information only. */
  checks: Schema.Array(BuildHomeCheck),
  reviewSummary: Schema.NullOr(Schema.String),
  tryIt: Schema.NullOr(Schema.String),
  rows: Schema.Array(BuildHomeRow),
  /** Null without a judged review: the card can then be read but not decided. */
  card: Schema.NullOr(BuildHomeCard),
});
export type BuildHomeAcceptanceNeed = typeof BuildHomeAcceptanceNeed.Type;

/** A finding, hold or Proposed Decision: T3 shows it and sends the person to Weave. */
export const BuildHomeOtherNeed = Schema.Struct({
  kind: Schema.Literals(["finding", "hold", "decision"]),
  spec: BuildHomeItem,
  url: Schema.String,
  detail: Schema.NullOr(Schema.String),
});
export type BuildHomeOtherNeed = typeof BuildHomeOtherNeed.Type;

export const BuildHomeNeed = Schema.Union([BuildHomeAcceptanceNeed, BuildHomeOtherNeed]);
export type BuildHomeNeed = typeof BuildHomeNeed.Type;

/** `prompt` stays on the server: "Do it" starts the thread from the line it last read. */
export const BuildHomeStuckLine = Schema.Struct({
  kind: Schema.String,
  spec: BuildHomeItem,
  blocker: Schema.String,
  fix: Schema.String,
  since: Schema.String,
});
export type BuildHomeStuckLine = typeof BuildHomeStuckLine.Type;

export const BuildHomeInProgress = Schema.Struct({
  spec: BuildHomeItem,
  liveLead: Schema.Boolean,
});
export type BuildHomeInProgress = typeof BuildHomeInProgress.Type;

export const BuildHome = Schema.Struct({
  needsYou: Schema.Array(BuildHomeNeed),
  stuck: Schema.Array(BuildHomeStuckLine),
  inProgress: Schema.Array(BuildHomeInProgress),
  /** Needs you and Stuck; In progress is not counted. */
  count: Schema.Int,
});
export type BuildHome = typeof BuildHome.Type;

/**
 * `not_connected`: T3 is not connected to HQ. `invalid_token`: HQ refused T3's delegation (expired
 * or revoked).
 * `unavailable`: HQ could not be reached; `home` then holds the last Home read, if any.
 */
export const BuildHomeState = Schema.Struct({
  status: Schema.Literals(["not_connected", "invalid_token", "unavailable", "ready"]),
  /** The HQ T3 is connected to; null when it is not. */
  origin: Schema.NullOr(Schema.String),
  /** HQ's Build Home, for "Open Build in Weave". */
  buildUrl: Schema.NullOr(Schema.String),
  home: Schema.NullOr(BuildHome),
  readAt: Schema.NullOr(IsoDateTime),
});
export type BuildHomeState = typeof BuildHomeState.Type;

export const BuildHomeReadInput = Schema.Struct({});
export type BuildHomeReadInput = typeof BuildHomeReadInput.Type;

export const BuildHomeDecideInput = Schema.Struct({
  specId: TrimmedNonEmptyString,
  decision: Schema.Literals(["accept", "send_back"]),
  card: BuildHomeCard,
  note: Schema.optional(Schema.String),
});
export type BuildHomeDecideInput = typeof BuildHomeDecideInput.Type;

/**
 * `decided`: Build recorded it. `stale`: the Spec changed since the card was shown, and `state`
 * holds the fresh card. `refused`: Build said no; `message` says why in a sentence.
 */
export const BuildHomeDecideResult = Schema.Struct({
  outcome: Schema.Literals(["decided", "stale", "refused"]),
  message: Schema.NullOr(Schema.String),
  state: BuildHomeState,
});
export type BuildHomeDecideResult = typeof BuildHomeDecideResult.Type;

/** "Do it": a new thread for the Spec, started from the stuck line's own prompt. */
export const BuildHomeFixInput = Schema.Struct({
  /** The thread whose project and model the new thread starts with. */
  threadId: ThreadId,
  specNumber: PositiveInt,
  kind: TrimmedNonEmptyString,
});
export type BuildHomeFixInput = typeof BuildHomeFixInput.Type;
export const BuildHomeFixResult = Schema.Struct({ threadId: ThreadId });
export type BuildHomeFixResult = typeof BuildHomeFixResult.Type;

export class BuildHomeError extends Schema.TaggedError<BuildHomeError>()("BuildHomeError", {
  reason: Schema.Literals([
    "not_connected",
    "thread_not_found",
    "stuck_line_not_found",
    "launch_failed",
  ]),
  message: Schema.String,
}) {}
