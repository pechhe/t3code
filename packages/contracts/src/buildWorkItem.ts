import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { OrchestrationV2ThreadWorkItem } from "./orchestrationV2.ts";

/** A thread links only to a Build Spec or Ticket. */
export const BuildWorkItemKind = Schema.Literals(["spec", "ticket"]);
export type BuildWorkItemKind = typeof BuildWorkItemKind.Type;

export const BuildItemStatus = Schema.Literals([
  "inbox",
  "shaping",
  "ready",
  "in_progress",
  "landed",
  "accepted",
  "dropped",
]);
export type BuildItemStatus = typeof BuildItemStatus.Type;

/** An unresolved Build wait: the item cannot start until `blocker` reaches `required`. */
export const BuildWorkItemWait = Schema.Struct({
  number: PositiveInt,
  title: Schema.String,
  status: Schema.String,
  required: Schema.Literals(["landed", "accepted"]),
});
export type BuildWorkItemWait = typeof BuildWorkItemWait.Type;

/** What a header segment or chat chip shows: never the item's body. */
export const BuildWorkItemSummary = Schema.Struct({
  kind: BuildWorkItemKind,
  title: Schema.String,
  status: BuildItemStatus,
  holds: Schema.Array(Schema.Struct({ kind: Schema.String, note: Schema.String })),
  waits: Schema.Array(BuildWorkItemWait),
});
export type BuildWorkItemSummary = typeof BuildWorkItemSummary.Type;

export const BuildWorkItemView = Schema.Struct({
  itemId: TrimmedNonEmptyString,
  number: PositiveInt,
  /** The item's page in HQ. */
  url: Schema.String,
  /** The last summary Build returned; null when nothing has been read yet. */
  item: Schema.NullOr(BuildWorkItemSummary),
  /** The latest read failed, or the project's HQ is no longer the one the link was made against. */
  unavailable: Schema.Boolean,
  /** When `item` was read from Build. */
  readAt: Schema.NullOr(IsoDateTime),
});
export type BuildWorkItemView = typeof BuildWorkItemView.Type;

export const BuildWorkItemReadInput = Schema.Struct({
  threadId: ThreadId,
  /**
   * The linked item the client knows of. The server always answers for the thread's current
   * link; this only makes a new link a new query on the client.
   */
  itemId: Schema.optional(TrimmedNonEmptyString),
});
export type BuildWorkItemReadInput = typeof BuildWorkItemReadInput.Type;

/** Null without a link, or when the thread's project is not connected to HQ. */
export const BuildWorkItemReadResult = Schema.NullOr(BuildWorkItemView);
export type BuildWorkItemReadResult = typeof BuildWorkItemReadResult.Type;

/** Another Build item a card names: a Ticket, a parent Spec or a governing Decision. */
export const BuildItemReference = Schema.Struct({
  number: PositiveInt,
  title: Schema.String,
  status: Schema.String,
});
export type BuildItemReference = typeof BuildItemReference.Type;

/**
 * The Build session working on an item: a Spec's lead or a Ticket's worker. `sessionRef` is the
 * harness's own reference; for harness `t3` it is `<environmentId>/<threadId>`.
 */
export const BuildWorkItemSession = Schema.Struct({
  harness: Schema.String,
  sessionRef: Schema.String,
  activity: Schema.Literals(["active", "quiet", "stalled", "ended"]),
  lastActivityAt: IsoDateTime,
});
export type BuildWorkItemSession = typeof BuildWorkItemSession.Type;

/** What a Spec card adds: its Tickets, acceptance and the Decisions governing it. */
export const BuildSpecCardDetail = Schema.Struct({
  kind: Schema.Literal("spec"),
  specKind: Schema.NullOr(Schema.String),
  horizon: Schema.NullOr(Schema.String),
  /** Every Ticket by status, for the progress bar. */
  ticketCounts: Schema.Record(Schema.String, Schema.Number),
  /** The first Tickets by number; `ticketCounts` holds the rest. */
  tickets: Schema.Array(BuildItemReference),
  acceptedAt: Schema.NullOr(IsoDateTime),
  governedBy: Schema.Array(BuildItemReference),
  lead: Schema.NullOr(BuildWorkItemSession),
});

/** What a Ticket card adds: its Spec, delivery and worker. */
export const BuildTicketCardDetail = Schema.Struct({
  kind: Schema.Literal("ticket"),
  spec: Schema.NullOr(BuildItemReference),
  attempts: Schema.Number,
  /** The latest delivery attempt's state, such as `published` or `failed`. */
  latestAttempt: Schema.NullOr(Schema.Struct({ status: Schema.String, at: IsoDateTime })),
  lastFailure: Schema.NullOr(Schema.Struct({ stage: Schema.String, cause: Schema.String })),
  worker: Schema.NullOr(BuildWorkItemSession),
});

/** A hover card or sheet for a Build item: its summary plus what its kind adds, never its body. */
export const BuildWorkItemCard = Schema.Struct({
  number: PositiveInt,
  url: Schema.String,
  item: BuildWorkItemSummary,
  /** Build's plain-text summary of the body, at most a few lines. */
  summary: Schema.NullOr(Schema.String),
  detail: Schema.Union([BuildSpecCardDetail, BuildTicketCardDetail]),
  /** The latest change T3 can see: an update, a hold, an attempt or session activity. */
  updatedAt: IsoDateTime,
  readAt: IsoDateTime,
  /** The latest re-read failed, so this is the card as last read. */
  unavailable: Schema.Boolean,
});
export type BuildWorkItemCard = typeof BuildWorkItemCard.Type;

export const BuildWorkItemCardInput = Schema.Struct({
  /** The thread whose project's HQ the item is read from. */
  threadId: ThreadId,
  itemId: TrimmedNonEmptyString,
  /**
   * Identifies one opening of the card. A new one reads Build at once; the periodic re-reads of
   * an open card repeat it and are rate-limited.
   */
  open: TrimmedNonEmptyString,
});
export type BuildWorkItemCardInput = typeof BuildWorkItemCardInput.Type;

/** Null when the project is not connected to HQ. A first read Build fails is an error. */
export const BuildWorkItemCardResult = Schema.NullOr(BuildWorkItemCard);
export type BuildWorkItemCardResult = typeof BuildWorkItemCardResult.Type;

/** Whether a project is connected to YardSmith HQ, so its threads can link Build items. */
export const BuildConnectionReadInput = Schema.Struct({ projectId: ProjectId });
export type BuildConnectionReadInput = typeof BuildConnectionReadInput.Type;
export const BuildConnectionReadResult = Schema.Struct({ connected: Schema.Boolean });
export type BuildConnectionReadResult = typeof BuildConnectionReadResult.Type;

export const BuildWorkItemLinkInput = Schema.Struct({
  threadId: ThreadId,
  /** A Build URL, `#<number>` or a number; null unlinks. */
  reference: Schema.NullOr(TrimmedNonEmptyString),
});
export type BuildWorkItemLinkInput = typeof BuildWorkItemLinkInput.Type;

export const BuildWorkItemLinkResult = Schema.Struct({
  workItem: Schema.NullOr(OrchestrationV2ThreadWorkItem),
});
export type BuildWorkItemLinkResult = typeof BuildWorkItemLinkResult.Type;

export class BuildWorkItemError extends Schema.TaggedError<BuildWorkItemError>()(
  "BuildWorkItemError",
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
    ]),
    message: Schema.String,
  },
) {}
