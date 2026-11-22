/**
 * A thread's link to the Weave Forge item it works on (pechhe/t3code#78): a Spec, a Ticket of one or
 * an Arc over both. T3 stores only the reference; what clients show is read from Forge through the
 * server's own observer agent, so every client, local or remote, sees the same state without ever
 * reaching Weave itself.
 */
import {
  type ForgeItemReference,
  type ForgeItemReferenceInput,
  type ForgeWorkItemCard,
  type ForgeWorkItemCardInput,
  type ForgeWorkItemCardResult,
  ForgeWorkItemError,
  type ForgeWorkItemMentionsInput,
  type ForgeWorkItemMentionsResult,
  ForgeWorkItemSummary,
  type ForgeWorkItemReadResult,
  type ForgeWorkItemSession,
  CommandId,
  type OrchestrationV2ThreadWorkItem,
  type ThreadId,
  type ForgeWorkItemView,
} from "@t3tools/contracts";
import { forgeItemUrl, parseForgeReference } from "@t3tools/shared/forgeLinks";
import { sameWeaveAddress } from "@t3tools/shared/weaveOrigins";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import type { OrchestratorV2DispatchResult } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as WeaveAgentConnections from "./WeaveAgentConnections.ts";

/**
 * Clients re-request a shown item on this cadence. Per Weave connection, at most once an interval
 * one `weave_forge_list` call asks which items changed since the last check, and only those, items
 * waiting on them and items past the safety refresh are read again, so a change shows within about
 * a minute however many items are shown. No timer reads Weave here.
 */
export const BUILD_REREAD_INTERVAL_MS = 60_000;
export const BUILD_MAX_REREAD_INTERVAL_MS = 4 * BUILD_REREAD_INTERVAL_MS;
/** A cached summary is shown without a fresh change check for this long. */
const CACHED_SUMMARY_MAX_AGE_MS = BUILD_MAX_REREAD_INTERVAL_MS + BUILD_REREAD_INTERVAL_MS;
/** An item is read again this often even when no check saw it change. */
const SUMMARY_SAFETY_REFRESH_MS = 30 * 60_000;
/**
 * A check asks from this long before its watermark, so a save stamped before it committed, or
 * Weave's clock running behind T3's, is not missed. Items found again in the overlap are not reread.
 */
const CHANGE_CHECK_OVERLAP_MS = 5 * 60_000;
/** A check that takes longer than this counts as failed, so a slow Weave holds no card back. */
const CHANGE_CHECK_TIMEOUT = "10 seconds";
const CHANGE_PAGE_LIMIT = 100;
/** More pages than this and every item counts as changed for the round. */
const CHANGE_MAX_PAGES = 5;

/**
 * `fresh` reads Forge now instead of answering from the cache. Writes made outside T3's own Weave
 * connection, such as an agent opening a hold through its own MCP, do not invalidate the cache.
 */
export interface ForgeWorkItemReadOptions {
  readonly fresh?: boolean;
}
export const fingerprintOf = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export interface Cadence {
  readonly intervalMs: number;
  readonly fingerprint: string | undefined;
}

export type ReadCadence = Cadence;

/** Back off while the fingerprint stays unchanged, resetting when a reread sees new data. */
export const nextInterval = (previous: Cadence | undefined, fingerprint: string | undefined) =>
  fingerprint !== undefined && previous?.fingerprint === fingerprint
    ? Math.min(previous.intervalMs * 2, BUILD_MAX_REREAD_INTERVAL_MS)
    : BUILD_REREAD_INTERVAL_MS;

/** An older Weave omits `ref`; an older item has none, and an empty one is none. */
const BuildRef = Schema.optionalKey(
  Schema.NullOr(Schema.String).pipe(
    Schema.decodeTo(
      Schema.NullOr(Schema.String),
      SchemaTransformation.transform({
        decode: (ref) => (ref === "" ? null : ref),
        encode: (ref) => ref,
      }),
    ),
  ),
);

const BuildRead = Schema.Struct({
  id: Schema.String,
  number: Schema.Number,
  ref: BuildRef,
  kind: Schema.String,
  title: Schema.String,
  status: Schema.String,
  acceptanceLevel: Schema.optionalKey(Schema.NullOr(Schema.String)),
  /** The repository the item belongs to; an older Weave omits it. */
  project: Schema.optionalKey(Schema.NullOr(Schema.String)),
  holds: Schema.Array(
    Schema.Struct({
      kind: Schema.String,
      note: Schema.String,
      clearedAt: Schema.NullOr(Schema.String),
    }),
  ),
});
const decodeForgeRead = Schema.decodeUnknownOption(BuildRead);

const BuildWaits = Schema.Array(
  Schema.Struct({
    required: Schema.Literals(["landed", "accepted"]),
    blocker: Schema.Struct({
      number: Schema.Number,
      ref: BuildRef,
      title: Schema.String,
      status: Schema.String,
    }),
  }),
);
const decodeForgeWaits = Schema.decodeUnknownOption(BuildWaits);
const ForgeReference = Schema.Struct({
  id: Schema.String,
  number: Schema.Number,
  ref: BuildRef,
  title: Schema.String,
  status: Schema.String,
});
const decodeSummary = Schema.decodeUnknownOption(ForgeWorkItemSummary);

