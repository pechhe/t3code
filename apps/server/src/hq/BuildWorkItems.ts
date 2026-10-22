/**
 * A thread's link to the HQ Build Spec or Ticket it works on (pechhe/t3code#78). T3 stores only
 * the reference; what clients show is read from Build through the server's own observer agent,
 * so every client, local or remote, sees the same state without ever reaching HQ itself.
 */
import {
  type BuildItemReference,
  type BuildWorkItemCard,
  type BuildWorkItemCardInput,
  type BuildWorkItemCardResult,
  BuildWorkItemError,
  type BuildWorkItemMentionsInput,
  type BuildWorkItemMentionsResult,
  BuildWorkItemSummary,
  type BuildWorkItemReadResult,
  type BuildWorkItemSession,
  CommandId,
  type OrchestrationV2ThreadWorkItem,
  type ThreadId,
  type BuildWorkItemView,
} from "@t3tools/contracts";
import { buildItemUrl, parseBuildReference } from "@t3tools/shared/buildLinks";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import type { OrchestratorV2DispatchResult } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as HqAgentConnections from "./HqAgentConnections.ts";

/**
 * Build has no change feed. Clients re-request a shown item on this cadence, and the server
 * starts at this interval and backs off unchanged results to four minutes, so with one client
 * re-request on top a change still shows within five. No timer reads HQ here.
 */
export const BUILD_REREAD_INTERVAL_MS = 60_000;
export const BUILD_MAX_REREAD_INTERVAL_MS = 4 * BUILD_REREAD_INTERVAL_MS;
export const fingerprintOf = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export interface Cadence {
  readonly intervalMs: number;
  readonly fingerprint: string | undefined;
}

/** A read an agent's own Build write expires, as a work item's is. */
export interface ReadCadence extends Cadence {
  readonly writeVersion: number;
}

/**
 * A Build write through T3 makes the next request reread at once; the back-off itself follows
 * only whether this result changed, so another thread's unrelated write keeps it settled.
 */
export const nextInterval = (previous: Cadence | undefined, fingerprint: string | undefined) =>
  fingerprint !== undefined && previous?.fingerprint === fingerprint
    ? Math.min(previous.intervalMs * 2, BUILD_MAX_REREAD_INTERVAL_MS)
    : BUILD_REREAD_INTERVAL_MS;

/** An older HQ omits `ref`; an older item has none, and an empty one is none. */
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
  holds: Schema.Array(
    Schema.Struct({
      kind: Schema.String,
      note: Schema.String,
      clearedAt: Schema.NullOr(Schema.String),
    }),
  ),
});
const decodeBuildRead = Schema.decodeUnknownOption(BuildRead);

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
const decodeBuildWaits = Schema.decodeUnknownOption(BuildWaits);
const BuildReference = Schema.Struct({
  id: Schema.String,
  number: Schema.Number,
  ref: BuildRef,
  title: Schema.String,
  status: Schema.String,
});
const decodeSummary = Schema.decodeUnknownOption(BuildWorkItemSummary);

const summaryOf = (
  read: typeof BuildRead.Type,
  waits: typeof BuildWaits.Type,
): Option.Option<BuildWorkItemSummary> =>
  decodeSummary({
    kind: read.kind,
    ...(read.ref === undefined ? {} : { ref: read.ref }),
    title: read.title,
    status: read.status,
    holds: read.holds
      .filter((hold) => hold.clearedAt === null)
      .map(({ kind, note }) => ({ kind, note })),
    waits: waits.map(({ required, blocker }) => ({
      number: blocker.number,
      ...(blocker.ref === undefined ? {} : { ref: blocker.ref }),
      title: blocker.title,
      status: blocker.status,
      required,
    })),
  });

