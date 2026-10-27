import * as Schema from "effect/Schema";

import { IsoDateTime, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { OrchestrationV2ThreadWorkItem } from "./orchestrationV2.ts";

/** A thread links to a Forge Spec, a Ticket of one, or an Arc over both. */
export const ForgeWorkItemKind = Schema.Literals(["spec", "ticket", "arc"]);
export type ForgeWorkItemKind = typeof ForgeWorkItemKind.Type;

/** A Spec's or Ticket's status, or an Arc's own: `open`, then `achieved` or `dropped`. */
export const ForgeItemStatus = Schema.Literals([
  "inbox",
  "shaping",
  "ready",
  "in_progress",
  "landed",
  "accepted",
  "open",
  "achieved",
  "dropped",
]);
export type ForgeItemStatus = typeof ForgeItemStatus.Type;

/**
 * How an agent names a Forge item: its canonical number, or a string in any form T3 reads, such
 * as a friendly ref `YS-12`, `#<number>` or a Forge URL. The server resolves it to the number.
 */
export const ForgeItemReferenceInput = Schema.Union([PositiveInt, TrimmedNonEmptyString]);
export type ForgeItemReferenceInput = typeof ForgeItemReferenceInput.Type;

/** An unresolved Forge wait: the item cannot start until `blocker` reaches `required`. */
export const ForgeWorkItemWait = Schema.Struct({
  number: PositiveInt,
  /**
   * The friendly per-repository ref such as `YS-12`; null or absent for an older item or Weave.
   * `number` stays the canonical identity.
   */
  ref: Schema.optionalKey(Schema.NullOr(Schema.String)),
  title: Schema.String,
  status: Schema.String,
  required: Schema.Literals(["landed", "accepted"]),
});
export type ForgeWorkItemWait = typeof ForgeWorkItemWait.Type;

/** What a header segment or chat chip shows: never the item's body. */
export const ForgeWorkItemSummary = Schema.Struct({
  kind: ForgeWorkItemKind,
  /**
   * The friendly per-repository ref such as `YS-12`; null or absent for an older item or Weave.
   * `number` stays the canonical identity.
   */
  ref: Schema.optionalKey(Schema.NullOr(Schema.String)),
  title: Schema.String,
  status: ForgeItemStatus,
  holds: Schema.Array(Schema.Struct({ kind: Schema.String, note: Schema.String })),
  waits: Schema.Array(ForgeWorkItemWait),
});
export type ForgeWorkItemSummary = typeof ForgeWorkItemSummary.Type;

export const ForgeWorkItemView = Schema.Struct({
  itemId: TrimmedNonEmptyString,
  number: PositiveInt,
  /** The item's page in Weave. */
  url: Schema.String,
  /** The last summary Forge returned; null when nothing has been read yet. */
  item: Schema.NullOr(ForgeWorkItemSummary),
  /** The latest read failed, or T3's Weave is no longer the one the link was made against. */
  unavailable: Schema.Boolean,
  /** When `item` was read from Forge. */
  readAt: Schema.NullOr(IsoDateTime),
});
export type ForgeWorkItemView = typeof ForgeWorkItemView.Type;

export const ForgeWorkItemReadInput = Schema.Struct({
  threadId: ThreadId,
  /**
   * The linked item the client knows of. The server always answers for the thread's current
   * link; this only makes a new link a new query on the client.
   */
  itemId: Schema.optional(TrimmedNonEmptyString),
});
export type ForgeWorkItemReadInput = typeof ForgeWorkItemReadInput.Type;

/** Null without a link, or when T3 is not connected to Weave. */
export const ForgeWorkItemReadResult = Schema.NullOr(ForgeWorkItemView);
export type ForgeWorkItemReadResult = typeof ForgeWorkItemReadResult.Type;

/** Another Forge item a card names: a Ticket, a parent Spec or a governing Decision. */
export const ForgeItemReference = Schema.Struct({
  number: PositiveInt,
  /**
   * The friendly per-repository ref such as `YS-12`; null or absent for an older item or Weave.
   * `number` stays the canonical identity.
   */
  ref: Schema.optionalKey(Schema.NullOr(Schema.String)),
  title: Schema.String,
  status: Schema.String,
});
export type ForgeItemReference = typeof ForgeItemReference.Type;

/**
 * The Forge session working on an item: a Spec's lead or a Ticket's worker. `sessionRef` is the
 * harness's own reference; for harness `t3` it is `<environmentId>/<threadId>`.
 */
export const ForgeWorkItemSession = Schema.Struct({
  harness: Schema.String,
  sessionRef: Schema.String,
  activity: Schema.Literals(["active", "quiet", "stalled", "ended"]),
  lastActivityAt: IsoDateTime,
});
export type ForgeWorkItemSession = typeof ForgeWorkItemSession.Type;

/** What a Spec card adds: its Tickets, acceptance and the Decisions governing it. */
export const BuildSpecCardDetail = Schema.Struct({
  kind: Schema.Literal("spec"),
  specKind: Schema.NullOr(Schema.String),
  horizon: Schema.NullOr(Schema.String),
  /** Every Ticket by status, for the progress bar. */
  ticketCounts: Schema.Record(Schema.String, Schema.Number),
  /** The first Tickets by number; `ticketCounts` holds the rest. */
  tickets: Schema.Array(ForgeItemReference),
  acceptedAt: Schema.NullOr(IsoDateTime),
  governedBy: Schema.Array(ForgeItemReference),
  lead: Schema.NullOr(ForgeWorkItemSession),
});

/** What a Ticket card adds: its Spec, delivery and worker. */
export const BuildTicketCardDetail = Schema.Struct({
  kind: Schema.Literal("ticket"),
  spec: Schema.NullOr(ForgeItemReference),
  attempts: Schema.Number,
  /** The latest delivery attempt's state, such as `published` or `failed`. */
  latestAttempt: Schema.NullOr(Schema.Struct({ status: Schema.String, at: IsoDateTime })),
  lastFailure: Schema.NullOr(Schema.Struct({ stage: Schema.String, cause: Schema.String })),
  worker: Schema.NullOr(ForgeWorkItemSession),
});

/** What an Arc card adds: nothing, since an Arc has no Tickets, delivery or lead session. */
export const BuildArcCardDetail = Schema.Struct({
  kind: Schema.Literal("arc"),
});

/** A hover card or sheet for a Forge item: its summary plus what its kind adds, never its body. */
export const ForgeWorkItemCard = Schema.Struct({
  number: PositiveInt,
  url: Schema.String,
  item: ForgeWorkItemSummary,
  /** Forge's plain-text summary of the body, at most a few lines. */
  summary: Schema.NullOr(Schema.String),
  detail: Schema.Union([BuildSpecCardDetail, BuildTicketCardDetail, BuildArcCardDetail]),
  /** The latest change T3 can see: an update, a hold, an attempt or session activity. */
  updatedAt: IsoDateTime,
  readAt: IsoDateTime,
  /** The latest re-read failed, so this is the card as last read. */
  unavailable: Schema.Boolean,
});
export type ForgeWorkItemCard = typeof ForgeWorkItemCard.Type;

export const ForgeWorkItemCardInput = Schema.Struct({
  /** The thread the item is read for. */
  threadId: ThreadId,
  itemId: TrimmedNonEmptyString,
  /**
   * Identifies one opening of the card. A new one reads Forge at once; the periodic re-reads of
   * an open card repeat it and are rate-limited.
   */
  open: TrimmedNonEmptyString,
});
export type ForgeWorkItemCardInput = typeof ForgeWorkItemCardInput.Type;

/** Null when T3 is not connected to Weave. A first read Forge fails is an error. */
export const ForgeWorkItemCardResult = Schema.NullOr(ForgeWorkItemCard);
export type ForgeWorkItemCardResult = typeof ForgeWorkItemCardResult.Type;

/** Where a Connect to Weave sign-in stands. `failed` names why in `reason`; `cancelled` is Weave's consent declined. */
export const HqSignInState = Schema.Struct({
  status: Schema.Literals(["pending", "cancelled", "failed"]),
  reason: Schema.optional(
    Schema.Literals(["expired", "rejected", "no_access", "unavailable", "invalid_response"]),
  ),
});
export type HqSignInState = typeof HqSignInState.Type;

/**
 * Starts Connect to Weave. `handbackOrigin` is the origin through which the person's browser reaches
 * this environment (Weave sends the browser back to it); the server adds its own callback path.
 */
export const HqSignInStartInput = Schema.Struct({
  handbackOrigin: Schema.String,
  /** Another Weave than the default, such as a local one. */
  hqOrigin: Schema.optional(Schema.String),
});
export type HqSignInStartInput = typeof HqSignInStartInput.Type;
export const HqSignInStartResult = Schema.Struct({ url: Schema.String });
export type HqSignInStartResult = typeof HqSignInStartResult.Type;

/** Disconnects T3 from Weave and returns the resulting connection state. */
export const HqDisconnectInput = Schema.Struct({});
export type HqDisconnectInput = typeof HqDisconnectInput.Type;

/** Whether T3 is connected to Weave, so its threads can link Forge items. */
export const BuildConnectionReadInput = Schema.Struct({});
export type BuildConnectionReadInput = typeof BuildConnectionReadInput.Type;
export const BuildConnectionReadResult = Schema.Struct({
  connected: Schema.Boolean,
  /**
   * The Weave whose Forge links chat shows as live items; null when not connected. Optional, so a
   * client still reads an older server, whose chat then shows Forge links as ordinary links.
   */
  origin: Schema.optional(Schema.NullOr(Schema.String)),
  /**
   * The newest Connect to Weave sign-in this environment started that has not connected; null once
   * connected or when none is open. Optional for the same reason as `origin`.
   */
  signIn: Schema.optional(Schema.NullOr(HqSignInState)),
  /** Weave refused the stored delegation (revoked or expired), so threads cannot act in Weave until it reconnects. */
  refused: Schema.optional(Schema.Boolean),
});
export type BuildConnectionReadResult = typeof BuildConnectionReadResult.Type;

/** Forge items mentioned in a thread's messages, read from T3's Weave. */
export const ForgeWorkItemMentionsInput = Schema.Struct({
  threadId: ThreadId,
  numbers: Schema.Array(PositiveInt).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
});
export type ForgeWorkItemMentionsInput = typeof ForgeWorkItemMentionsInput.Type;

/** Only the items Forge knows: a number it doesn't is absent, and its mention stays as written. */
export const ForgeWorkItemMentionsResult = Schema.Struct({
  items: Schema.Array(ForgeWorkItemView),
  /**
   * Forge could not be reached for at least one number, so an absent one may be known to Forge.
   * Optional, so a client still reads an older server, which leaves it out.
   */
  unavailable: Schema.optional(Schema.Boolean),
});
export type ForgeWorkItemMentionsResult = typeof ForgeWorkItemMentionsResult.Type;

export const ForgeWorkItemLinkInput = Schema.Struct({
  threadId: ThreadId,
  /** A Forge URL, a friendly ref such as `YS-12`, `#<number>` or a number; null unlinks. */
  reference: Schema.NullOr(TrimmedNonEmptyString),
});
export type ForgeWorkItemLinkInput = typeof ForgeWorkItemLinkInput.Type;

export const ForgeWorkItemLinkResult = Schema.Struct({
  workItem: Schema.NullOr(OrchestrationV2ThreadWorkItem),
});
export type ForgeWorkItemLinkResult = typeof ForgeWorkItemLinkResult.Type;

export class ForgeWorkItemError extends Schema.TaggedError<ForgeWorkItemError>()(
  "ForgeWorkItemError",
  {
    reason: Schema.Literals([
      "thread_not_found",
      "not_connected",
      "invalid_reference",
      "other_hq",
      "not_found",
      "unsupported_kind",
      "unavailable",
      "dispatch_failed",
      "invalid_handback",
      "invalid_hq_origin",
    ]),
    message: Schema.String,
  },
) {}