/** The kinds T3 reads as an item it can link and show; a Decision or a hold is not one. */
const isItemKind = (kind: string) => kind === "spec" || kind === "ticket" || kind === "arc";

const summaryOf = (
  read: typeof BuildRead.Type,
  waits: typeof BuildWaits.Type,
): Option.Option<ForgeWorkItemSummary> =>
  decodeSummary({
    kind: read.kind,
    ...(read.ref === undefined ? {} : { ref: read.ref }),
    title: read.title,
    status: read.status,
    ...(read.acceptanceLevel === "owner" || read.acceptanceLevel === "agent"
      ? { acceptanceLevel: read.acceptanceLevel }
      : {}),
    holds: [],
    waits: waits.map(({ required, blocker }) => ({
      number: blocker.number,
      ...(blocker.ref === undefined ? {} : { ref: blocker.ref }),
      title: blocker.title,
      status: blocker.status,
      required,
    })),
  });

/** The parts of `weave_forge_read` a card shows. Bodies are never requested. */
const BuildCardRead = Schema.Struct({
  ...BuildRead.fields,
  holds: Schema.Array(
    Schema.Struct({
      kind: Schema.String,
      note: Schema.String,
      openedAt: Schema.String,
      clearedAt: Schema.NullOr(Schema.String),
    }),
  ),
  summary: Schema.NullOr(Schema.String),
  parentId: Schema.NullOr(Schema.String),
  specKind: Schema.NullOr(Schema.String),
  effectiveHorizon: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updates: Schema.Array(Schema.Struct({ createdAt: Schema.String })),
  governedBy: Schema.optionalKey(Schema.Array(ForgeReference)),
});
const decodeForgeCardRead = Schema.decodeUnknownOption(BuildCardRead);
const decodeForgeList = Schema.decodeUnknownOption(Schema.Array(ForgeReference));
const BuildSession = Schema.Struct({
  parentSessionId: Schema.NullOr(Schema.String),
  ticketIds: Schema.Array(Schema.String),
  harness: Schema.String,
  sessionRef: Schema.String,
  activity: Schema.Literals(["active", "quiet", "stalled", "ended"]),
  currentGeneration: Schema.Boolean,
  lastActivityAt: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
});
const decodeForgeSessions = Schema.decodeUnknownOption(Schema.Array(BuildSession));
const decodeForgeAttempts = Schema.decodeUnknownOption(
  Schema.Array(
    Schema.Struct({
      status: Schema.String,
      failure: Schema.NullOr(Schema.Struct({ stage: Schema.String, cause: Schema.String })),
      events: Schema.Array(Schema.Struct({ occurredAt: Schema.String })),
    }),
  ),
);
const decodeForgeAcceptance = Schema.decodeUnknownOption(
  Schema.NullOr(Schema.Struct({ acceptedAt: Schema.String })),
);

/** Tickets a Spec card names before "+N more". */
const CARD_TICKET_LIMIT = 5;
/** Forge's summary is already plain text; a card shows three lines of it. */
const CARD_SUMMARY_LIMIT = 400;

/**
 * The session to show for an item: the open one of the current bind generation with the latest
 * activity or, with none open, the one that ended last.
 */
const pickSession = (
  sessions: ReadonlyArray<typeof BuildSession.Type>,
  matches: (session: typeof BuildSession.Type) => boolean,
): ForgeWorkItemSession | null => {
  const candidates = sessions.filter((session) => session.currentGeneration && matches(session));
  const latest = (
    pool: ReadonlyArray<typeof BuildSession.Type>,
    at: (session: typeof BuildSession.Type) => string,
  ) => pool.toSorted((a, b) => at(b).localeCompare(at(a)))[0];
  const chosen =
    latest(
      candidates.filter((session) => session.currentGeneration && session.endedAt === null),
      (session) => session.lastActivityAt,
    ) ??
    latest(
      candidates.filter((session) => session.endedAt !== null),
      (session) => session.endedAt ?? "",
    );
  if (chosen === undefined) return null;
  return {
    harness: chosen.harness,
    sessionRef: chosen.sessionRef,
    activity: chosen.endedAt === null ? chosen.activity : "ended",
    lastActivityAt: chosen.lastActivityAt,
  };
};

const latestOf = (dates: ReadonlyArray<string | null | undefined>) =>
  dates
    .filter((date): date is string => typeof date === "string")
    .toSorted()
    .at(-1);

/** A card as Forge answered it, before T3 adds where and when it was read. */
type FreshCard = Omit<ForgeWorkItemCard, "url" | "updatedAt" | "readAt" | "unavailable"> & {
  readonly updatedAt: string | undefined;
};