/** The parts of `hq_build_read` a card shows. Bodies are never requested. */
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
  governedBy: Schema.optionalKey(Schema.Array(BuildReference)),
});
const decodeBuildCardRead = Schema.decodeUnknownOption(BuildCardRead);
const decodeBuildList = Schema.decodeUnknownOption(Schema.Array(BuildReference));
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
const decodeBuildSessions = Schema.decodeUnknownOption(Schema.Array(BuildSession));
const decodeBuildAttempts = Schema.decodeUnknownOption(
  Schema.Array(
    Schema.Struct({
      status: Schema.String,
      failure: Schema.NullOr(Schema.Struct({ stage: Schema.String, cause: Schema.String })),
      events: Schema.Array(Schema.Struct({ occurredAt: Schema.String })),
    }),
  ),
);
const decodeBuildAcceptance = Schema.decodeUnknownOption(
  Schema.NullOr(Schema.Struct({ acceptedAt: Schema.String })),
);

/** Tickets a Spec card names before "+N more". */
export const CARD_TICKET_LIMIT = 5;
/** Build's summary is already plain text; a card shows three lines of it. */
const CARD_SUMMARY_LIMIT = 400;

/**
 * The session to show for an item: the open one of the current bind generation with the latest
 * activity or, with none open, the one that ended last.
 */
