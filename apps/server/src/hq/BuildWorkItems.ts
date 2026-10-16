/**
 * A thread's link to the HQ Build Spec or Ticket it works on (pechhe/t3code#78). T3 stores only
 * the reference; what clients show is read from Build through the server's own observer agent,
 * so every client, local or remote, sees the same state without ever reaching HQ itself.
 */
import {
  BuildWorkItemError,
  BuildWorkItemSummary,
  type BuildWorkItemReadResult,
  CommandId,
  type OrchestrationV2ThreadWorkItem,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { OrchestratorV2DispatchResult } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as HqAgentConnections from "./HqAgentConnections.ts";

/**
 * Build has no change feed. Clients re-request a shown item on this cadence, and the server
 * reads Build at most this often per item however many clients ask.
 */
export const BUILD_REREAD_INTERVAL_MS = 60_000;

const BuildRead = Schema.Struct({
  id: Schema.String,
  number: Schema.Number,
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
    blocker: Schema.Struct({ number: Schema.Number, title: Schema.String, status: Schema.String }),
  }),
);
const decodeBuildWaits = Schema.decodeUnknownOption(BuildWaits);
const decodeSummary = Schema.decodeUnknownOption(BuildWorkItemSummary);

const summaryOf = (
  read: typeof BuildRead.Type,
  waits: typeof BuildWaits.Type,
): Option.Option<BuildWorkItemSummary> =>
  decodeSummary({
    kind: read.kind,
    title: read.title,
    status: read.status,
    holds: read.holds
      .filter((hold) => hold.clearedAt === null)
      .map(({ kind, note }) => ({ kind, note })),
    waits: waits.map(({ required, blocker }) => ({
      number: blocker.number,
      title: blocker.title,
      status: blocker.status,
      required,
    })),
  });

/** A Build URL on any HQ, `#<number>` or a bare number. */
export const parseBuildReference = (
  reference: string,
): { readonly number: number; readonly origin: string | null } | null => {
  const trimmed = reference.trim();
  const bare = /^#?(\d+)$/.exec(trimmed);
  if (bare) return { number: Number(bare[1]), origin: null };
  try {
    const url = new URL(trimmed);
    const path = /^\/build\/(?:specs\/)?(\d+)\/?$/.exec(url.pathname);
    return path ? { number: Number(path[1]), origin: url.origin } : null;
  } catch {
    return null;
  }
};

interface CachedItem {
  readonly item: BuildWorkItemSummary | null;
  readonly readAt: number | null;
  readonly attemptedAt: number;
  readonly unavailable: boolean;
}

export class BuildWorkItems extends Context.Service<
  BuildWorkItems,
  {
    /** The thread's linked item as clients show it; null without a link or an HQ connection. */
    readonly view: (
      threadId: ThreadId,
    ) => Effect.Effect<BuildWorkItemReadResult, BuildWorkItemError>;
    /** Whether the project's threads can link Build items at all. */
    readonly connected: (
      projectId: ProjectId,
    ) => Effect.Effect<{ readonly connected: boolean }, BuildWorkItemError>;
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

  const connectionOf = (projectId: ProjectId) =>
    hq
      .read(projectId)
      .pipe(
        Effect.mapError(() =>
          error("unavailable", "T3 could not read the project's HQ connection."),
        ),
      );

  /** Item and waits together: a blocker's change does not move the item's own revision. */
  const readSummary = (projectId: ProjectId, itemId: string) =>
    Effect.all(
      [
        hq.observe(projectId, "hq_build_read", { itemId }),
        hq.observe(projectId, "hq_build_waits", { itemId }),
      ],
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

  const view: BuildWorkItems["Service"]["view"] = Effect.fn("BuildWorkItems.view")(
    function* (threadId) {
      const shell = yield* shellOf(threadId);
      const connection = yield* connectionOf(shell.projectId);
      if (connection === null) return null;
      const workItem = shell.workItem ?? null;
      if (workItem === null) return null;
      const base = {
        itemId: workItem.itemId,
        number: workItem.number,
        url: `${workItem.origin}/build/${workItem.number}`,
      };
      // Never resolved against another HQ: the same number there is a different item.
      if (connection.origin !== workItem.origin)
        return { ...base, item: null, unavailable: true, readAt: null };
      const key = `${connection.connection}\n${workItem.itemId}`;
      const cached = yield* readLock.withLock(
        key,
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const previous = cache.get(key);
          if (previous !== undefined && now - previous.attemptedAt < BUILD_REREAD_INTERVAL_MS)
            return previous;
          const read = yield* readSummary(shell.projectId, workItem.itemId);
          const next: CachedItem = Option.match(read, {
            onSome: (item) => ({ item, readAt: now, attemptedAt: now, unavailable: false }),
            onNone: () => ({
              item: previous?.item ?? null,
              readAt: previous?.readAt ?? null,
              attemptedAt: now,
              unavailable: true,
            }),
          });
          if (Option.isNone(read))
            yield* Effect.logWarning("Could not read a thread's Build item", {
              threadId,
              itemId: workItem.itemId,
            });
          cache.set(key, next);
          return next;
        }),
      );
      return {
        ...base,
        item: cached.item,
        unavailable: cached.unavailable,
        readAt:
          cached.readAt === null ? null : DateTime.formatIso(DateTime.makeUnsafe(cached.readAt)),
      };
    },
  );

  const resolve = Effect.fn("BuildWorkItems.resolve")(function* (
    projectId: ProjectId,
    reference: string,
  ) {
    const connection = yield* connectionOf(projectId);
    if (connection === null)
      return yield* error(
        "not_connected",
        "This thread's project is not connected to YardSmith HQ.",
      );
    const parsed = parseBuildReference(reference);
    if (parsed === null)
      return yield* error(
        "invalid_reference",
        "Give a Build URL such as https://hq.example/build/1000123, #1000123 or 1000123.",
      );
    if (parsed.origin !== null && parsed.origin !== connection.origin)
      return yield* error(
        "other_hq",
        `That link is on ${parsed.origin}, but this project uses ${connection.origin}.`,
      );
    const read = yield* hq
      .observe(projectId, "hq_build_read", { number: parsed.number })
      .pipe(
        Effect.mapError((cause) =>
          cause.reason === "failed"
            ? error("not_found", `Build has no item #${parsed.number} you can see.`)
            : cause.reason === "not_connected"
              ? error("not_connected", "This thread's project is not connected to YardSmith HQ.")
              : error("unavailable", "YardSmith HQ could not be reached. Try again shortly."),
        ),
      );
    const item = decodeBuildRead(read.value);
    if (Option.isNone(item))
      return yield* error("unavailable", "YardSmith HQ returned an item T3 could not read.");
    if (item.value.kind !== "spec" && item.value.kind !== "ticket")
      return yield* error(
        "unsupported_kind",
        `#${parsed.number} is a Build ${item.value.kind}; link a Spec or a Ticket.`,
      );
    return { itemId: item.value.id, number: item.value.number, origin: read.origin };
  });

  const link: BuildWorkItems["Service"]["link"] = Effect.fn("BuildWorkItems.link")(
    function* (input) {
      const shell = yield* shellOf(input.threadId);
      const workItem =
        input.reference === null ? null : yield* resolve(shell.projectId, input.reference);
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

  return BuildWorkItems.of({
    view,
    link,
    connected: (projectId) =>
      connectionOf(projectId).pipe(
        Effect.map((connection) => ({ connected: connection !== null })),
      ),
  });
});

export const layer = Layer.effect(BuildWorkItems, make);