interface CachedCard extends ReadCadence {
  readonly card: Omit<ForgeWorkItemCard, "unavailable"> | null;
  readonly attemptedAt: number;
  readonly unavailable: boolean;
  /** Recent openings of this card; a polling client repeats its own, a new one reads at once. */
  readonly opens: ReadonlyArray<string>;
}

/** Openings remembered per card, enough for every client showing it at once. */
const CARD_OPENS_REMEMBERED = 32;
/** Cards kept for their last known state; the least recently asked for go first. */
export const CARD_CACHE_LIMIT = 256;

interface CachedItem {
  readonly item: ForgeWorkItemSummary | null;
  readonly readAt: number | null;
  readonly attemptedAt: number;
  readonly unavailable: boolean;
}

/** What one Weave connection's change checks have seen. */
interface ChangeFeed {
  /** When the last check started, successful or not. */
  readonly attemptedAt: number;
  /** When the last successful check started; the next asks from just before it. */
  readonly watermark: number;
  /** Whether the last check answered; when not, summaries fall back to the interval cadence. */
  readonly ok: boolean;
  /** Set when a check's changes overflowed the page cap: everything read earlier is stale. */
  readonly allChangedAt: number;
  /** Changed items by number: Forge's `updatedAt` and when T3 first saw that change. */
  readonly changed: ReadonlyMap<number, { readonly updatedAt: string; readonly seenAt: number }>;
}

const ChangeList = Schema.Struct({
  items: Schema.Array(Schema.Struct({ number: Schema.Number, updatedAt: Schema.String })),
  hasMore: Schema.Boolean,
  nextOffset: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});
const decodeChangeList = Schema.decodeUnknownOption(ChangeList);

/** Items kept for their last known summary, and numbers kept resolved, per Weave connection. */
const ITEM_CACHE_LIMIT = 1024;

/** A number resolved on one Weave: its item, or null while Forge doesn't know it. */
interface CachedNumber {
  readonly itemId: string | null;
  readonly attemptedAt: number;
}

/** Map order is recency: re-inserting marks an entry used, and the least recent goes first. */
const remember = <V>(map: Map<string, V>, key: string, value: V, limit: number) => {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
};

export class ForgeWorkItems extends Context.Service<
  ForgeWorkItems,
  {
    /** The thread's linked item as clients show it; null without a link or a Weave server connection. */
    readonly view: (
      threadId: ThreadId,
    ) => Effect.Effect<ForgeWorkItemReadResult, ForgeWorkItemError>;
    /**
     * The linked item's summary from what clients' reads left in the cache, never reading Weave:
     * none before a read, after a failed one, once it is older than a shown item can be, or for a
     * link made against another Weave.
     */
    readonly cachedSummary: (
      workItem: OrchestrationV2ThreadWorkItem,
    ) => Effect.Effect<Option.Option<ForgeWorkItemSummary>>;
    /**
     * Starts the read a client's view makes, in the background under the service's scope, so a
     * later `cachedSummary` has the item. It keeps the view's cadence, swallows every failure and
     * reads nothing without a connection or for a link made against another Weave. The fiber is
     * returned only so a caller can await it; a turn never does.
     */
    readonly warmSummary: (
      workItem: OrchestrationV2ThreadWorkItem,
    ) => Effect.Effect<Fiber.Fiber<void>>;
    /**
     * The card for an item read from T3's Weave: its summary, Tickets or delivery,
     * and who works on it. A new `open` reads Forge at once; repeating it reads at most once a
     * minute.
     */
    readonly card: (
      input: ForgeWorkItemCardInput,
    ) => Effect.Effect<ForgeWorkItemCardResult, ForgeWorkItemError>;
    /**
     * Items mentioned in the thread's messages, by number on T3's Weave, as clients show
     * them. Shares the linked item's cache and cadence; a number Forge doesn't know is absent, and
     * `unavailable` tells that apart from Forge being unreachable.
     */
    readonly mentions: (
      input: ForgeWorkItemMentionsInput,
      options?: ForgeWorkItemReadOptions,
    ) => Effect.Effect<ForgeWorkItemMentionsResult, ForgeWorkItemError>;
    /** Whether threads can link Forge items at all. */
    readonly connected: Effect.Effect<
      {
        readonly connected: boolean;
        readonly origin: string | null;
        readonly refused?: boolean;
      },
      ForgeWorkItemError
    >;
    /**
     * The canonical item a reference names: a Forge URL, a friendly ref such as `YS-12` or
     * `YS-ARC-01`, `#<number>` or a number. A Spec, a Ticket and an Arc all resolve.
     */
    readonly resolve: (
      reference: string,
    ) => Effect.Effect<OrchestrationV2ThreadWorkItem, ForgeWorkItemError>;
    /**
     * The repository a Forge item belongs to, as the item's own read names it, so a task can be
     * refused when it is sent to another project. `none` when the item names no repository, or
     * when T3 cannot read it now: a project a caller cannot see is not one it may refuse.
     */
    readonly projectOf: (
      reference: ForgeItemReferenceInput,
    ) => Effect.Effect<Option.Option<string>>;
    /**
     * Links the thread to the item a reference names, replacing any earlier link, or unlinks it
     * for null. The one way people, agents and scheduled tasks set the link.
     */
    readonly link: (input: {
      readonly threadId: ThreadId;
      readonly reference: string | null;
      readonly commandId?: CommandId;
    }) => Effect.Effect<
      {
        readonly workItem: OrchestrationV2ThreadWorkItem | null;
        readonly dispatch: OrchestratorV2DispatchResult;
      },
      ForgeWorkItemError
    >;
  }
