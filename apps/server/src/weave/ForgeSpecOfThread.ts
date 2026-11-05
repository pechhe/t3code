import { ThreadId } from "@t3tools/contracts";
import type { OrchestrationV2AppThread } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as WeaveAgentConnections from "./WeaveAgentConnections.ts";

/** The Forge Spec a thread's work counts toward, and the thread that leads it. */
export interface ForgeSpecOfThreadResult {
  /** The Spec's id in Weave. A thread linked to a Ticket resolves to the Ticket's Spec. */
  readonly specId: string;
  /** The Spec's repository, which a session names a workspace by when its thread's project has none. */
  readonly project: string | null;
  readonly origin: string;
  /** The root thread that leads the work and opens its session; the thread itself for a lead. */
  readonly leadThreadId: ThreadId;
}

/**
 * A thread that links a Forge item which cannot be read now: Weave is unreachable, or its answer
 * cannot be understood. Such a thread's work is still owed, so a caller keeps its record and lets
 * the delivery pass resolve the Spec later, rather than losing it. The linked item's own Weave is
 * known without reading it, so a record queued now still belongs to the Weave it was made for.
 */
export class BuildSpecUnavailable extends Schema.TaggedError<BuildSpecUnavailable>()(
  "BuildSpecUnavailable",
  {
    threadId: ThreadId,
    /** The Weave the nearest linked item belongs to, when the thread that holds it could be read. */
    origin: Schema.NullOr(Schema.String),
  },
) {
  override get message(): string {
    return `T3 could not read the Forge item thread ${this.threadId} counts toward.`;
  }
}

/**
 * Resolve the Spec from the thread's Forge link, then workspace attachment, then nearest ancestor.
 * No Spec link resolves to none; an unreadable linked item fails with BuildSpecUnavailable
 * so the caller queues unresolved usage rather than dropping it.
 */
export class ForgeSpecOfThread extends Context.Service<
  ForgeSpecOfThread,
  {
    readonly of: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<ForgeSpecOfThreadResult>, BuildSpecUnavailable>;
  }
>()("t3/weave/ForgeSpecOfThread") {}

/** What `weave_forge_read` says about a linked item: only a Ticket names the Spec it belongs to. */
const ForgeItemRead = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  project: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeForgeItemRead = Schema.decodeUnknownOption(ForgeItemRead);

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const weave = yield* WeaveAgentConnections.WeaveAgentConnections;
  /** The Spec each item names, by the connection it was read on, so a Ticket is read once. */
  const specByItem = new Map<
    string,
    { readonly specId: string; readonly project: string | null }
  >();

  /**
   * The Spec a linked item names, or none when it names none. Anything that stops the item being
   * read raises `BuildSpecUnavailable`: an older Weave, an address that has moved or a Weave that is
   * down are all "not yet", never "nothing to record". A link read by its number has no origin of
   * its own, so it belongs to the Weave T3 is connected to.
   */
  const specOfItem = Effect.fnUntraced(function* (
    threadId: ThreadId,
    item: { readonly number: number; readonly itemId?: string; readonly origin: string | null },
  ) {
    const unavailable = () => new BuildSpecUnavailable({ threadId, origin: item.origin });
    const connection = yield* weave.read.pipe(Effect.mapError(unavailable));
    if (connection === null) return yield* unavailable();
    const origin = item.origin ?? connection.origin;
    const cacheKey = `${connection.connection}\n${item.itemId ?? `#${item.number}`}`;
    const cached = specByItem.get(cacheKey);
    if (cached !== undefined) return Option.some({ ...cached, origin });
    const read = yield* weave
      .observe(
        "weave_forge_read",
        item.itemId === undefined ? { number: item.number } : { itemId: item.itemId },
      )
      .pipe(Effect.mapError(unavailable));
    const value = decodeForgeItemRead(read.value);
    // An answer T3 cannot read as an item may read fine when it next asks.
    if (Option.isNone(value)) return yield* unavailable();
    const specId =
      value.value.kind === "spec"
        ? value.value.id
        : value.value.kind === "ticket"
          ? value.value.parentId
          : null;
    if (specId === null) return Option.none();
    const spec = { specId, project: value.value.project ?? null };
    specByItem.set(cacheKey, spec);
    return Option.some({ ...spec, origin });
  });

  /** The item a thread names: its Forge link, else the item its workspace was attached to. */
  const linkedItemOf = (thread: OrchestrationV2AppThread) =>
    thread.workItem ??
    (thread.workspaceIssue == null ? undefined : { number: thread.workspaceIssue, origin: null });

  const of: ForgeSpecOfThread["Service"]["of"] = Effect.fn("ForgeSpecOfThread.of")(
    function* (threadId) {
      // A child counts under its lead's link, so the walk starts at the thread itself and climbs.
      const visited = new Set<ThreadId>();
      let next: ThreadId | null = threadId;
      while (next !== null && !visited.has(next)) {
        visited.add(next);
        const holder: ThreadId = next;
        // A thread the projection no longer has records nothing: nothing can act as it again. Any
        // other read failure is "not yet", which keeps the caller's record instead of dropping it.
        const thread = yield* projections.getThread(holder).pipe(
          Effect.asSome,
          Effect.catchTags({
            ProjectionStoreThreadNotFoundError: () => Effect.succeedNone,
          }),
          Effect.mapError(() => new BuildSpecUnavailable({ threadId, origin: null })),
        );
        if (Option.isNone(thread)) return Option.none();
        const item = linkedItemOf(thread.value);
        if (item !== undefined) {
          const spec = yield* specOfItem(threadId, item);
          return Option.isNone(spec)
            ? Option.none()
            : // A child can carry a copy of its lead's link, but only the root thread opens the
              // session its work counts toward.
              Option.some({
                ...spec.value,
                leadThreadId: thread.value.lineage.rootThreadId ?? holder,
              });
        }
        next = thread.value.lineage.parentThreadId;
      }
      return Option.none();
    },
  );

  return { of } satisfies ForgeSpecOfThread["Service"];
});

export const layer = Layer.effect(ForgeSpecOfThread, make);
