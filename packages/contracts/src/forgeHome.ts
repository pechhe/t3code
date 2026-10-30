/**
 * Forge Home as T3's Forge button shows it. The server reads
 * it from Weave through T3's Weave connection, as the person, and trims it to what the dropdown draws.
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** A Spec as Forge Home names it; the label comes from `number` and `ref` as everywhere else. */
export const ForgeHomeItem = Schema.Struct({
  id: Schema.String,
  number: PositiveInt,
  ref: Schema.optionalKey(Schema.NullOr(Schema.String)),
  title: Schema.String,
  status: Schema.String,
});
export type ForgeHomeItem = typeof ForgeHomeItem.Type;

/** What an owner card showed; a decision carries it back so Forge can tell the Spec has changed. */
export const ForgeHomeCard = Schema.Struct({
  bodyRevision: Schema.Int,
  published: Schema.Array(Schema.Struct({ repository: Schema.String, revision: Schema.String })),
  reviewRunId: Schema.String,
});
export type ForgeHomeCard = typeof ForgeHomeCard.Type;

export const ForgeHomeRow = Schema.Struct({
  rowId: Schema.String,
  text: Schema.String,
  verdict: Schema.Literals(["met", "not_met", "missing", "stale"]),
  evidence: Schema.NullOr(Schema.String),
});
export type ForgeHomeRow = typeof ForgeHomeRow.Type;

export const ForgeHomeCheck = Schema.Struct({
  label: Schema.String,
  met: Schema.NullOr(Schema.Boolean),
});
export type ForgeHomeCheck = typeof ForgeHomeCheck.Type;

/** Where Weave's Forge Inbox files an entry, and the words it gives the reason; both come from Forge. */
export const ForgeHomeInboxGroup = Schema.Literals(["accept", "answer", "review"]);
export type ForgeHomeInboxGroup = typeof ForgeHomeInboxGroup.Type;

const inboxFields = {
  group: ForgeHomeInboxGroup,
  reasonLabel: Schema.String,
  reasonDetail: Schema.String,
  /** When it started waiting on the person, where Forge knows. */
  since: Schema.NullOr(Schema.String),
};

export const ForgeHomeAcceptanceNeed = Schema.Struct({
  ...inboxFields,
  kind: Schema.Literal("acceptance"),
  spec: ForgeHomeItem,
  url: Schema.String,
  repositories: Schema.Array(Schema.String),
  /** Forge's objective checks, as Weave's build-home projection words them; `met: null` is information only. */
  checks: Schema.Array(ForgeHomeCheck),
  reviewSummary: Schema.NullOr(Schema.String),
  tryIt: Schema.NullOr(Schema.String),
  rows: Schema.Array(ForgeHomeRow),
  resolvedFindings: Schema.Array(Schema.Struct({ title: Schema.String })),
  /** Null without a judged review: the card can then be read but not decided. */
  card: Schema.NullOr(ForgeHomeCard),
});
export type ForgeHomeAcceptanceNeed = typeof ForgeHomeAcceptanceNeed.Type;

export const ForgeHomeHoldNeed = Schema.Struct({
  ...inboxFields,
  kind: Schema.Literal("hold"),
  spec: ForgeHomeItem,
  url: Schema.String,
  holdId: Schema.NullOr(Schema.String),
  holdKind: Schema.String,
  question: Schema.String,
});
export type ForgeHomeHoldNeed = typeof ForgeHomeHoldNeed.Type;

export const ForgeHomeOtherNeed = Schema.Struct({
  ...inboxFields,
  kind: Schema.Literals(["decision", "decision_challenge", "arc_review", "arc_check_in"]),
  spec: ForgeHomeItem,
  url: Schema.String,
  detail: Schema.NullOr(Schema.String),
});
export type ForgeHomeOtherNeed = typeof ForgeHomeOtherNeed.Type;

export const ForgeHomeNeed = Schema.Union([
  ForgeHomeAcceptanceNeed,
  ForgeHomeHoldNeed,
  ForgeHomeOtherNeed,
]);
export type ForgeHomeNeed = typeof ForgeHomeNeed.Type;

export const ForgeHomeLandingStage = Schema.Literals([
  "landed",
  "waiting_audit",
  "waiting_images",
  "waiting_deploy",
  "in_production",
  "accepted",
]);
export type ForgeHomeLandingStage = typeof ForgeHomeLandingStage.Type;

/** A recently landed Spec and how far it has gone towards production. */
export const ForgeHomeRecentLanding = Schema.Struct({
  spec: ForgeHomeItem,
  url: Schema.String,
  stage: ForgeHomeLandingStage,
  /** Forge's words for the stage, such as "Waiting on audit". */
  stageLabel: Schema.String,
  /** When it reached its stage. */
  at: Schema.String,
});
export type ForgeHomeRecentLanding = typeof ForgeHomeRecentLanding.Type;

export const ForgeHome = Schema.Struct({
  needsYou: Schema.Array(ForgeHomeNeed),
  /** Newest first; empty from a Weave that predates it. */
  recentlyLanded: Schema.Array(ForgeHomeRecentLanding),
  count: Schema.Int,
  capabilities: Schema.Struct({ answer: Schema.Boolean, notes: Schema.Boolean }),
});
export type ForgeHome = typeof ForgeHome.Type;

/**
 * `not_connected`: T3 is not connected to Weave. `invalid_token`: Weave refused T3's delegation
 * (expired or revoked).
 * `unavailable`: Weave could not be reached; `home` then holds the last Home read, if any.
 */
export const ForgeHomeState = Schema.Struct({
  status: Schema.Literals(["not_connected", "invalid_token", "unavailable", "ready"]),
  /** The Weave T3 is connected to; null when it is not. */
  origin: Schema.NullOr(Schema.String),
  /** Weave's Forge Home, for "Open Forge in Weave". */
  buildUrl: Schema.NullOr(Schema.String),
  home: Schema.NullOr(ForgeHome),
  readAt: Schema.NullOr(IsoDateTime),
});
export type ForgeHomeState = typeof ForgeHomeState.Type;

export const ForgeHomeReadInput = Schema.Struct({});
export type ForgeHomeReadInput = typeof ForgeHomeReadInput.Type;

export const ForgeHomeDecideInput = Schema.Struct({
  specId: TrimmedNonEmptyString,
  decision: Schema.Literals(["accept", "send_back"]),
  card: ForgeHomeCard,
  note: Schema.optional(Schema.String),
});
export type ForgeHomeDecideInput = typeof ForgeHomeDecideInput.Type;

/**
 * `decided`: Forge recorded it. `stale`: the Spec changed since the card was shown, and `state`
 * holds the fresh card. `refused`: Forge said no; `message` says why in a sentence.
 */
export const ForgeHomeDecideResult = Schema.Struct({
  outcome: Schema.Literals(["decided", "stale", "refused"]),
  message: Schema.NullOr(Schema.String),
  state: ForgeHomeState,
});
export type ForgeHomeDecideResult = typeof ForgeHomeDecideResult.Type;

export const ForgeHomeAnswerInput = Schema.Struct({
  itemId: TrimmedNonEmptyString,
  holdId: TrimmedNonEmptyString,
  answer: TrimmedNonEmptyString,
});
export type ForgeHomeAnswerInput = typeof ForgeHomeAnswerInput.Type;

export class ForgeHomeError extends Schema.TaggedError<ForgeHomeError>()("ForgeHomeError", {
  reason: Schema.Literals(["not_connected", "thread_not_found", "launch_failed"]),
  message: Schema.String,
}) {}