>()("t3/weave/ForgeWorkItems") {}

const error = (reason: ForgeWorkItemError["reason"], message: string) =>
  new ForgeWorkItemError({ reason, message });

const make = Effect.gen(function* () {
  const weave = yield* WeaveAgentConnections.WeaveAgentConnections;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const crypto = yield* SecureRandom.SecureRandom;
  const cache = new Map<string, CachedItem>();
  const numberCache = new Map<string, CachedNumber>();
  const cardCache = new Map<string, CachedCard>();
  const readLock = yield* KeyedLock.make<string>();
  const serviceScope = yield* Effect.scope;

  const shellOf = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(
      Effect.mapError(() => error("unavailable", "T3 could not read the thread.")),
      Effect.filterOrFail(
        (shell): shell is NonNullable<typeof shell> => shell !== null && shell.deletedAt === null,
        () => error("thread_not_found", `Thread ${threadId} was not found.`),
      ),
    );

  const readConnection = weave.read.pipe(
    Effect.mapError(() => error("unavailable", "T3 could not read its Weave connection.")),
  );

  /** Item and waits together: a blocker's change does not move the item's own revision. */
  const readSummary = (itemId: string) =>
    Effect.all(
      [
        weave.observe("weave_forge_query", { action: "read", itemId }),
        weave.observe("weave_forge_query", { action: "waits", itemId }),
      ],
      { concurrency: 2 },
    ).pipe(
      Effect.map(([read, waits]) =>
        Option.all([decodeForgeRead(read.value), decodeForgeWaits(waits.value)]).pipe(
          Option.flatMap(([item, itemWaits]) => summaryOf(item, itemWaits)),
        ),
      ),
      Effect.option,
      Effect.map(Option.flatten),
    );

  type Connection = { readonly origin: string; readonly connection: string };

  const changeFeeds = new Map<string, ChangeFeed>();

  /** Whether a cached summary may still be shown: nothing it names changed since it was read. */
  const isCurrent = (
    feed: ChangeFeed | undefined,
    cached: CachedItem,
    number: number,
    now: number,
  ) => {
    if (
      cached.unavailable ||
      cached.item === null ||
      cached.readAt === null ||
      feed === undefined ||
      !feed.ok
    )
      return now - cached.attemptedAt < BUILD_REREAD_INTERVAL_MS;
    if (now - cached.readAt >= SUMMARY_SAFETY_REFRESH_MS) return false;
    if (feed.allChangedAt > cached.attemptedAt) return false;
    return ![number, ...cached.item.waits.map((wait) => wait.number)].some(
      (changed) => (feed.changed.get(changed)?.seenAt ?? -1) > cached.attemptedAt,
    );
  };

  /** Every item Forge saved since `since`, page by page; none when an answer fails or can't be read. */
  const listChanges = Effect.fn("ForgeWorkItems.listChanges")(function* (since: number) {
    const found = new Map<number, string>();
    let offset = 0;
    for (let page = 0; page < CHANGE_MAX_PAGES; page++) {
      const answer = yield* weave
        .observe("weave_forge_query", {
          action: "list",
          updatedSince: DateTime.formatIso(DateTime.makeUnsafe(since)),
          limit: CHANGE_PAGE_LIMIT,
          offset,
        })
        .pipe(Effect.option);
      const decoded = Option.flatMap(answer, (result) => decodeChangeList(result.value));
      if (Option.isNone(decoded)) return Option.none();
      for (const entry of decoded.value.items) found.set(entry.number, entry.updatedAt);
      if (!decoded.value.hasMore) return Option.some({ found, overflow: false });
      const next = decoded.value.nextOffset;
      if (next === undefined || next === null || next <= offset) return Option.none();
      offset = next;
    }
    return Option.some({ found, overflow: true });
  });

  /**
   * Asks Forge what changed since the last check, at most once an interval per connection. A
   * failed or unreadable answer leaves the watermark where it was and marks the round `ok: false`.
   */
  const changeFeedOf = (connection: Connection) =>
    readLock.withLock(
      `changes\n${connection.connection}`,
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const previous = changeFeeds.get(connection.connection);
        if (previous !== undefined && now - previous.attemptedAt < BUILD_REREAD_INTERVAL_MS)
          return previous;
        const since = Math.max(0, (previous?.watermark ?? now) - CHANGE_CHECK_OVERLAP_MS);
        const listed =
          previous === undefined
            ? Option.some({ found: new Map<number, string>(), overflow: false })
            : yield* listChanges(since).pipe(
                Effect.timeoutOption(CHANGE_CHECK_TIMEOUT),
                Effect.map(Option.flatten),
              );
        // A change is seen when Forge answered, not when the check began: an item read while the
        // check was under way may predate a change the answer names, so it must still be reread.
        const answeredAt = yield* Clock.currentTimeMillis;
        const failed = Option.isNone(listed);
        const found = Option.match(listed, {
          onNone: () => new Map<number, string>(),
          onSome: (answer) => answer.found,
        });
        const overflow = Option.isSome(listed) && listed.value.overflow;
        if (failed) yield* Effect.logWarning("Could not check Forge for changes");
        const changed = new Map<number, { updatedAt: string; seenAt: number }>();
        for (const [number, entry] of previous?.changed ?? [])
          if (now - entry.seenAt < SUMMARY_SAFETY_REFRESH_MS) changed.set(number, entry);
        for (const [number, updatedAt] of found) {
          const known = changed.get(number);
          if (known === undefined || known.updatedAt !== updatedAt)
            changed.set(number, { updatedAt, seenAt: answeredAt });
        }
        const next: ChangeFeed = {
          attemptedAt: now,
          watermark: failed ? (previous?.watermark ?? now) : now,
          ok: !failed,
          allChangedAt: overflow ? answeredAt : (previous?.allChangedAt ?? -1),
          changed,
        };
        changeFeeds.set(connection.connection, next);
        return next;
      }),
    );

  /** An item as clients show it: read again only when a change check, a write or the safety refresh says so, or when `fresh`. */
  const summaryView = Effect.fn("ForgeWorkItems.summaryView")(function* (
    connection: Connection,
    target: { readonly itemId: string; readonly number: number },
    options?: ForgeWorkItemReadOptions,
  ) {
    const key = `${connection.connection}\n${target.itemId}`;
    const feed = yield* changeFeedOf(connection);
    const cached = yield* readLock.withLock(
      key,
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const previous = cache.get(key);
        if (
          options?.fresh !== true &&
          previous !== undefined &&
          isCurrent(feed, previous, target.number, now)
        ) {
          remember(cache, key, previous, ITEM_CACHE_LIMIT);
          return previous;
        }
        const read = yield* readSummary(target.itemId);
        const next: CachedItem = {
          ...Option.match(read, {
            onSome: (item) => ({ item, readAt: now, attemptedAt: now, unavailable: false }),
            onNone: () => ({
              item: previous?.item ?? null,
              readAt: previous?.readAt ?? null,
              attemptedAt: now,
              unavailable: true,
            }),
          }),
        };
        if (Option.isNone(read))
          yield* Effect.logWarning("Could not read a Forge item", { itemId: target.itemId });
        remember(cache, key, next, ITEM_CACHE_LIMIT);
        return next;
      }),
    );
    return {
      itemId: target.itemId,
      number: target.number,
      url: forgeItemUrl(connection.origin, target.number),
      item: cached.item,
      unavailable: cached.unavailable,
      readAt:
        cached.readAt === null ? null : DateTime.formatIso(DateTime.makeUnsafe(cached.readAt)),
    } satisfies ForgeWorkItemView;
  });

  const view: ForgeWorkItems["Service"]["view"] = Effect.fn("ForgeWorkItems.view")(
    function* (threadId) {
      const shell = yield* shellOf(threadId);
      const connection = yield* readConnection;
      if (connection === null) return null;
      const workItem = shell.workItem ?? null;
      if (workItem === null) return null;
      // Never resolved against another Weave: the same number there is a different item. A link made
      // at an address Weave has moved on from is this Weave's.
      if (!sameWeaveAddress(workItem.origin, connection.origin))
        return {
          itemId: workItem.itemId,
          number: workItem.number,
          url: forgeItemUrl(workItem.origin, workItem.number),
          item: null,
          unavailable: true,
          readAt: null,
        };
      return yield* summaryView(connection, workItem);
    },
  );

  const cachedSummary: ForgeWorkItems["Service"]["cachedSummary"] = Effect.fn(
    "ForgeWorkItems.cachedSummary",
  )(function* (workItem) {
    const connection = yield* readConnection.pipe(Effect.orElseSucceed(() => null));
    if (connection === null || !sameWeaveAddress(workItem.origin, connection.origin))
      return Option.none();
    const cached = cache.get(`${connection.connection}\n${workItem.itemId}`);
    const now = yield* Clock.currentTimeMillis;
    if (
      cached === undefined ||
      cached.unavailable ||
      cached.item === null ||
      cached.readAt === null
    )
      return Option.none();
    // An old read still stands while a recent change check saw nothing change it.
    const feed = changeFeeds.get(connection.connection);
    const stands =
      now - cached.readAt <= CACHED_SUMMARY_MAX_AGE_MS ||
      (feed !== undefined &&
        feed.ok &&
        now - feed.attemptedAt <= CACHED_SUMMARY_MAX_AGE_MS &&
        isCurrent(feed, cached, workItem.number, now));
    return stands ? Option.some(cached.item) : Option.none();
  });

  const warmSummary: ForgeWorkItems["Service"]["warmSummary"] = Effect.fn(
    "ForgeWorkItems.warmSummary",
  )(
    function* (workItem) {
      const connection = yield* readConnection;
      if (connection === null || !sameWeaveAddress(workItem.origin, connection.origin)) return;
      yield* summaryView(connection, workItem);
    },
    (read) => Effect.forkIn(Effect.ignoreCause(read), serviceScope),
  );

  /**
   * The item a number names on this Weave. A known number stays resolved, since Forge never reuses
   * one; an unknown one is asked again at most once a minute, and a failed read is not cached.
   */
  const itemIdOf = Effect.fn("ForgeWorkItems.itemIdOf")(function* (
    connection: Connection,
    number: number,
  ) {
    const key = `${connection.connection}\n#${number}`;
    return yield* readLock.withLock(
      key,
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const previous = numberCache.get(key);
        if (
          previous !== undefined &&
          (previous.itemId !== null || now - previous.attemptedAt < BUILD_REREAD_INTERVAL_MS)
        ) {
          remember(numberCache, key, previous, ITEM_CACHE_LIMIT);
          return Option.some(previous.itemId);
        }
        const read = yield* weave.observe("weave_forge_query", { action: "read", number }).pipe(
          Effect.map((result) =>
            Option.match(decodeForgeRead(result.value), {
              onNone: () => Option.none<string | null>(),
              onSome: (found) => Option.some(isItemKind(found.kind) ? found.id : null),
            }),
          ),
          // Forge answers `failed` for a number it doesn't know or this observer can't see.
          Effect.catch((cause) =>
            Effect.succeed(
              cause.reason === "failed" ? Option.some<string | null>(null) : Option.none(),
            ),
          ),
        );
        if (Option.isSome(read))
          remember(numberCache, key, { itemId: read.value, attemptedAt: now }, ITEM_CACHE_LIMIT);
        return read;
      }),
    );
  });

  const mentions: ForgeWorkItems["Service"]["mentions"] = Effect.fn("ForgeWorkItems.mentions")(
    function* (input, options) {
      yield* shellOf(input.threadId);
      const connection = yield* readConnection;
      if (connection === null) return { items: [] };
      let unreachable = false;
      const views = yield* Effect.forEach(
        [...new Set(input.numbers)],
        (number) =>
          itemIdOf(connection, number).pipe(
            Effect.flatMap((itemId) => {
              if (Option.isNone(itemId)) unreachable = true;
              return Option.isSome(itemId) && itemId.value !== null
                ? summaryView(connection, { itemId: itemId.value, number }, options).pipe(
                    Effect.asSome,
                  )
                : Effect.succeed(Option.none<ForgeWorkItemView>());
            }),
          ),
        { concurrency: 4 },
      );
      return {
        items: views.flatMap((found) => (Option.isSome(found) ? [found.value] : [])),
        ...(unreachable ? { unavailable: true } : {}),
      };
    },
  );

  /** The item a reference names, with the repository its own read names. */
  const readReference = Effect.fn("ForgeWorkItems.readReference")(function* (reference: string) {
    const connection = yield* readConnection;
    if (connection === null) return yield* error("not_connected", "T3 is not connected to Weave.");
    const parsed = parseForgeReference(reference);
    if (parsed === null)
      return yield* error(
        "invalid_reference",
        "Give a Forge URL such as https://weave.example/build/1000123, a ref such as YS-12 or YS-ARC-01, #1000123 or 1000123.",
      );
    if (
      parsed.kind === "number" &&
      parsed.origin !== null &&
      !sameWeaveAddress(parsed.origin, connection.origin)
    )
      return yield* error(
        "other_hq",
        `That link is on ${parsed.origin}, but T3 uses ${connection.origin}.`,
      );
    const named = parsed.kind === "ref" ? parsed.ref : `#${parsed.number}`;
    const read = yield* weave
      .observe("weave_forge_query", {
        action: "read",
        ...(parsed.kind === "ref" ? { ref: parsed.ref } : { number: parsed.number }),
      })
      .pipe(
        Effect.mapError((cause) =>
          cause.reason === "failed"
            ? error(
                "not_found",
                parsed.kind === "ref"
                  ? `Forge has no item ${named} you can see (or this Weave doesn't know friendly refs yet).`
                  : `Forge has no item ${named} you can see.`,
              )
            : cause.reason === "not_connected"
              ? error("not_connected", "T3 is not connected to Weave.")
              : error("unavailable", "Weave could not be reached. Try again shortly."),
        ),
      );
    const item = decodeForgeRead(read.value);
    if (Option.isNone(item))
      return yield* error("unavailable", "Weave returned an item T3 could not read.");
    if (!isItemKind(item.value.kind))
      return yield* error(
        "unsupported_kind",
        `${named} is a Forge ${item.value.kind}; link a Spec, a Ticket or an Arc.`,
      );
    return {
      item: { itemId: item.value.id, number: item.value.number, origin: read.origin },
      project: item.value.project ?? null,
    };
  });

  const resolve: ForgeWorkItems["Service"]["resolve"] = Effect.fn("ForgeWorkItems.resolve")(
    function* (reference) {
      const { item } = yield* readReference(reference);
      return item;
    },
  );

  const projectOf: ForgeWorkItems["Service"]["projectOf"] = Effect.fn("ForgeWorkItems.projectOf")(
    function* (reference) {
      const read = yield* readReference(String(reference)).pipe(Effect.option);
      return Option.flatMap(read, (found) => Option.fromNullishOr(found.project));
    },
  );

  const link: ForgeWorkItems["Service"]["link"] = Effect.fn("ForgeWorkItems.link")(
    function* (input) {
      yield* shellOf(input.threadId);
      const workItem = input.reference === null ? null : yield* resolve(input.reference);
      const commandId =
        input.commandId ??
        CommandId.make(`command:build-work-item:${yield* crypto.uuidV4().pipe(Effect.orDie)}`);
      const dispatch = yield* threads
        .dispatch({ type: "thread.metadata.update", commandId, threadId: input.threadId, workItem })
        .pipe(
          Effect.mapError((cause) =>
            error("dispatch_failed", `T3 could not update the thread: ${cause.message}`),
          ),
        );
      return { workItem, dispatch };
    },
  );

  const reference = (item: typeof ForgeReference.Type): ForgeItemReference => ({
    number: item.number,
    ...(item.ref === undefined ? {} : { ref: item.ref }),
    title: item.title,
    status: item.status,
  });

  /** Everything a card shows, or none when Forge fails or answers with something unexpected. */
  const readCard = Effect.fn("ForgeWorkItems.readCard")(
    function* (itemId: string) {
      const none = Option.none<FreshCard>();
      const observe = (tool: string, args: Record<string, unknown>) =>
        weave.observe(tool, args).pipe(Effect.map((result) => result.value));
      const [readValue, waitsValue] = yield* Effect.all(
        [
          observe("weave_forge_query", { action: "read", itemId }),
          observe("weave_forge_query", { action: "waits", itemId }),
        ],
        { concurrency: 2 },
      );
      const read = decodeForgeCardRead(readValue);
      const waits = decodeForgeWaits(waitsValue);
      if (Option.isNone(read) || Option.isNone(waits)) return none;
      const item = summaryOf(read.value, waits.value);
      if (Option.isNone(item)) return none;
      const fields = read.value;
      const changes: Array<string | null | undefined> = [
        fields.createdAt,
        ...fields.updates.map((update) => update.createdAt),
        ...fields.holds.flatMap((hold) => [hold.openedAt, hold.clearedAt]),
      ];

      if (item.value.kind === "arc")
        return Option.some<FreshCard>({
          number: fields.number,
          item: item.value,
          summary: fields.summary?.slice(0, CARD_SUMMARY_LIMIT) ?? null,
          updatedAt: latestOf(changes),
          detail: { kind: "arc" as const },
        });

      if (item.value.kind === "spec") {
        const [ticketsValue, sessionsValue, acceptanceValue] = yield* Effect.all(
          [
            observe("weave_forge_query", { action: "list", kind: "ticket", parentId: itemId }),
            observe("weave_forge_query", { action: "sessions", specId: itemId }),
            item.value.status === "accepted"
              ? observe("weave_forge_query", { action: "acceptance", specId: itemId })
              : Effect.succeed(null),
          ],
          { concurrency: 3 },
        );
        const tickets = decodeForgeList(ticketsValue);
        const sessions = decodeForgeSessions(sessionsValue);
        const acceptance = decodeForgeAcceptance(acceptanceValue);
        if (Option.isNone(tickets) || Option.isNone(sessions) || Option.isNone(acceptance))
          return none;
        const lead = pickSession(sessions.value, (session) => session.parentSessionId === null);
        const ticketCounts: Record<string, number> = {};
        for (const ticket of tickets.value)
          ticketCounts[ticket.status] = (ticketCounts[ticket.status] ?? 0) + 1;
        return Option.some<FreshCard>({
          number: fields.number,
          item: item.value,
          summary: fields.summary?.slice(0, CARD_SUMMARY_LIMIT) ?? null,
          updatedAt: latestOf([...changes, lead?.lastActivityAt, acceptance.value?.acceptedAt]),
          detail: {
            kind: "spec" as const,
            specKind: fields.specKind,
            horizon: fields.effectiveHorizon,
            ticketCounts,
            tickets: tickets.value.slice(0, CARD_TICKET_LIMIT).map(reference),
            acceptedAt: acceptance.value?.acceptedAt ?? null,
            governedBy: (fields.governedBy ?? []).map(reference),
            lead,
          },
        });
      }

      const parentId = fields.parentId;
      const [parentValue, attemptsValue, sessionsValue] = yield* Effect.all(
        [
          parentId === null
            ? Effect.succeed(null)
            : observe("weave_forge_query", { action: "read", itemId: parentId }),
          observe("weave_forge_query", { action: "attempts", itemId }),
          parentId === null
            ? Effect.succeed([])
            : observe("weave_forge_query", { action: "sessions", specId: parentId }),
        ],
        { concurrency: 3 },
      );
      const parent = parentValue === null ? Option.some(null) : decodeForgeCardRead(parentValue);
      const attempts = decodeForgeAttempts(attemptsValue);
      const sessions = decodeForgeSessions(sessionsValue);
      if (Option.isNone(parent) || Option.isNone(attempts) || Option.isNone(sessions)) return none;
      const worker = pickSession(
        sessions.value,
        (session) => session.parentSessionId !== null && session.ticketIds.includes(itemId),
      );
      const latestAttempt = attempts.value.at(-1);
      const latestAttemptAt = latestAttempt?.events.at(-1)?.occurredAt;
      const lastFailure = attempts.value.findLast((attempt) => attempt.failure !== null)?.failure;
      return Option.some<FreshCard>({
        number: fields.number,
        item: item.value,
        summary: fields.summary?.slice(0, CARD_SUMMARY_LIMIT) ?? null,
        updatedAt: latestOf([...changes, worker?.lastActivityAt, latestAttemptAt]),
        detail: {
          kind: "ticket" as const,
          spec: parent.value === null ? null : reference(parent.value),
          attempts: attempts.value.length,
          latestAttempt:
            latestAttempt === undefined || latestAttemptAt === undefined
              ? null
              : { status: latestAttempt.status, at: latestAttemptAt },
          lastFailure: lastFailure ?? null,
          worker,
        },
      });
    },
    Effect.option,
    Effect.map(Option.flatten),
  );

  const card: ForgeWorkItems["Service"]["card"] = Effect.fn("ForgeWorkItems.card")(
    function* (input) {
      const shell = yield* shellOf(input.threadId);
      const connection = yield* readConnection;
      if (connection === null) return null;
      // The link's item is on another Weave: never read it, or its number, on this one.
      if (
        shell.workItem?.itemId === input.itemId &&
        !sameWeaveAddress(shell.workItem.origin, connection.origin)
      )
        return yield* error(
          "unavailable",
          `This link is on ${shell.workItem.origin}, but T3 uses ${connection.origin}.`,
        );
      const key = `${connection.connection}\n${input.itemId}`;
      const cached = yield* readLock.withLock(
        `card\n${key}`,
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const previous = cardCache.get(key);
          // Opening a card reads at once; only a client's periodic re-reads are rate-limited.
          if (
            previous !== undefined &&
            previous.opens.includes(input.open) &&
            now - previous.attemptedAt < previous.intervalMs
          ) {
            remember(cardCache, key, previous, CARD_CACHE_LIMIT);
            return previous;
          }
          const opens = [
            input.open,
            ...(previous?.opens ?? []).filter((open) => open !== input.open),
          ].slice(0, CARD_OPENS_REMEMBERED);
          const read = yield* readCard(input.itemId);
          const fingerprint = Option.isSome(read) ? fingerprintOf(read.value) : undefined;
          const next: CachedCard = {
            fingerprint,
            intervalMs: nextInterval(previous, fingerprint),
            ...Option.match(read, {
              onSome: (fresh) => ({
                card: {
                  ...fresh,
                  url: forgeItemUrl(connection.origin, fresh.number),
                  updatedAt: fresh.updatedAt ?? DateTime.formatIso(DateTime.makeUnsafe(now)),
                  readAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
                },
                attemptedAt: now,
                unavailable: false,
                opens,
              }),
              onNone: () => ({
                card: previous?.card ?? null,
                attemptedAt: now,
                unavailable: true,
                opens,
              }),
            }),
          };
          if (Option.isNone(read))
            yield* Effect.logWarning("Could not read a Forge item's card", {
              itemId: input.itemId,
            });
          remember(cardCache, key, next, CARD_CACHE_LIMIT);
          return next;
        }),
      );
      if (cached.card === null)
        return yield* error("unavailable", "Weave could not be reached. Try again shortly.");
      return { ...cached.card, unavailable: cached.unavailable };
    },
  );

  return ForgeWorkItems.of({
    view,
    cachedSummary,
    warmSummary,
    card,
    mentions,
    resolve,
    projectOf,
    link,
    connected: readConnection.pipe(
      Effect.map((connection) => ({
        connected: connection !== null,
        origin: connection?.origin ?? null,
        refused: connection?.refused ?? false,
      })),
    ),
  });
});

export const layer = Layer.effect(ForgeWorkItems, make);