const pickSession = (
  sessions: ReadonlyArray<typeof BuildSession.Type>,
  matches: (session: typeof BuildSession.Type) => boolean,
): BuildWorkItemSession | null => {
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

/** A card as Build answered it, before T3 adds where and when it was read. */
type FreshCard = Omit<BuildWorkItemCard, "url" | "updatedAt" | "readAt" | "unavailable"> & {
  readonly updatedAt: string | undefined;
};

interface CachedCard extends ReadCadence {
  readonly card: Omit<BuildWorkItemCard, "unavailable"> | null;
  readonly attemptedAt: number;
  readonly unavailable: boolean;
  /** Recent openings of this card; a polling client repeats its own, a new one reads at once. */
  readonly opens: ReadonlyArray<string>;
}

/** Openings remembered per card, enough for every client showing it at once. */
const CARD_OPENS_REMEMBERED = 32;
/** Cards kept for their last known state; the least recently asked for go first. */
export const CARD_CACHE_LIMIT = 256;

interface CachedItem extends ReadCadence {
  readonly item: BuildWorkItemSummary | null;
  readonly readAt: number | null;
  readonly attemptedAt: number;
  readonly unavailable: boolean;
}

/** Items kept for their last known summary, and numbers kept resolved, per HQ connection. */
export const ITEM_CACHE_LIMIT = 1024;

/** A number resolved on one HQ: its item, or null while Build doesn't know it. */
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

export class BuildWorkItems extends Context.Service<
  BuildWorkItems,
  {
    /** The thread's linked item as clients show it; null without a link or an HQ connection. */
    readonly view: (
      threadId: ThreadId,
    ) => Effect.Effect<BuildWorkItemReadResult, BuildWorkItemError>;
    /**
     * The card for an item read from T3's HQ: its summary, Tickets or delivery,
     * and who works on it. A new `open` reads Build at once; repeating it reads at most once a
     * minute.
     */
    readonly card: (
      input: BuildWorkItemCardInput,
    ) => Effect.Effect<BuildWorkItemCardResult, BuildWorkItemError>;
    /**
     * Items mentioned in the thread's messages, by number on T3's HQ, as clients show
     * them. Shares the linked item's cache and cadence; a number Build doesn't know is absent, and
     * `unavailable` tells that apart from Build being unreachable.
     */
    readonly mentions: (
      input: BuildWorkItemMentionsInput,
    ) => Effect.Effect<BuildWorkItemMentionsResult, BuildWorkItemError>;
    /** Whether threads can link Build items at all. */
    readonly connected: Effect.Effect<
      { readonly connected: boolean; readonly origin: string | null },
      BuildWorkItemError
    >;
    /**
     * The canonical item a reference names: a Build URL, a friendly ref such as `YS-12`,
     * `#<number>` or a number. Only a Spec or a Ticket resolves.
     */
    readonly resolve: (
      reference: string,
    ) => Effect.Effect<OrchestrationV2ThreadWorkItem, BuildWorkItemError>;
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
      BuildWorkItemError
    >;
  }
>()("t3/hq/BuildWorkItems") {}

const error = (reason: BuildWorkItemError["reason"], message: string) =>
  new BuildWorkItemError({ reason, message });

const make = Effect.gen(function* () {
  const hq = yield* HqAgentConnections.HqAgentConnections;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const crypto = yield* Crypto.Crypto;
  const cache = new Map<string, CachedItem>();
  const numberCache = new Map<string, CachedNumber>();
  const cardCache = new Map<string, CachedCard>();
  const readLock = yield* KeyedLock.make<string>();

  const shellOf = (threadId: ThreadId) =>
    threads.getThreadShell(threadId).pipe(
      Effect.mapError(() => error("unavailable", "T3 could not read the thread.")),
      Effect.flatMap((shell) =>
        shell === null || shell.deletedAt !== null
          ? Effect.fail(error("thread_not_found", `Thread ${threadId} was not found.`))
          : Effect.succeed(shell),
      ),
    );

  const readConnection = hq.read.pipe(
    Effect.mapError(() => error("unavailable", "T3 could not read its HQ connection.")),
  );

  /** Item and waits together: a blocker's change does not move the item's own revision. */
  const readSummary = (itemId: string) =>
    Effect.all(
      [hq.observe("hq_build_read", { itemId }), hq.observe("hq_build_waits", { itemId })],
      { concurrency: 2 },
    ).pipe(
      Effect.map(([read, waits]) =>
        Option.all([decodeBuildRead(read.value), decodeBuildWaits(waits.value)]).pipe(
          Option.flatMap(([item, itemWaits]) => summaryOf(item, itemWaits)),
        ),
      ),
      Effect.option,
      Effect.map(Option.flatten),
    );

  type Connection = { readonly origin: string; readonly connection: string };

  /** An item as clients show it, on its adaptive cadence however many ask. */
  const summaryView = Effect.fn("BuildWorkItems.summaryView")(function* (
    connection: Connection,
    target: { readonly itemId: string; readonly number: number },
  ) {
    const key = `${connection.connection}\n${target.itemId}`;
    const cached = yield* readLock.withLock(
      key,
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const previous = cache.get(key);
        const writeVersion = yield* hq.buildWriteVersion;
        if (
          previous !== undefined &&
          previous.writeVersion === writeVersion &&
          now - previous.attemptedAt < previous.intervalMs
        ) {
          remember(cache, key, previous, ITEM_CACHE_LIMIT);
          return previous;
        }
        const read = yield* readSummary(target.itemId);
        const fingerprint = Option.isSome(read) ? fingerprintOf(read.value) : undefined;
        const next: CachedItem = {
          fingerprint,
          writeVersion,
          intervalMs: nextInterval(previous, fingerprint),
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
          yield* Effect.logWarning("Could not read a Build item", { itemId: target.itemId });
        remember(cache, key, next, ITEM_CACHE_LIMIT);
        return next;
      }),
    );
    return {
      itemId: target.itemId,
      number: target.number,
      url: buildItemUrl(connection.origin, target.number),
      item: cached.item,
      unavailable: cached.unavailable,
      readAt:
        cached.readAt === null ? null : DateTime.formatIso(DateTime.makeUnsafe(cached.readAt)),
    } satisfies BuildWorkItemView;
  });

  const view: BuildWorkItems["Service"]["view"] = Effect.fn("BuildWorkItems.view")(
    function* (threadId) {
      const shell = yield* shellOf(threadId);
      const connection = yield* readConnection;
      if (connection === null) return null;
      const workItem = shell.workItem ?? null;
      if (workItem === null) return null;
      // Never resolved against another HQ: the same number there is a different item.
      if (connection.origin !== workItem.origin)
        return {
          itemId: workItem.itemId,
          number: workItem.number,
          url: buildItemUrl(workItem.origin, workItem.number),
          item: null,
          unavailable: true,
          readAt: null,
        };
      return yield* summaryView(connection, workItem);
    },
  );

  /**
   * The item a number names on this HQ. A known number stays resolved, since Build never reuses
   * one; an unknown one is asked again at most once a minute, and a failed read is not cached.
   */
  const itemIdOf = Effect.fn("BuildWorkItems.itemIdOf")(function* (
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
        const read = yield* hq.observe("hq_build_read", { number }).pipe(
          Effect.map((result) =>
            Option.match(decodeBuildRead(result.value), {
              onNone: () => Option.none<string | null>(),
              onSome: (found) =>
                Option.some(found.kind === "spec" || found.kind === "ticket" ? found.id : null),
            }),
          ),
          // Build answers `failed` for a number it doesn't know or this observer can't see.
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

  const mentions: BuildWorkItems["Service"]["mentions"] = Effect.fn("BuildWorkItems.mentions")(
    function* (input) {
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
                ? summaryView(connection, { itemId: itemId.value, number }).pipe(
                    Effect.map(Option.some),
                  )
                : Effect.succeed(Option.none<BuildWorkItemView>());
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

  const resolve: BuildWorkItems["Service"]["resolve"] = Effect.fn("BuildWorkItems.resolve")(
    function* (reference) {
      const connection = yield* readConnection;
      if (connection === null)
        return yield* error("not_connected", "T3 is not connected to YardSmith HQ.");
      const parsed = parseBuildReference(reference);
      if (parsed === null)
        return yield* error(
          "invalid_reference",
          "Give a Build URL such as https://hq.example/build/1000123, a ref such as YS-12, #1000123 or 1000123.",
        );
      if (parsed.kind === "number" && parsed.origin !== null && parsed.origin !== connection.origin)
        return yield* error(
          "other_hq",
          `That link is on ${parsed.origin}, but T3 uses ${connection.origin}.`,
        );
      const named = parsed.kind === "ref" ? parsed.ref : `#${parsed.number}`;
      const read = yield* hq
        .observe(
          "hq_build_read",
          parsed.kind === "ref" ? { ref: parsed.ref } : { number: parsed.number },
        )
        .pipe(
          Effect.mapError((cause) =>
            cause.reason === "failed"
              ? error(
                  "not_found",
                  parsed.kind === "ref"
                    ? `Build has no item ${named} you can see (or this HQ doesn't know friendly refs yet).`
                    : `Build has no item ${named} you can see.`,
                )
              : cause.reason === "not_connected"
                ? error("not_connected", "T3 is not connected to YardSmith HQ.")
                : error("unavailable", "YardSmith HQ could not be reached. Try again shortly."),
          ),
        );
      const item = decodeBuildRead(read.value);
      if (Option.isNone(item))
        return yield* error("unavailable", "YardSmith HQ returned an item T3 could not read.");
      if (item.value.kind !== "spec" && item.value.kind !== "ticket")
        return yield* error(
          "unsupported_kind",
          `${named} is a Build ${item.value.kind}; link a Spec or a Ticket.`,
        );
      return { itemId: item.value.id, number: item.value.number, origin: read.origin };
    },
  );

  const link: BuildWorkItems["Service"]["link"] = Effect.fn("BuildWorkItems.link")(
    function* (input) {
      yield* shellOf(input.threadId);
      const workItem = input.reference === null ? null : yield* resolve(input.reference);
      const commandId =
        input.commandId ??
        CommandId.make(
          `command:build-work-item:${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
        );
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

  const reference = (item: typeof BuildReference.Type): BuildItemReference => ({
    number: item.number,
    ...(item.ref === undefined ? {} : { ref: item.ref }),
    title: item.title,
    status: item.status,
  });

  /** Everything a card shows, or none when Build fails or answers with something unexpected. */
  const readCard = Effect.fn("BuildWorkItems.readCard")(
    function* (itemId: string) {
      const none = Option.none<FreshCard>();
      const observe = (tool: string, args: Record<string, unknown>) =>
        hq.observe(tool, args).pipe(Effect.map((result) => result.value));
      const [readValue, waitsValue] = yield* Effect.all(
        [observe("hq_build_read", { itemId }), observe("hq_build_waits", { itemId })],
        { concurrency: 2 },
      );
      const read = decodeBuildCardRead(readValue);
      const waits = decodeBuildWaits(waitsValue);
      if (Option.isNone(read) || Option.isNone(waits)) return none;
      const item = summaryOf(read.value, waits.value);
      if (Option.isNone(item)) return none;
      const fields = read.value;
      const changes: Array<string | null | undefined> = [
        fields.createdAt,
        ...fields.updates.map((update) => update.createdAt),
        ...fields.holds.flatMap((hold) => [hold.openedAt, hold.clearedAt]),
      ];

      if (item.value.kind === "spec") {
        const [ticketsValue, sessionsValue, acceptanceValue] = yield* Effect.all(
          [
            observe("hq_build_list", { kind: "ticket", parentId: itemId }),
            observe("hq_build_sessions", { specId: itemId }),
            item.value.status === "accepted"
              ? observe("hq_build_acceptance", { specId: itemId })
              : Effect.succeed(null),
          ],
          { concurrency: 3 },
        );
        const tickets = decodeBuildList(ticketsValue);
        const sessions = decodeBuildSessions(sessionsValue);
        const acceptance = decodeBuildAcceptance(acceptanceValue);
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
          parentId === null ? Effect.succeed(null) : observe("hq_build_read", { itemId: parentId }),
          observe("hq_build_attempts", { itemId }),
          parentId === null
            ? Effect.succeed([])
            : observe("hq_build_sessions", { specId: parentId }),
        ],
        { concurrency: 3 },
      );
      const parent = parentValue === null ? Option.some(null) : decodeBuildCardRead(parentValue);
      const attempts = decodeBuildAttempts(attemptsValue);
      const sessions = decodeBuildSessions(sessionsValue);
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

  const card: BuildWorkItems["Service"]["card"] = Effect.fn("BuildWorkItems.card")(
    function* (input) {
      const shell = yield* shellOf(input.threadId);
      const connection = yield* readConnection;
      if (connection === null) return null;
      // The link's item is on another HQ: never read it, or its number, on this one.
      if (shell.workItem?.itemId === input.itemId && shell.workItem.origin !== connection.origin)
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
          const writeVersion = yield* hq.buildWriteVersion;
          // Opening a card reads at once; only a client's periodic re-reads are rate-limited.
          if (
            previous !== undefined &&
            previous.opens.includes(input.open) &&
            previous.writeVersion === writeVersion &&
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
            writeVersion,
            intervalMs: nextInterval(previous, fingerprint),
            ...Option.match(read, {
              onSome: (fresh) => ({
                card: {
                  ...fresh,
                  url: buildItemUrl(connection.origin, fresh.number),
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
            yield* Effect.logWarning("Could not read a Build item's card", {
              itemId: input.itemId,
            });
          remember(cardCache, key, next, CARD_CACHE_LIMIT);
          return next;
        }),
      );
      if (cached.card === null)
        return yield* error("unavailable", "YardSmith HQ could not be reached. Try again shortly.");
      return { ...cached.card, unavailable: cached.unavailable };
    },
  );

  return BuildWorkItems.of({
    view,
    card,
    mentions,
    resolve,
    link,
    connected: readConnection.pipe(
      Effect.map((connection) => ({
        connected: connection !== null,
        origin: connection?.origin ?? null,
      })),
    ),
  });
});

export const layer = Layer.effect(BuildWorkItems, make);
