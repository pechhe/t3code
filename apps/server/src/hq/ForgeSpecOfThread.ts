import { ThreadId } from "@t3tools/contracts";
import type { OrchestrationV2ThreadWorkItem } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as HqAgentConnections from "./HqAgentConnections.ts";

/** The Forge Spec a thread's work counts toward, and the thread that leads it (Spec #4395). */
export interface ForgeSpecOfThreadResult {
  /** The Spec's id in Weave. A thread linked to a Ticket resolves to the Ticket's Spec. */
  readonly specId: string;
  readonly origin: string;
  /** The root thread whose Forge link the work counts under; the thread itself for a lead. */
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
 * Says which Spec, if any, a thread's work is recorded on: the thread's own Forge link, or the
 * link of the nearest ancestor reached through `parentThreadId`, so every `delegate_task` child at
 * any depth counts. A thread with no linked ancestor, or whose link names no Spec, resolves to
 * none: there is nothing to record. A thread that is linked but whose item cannot be read now
 * fails with `BuildSpecUnavailable` instead, which is what tells a caller to queue its record
 * unresolved rather than drop it.
 */
export class ForgeSpecOfThread extends Context.Service<
  ForgeSpecOfThread,
  {
    readonly of: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<ForgeSpecOfThreadResult>, BuildSpecUnavailable>;
  }
>()("t3/hq/ForgeSpecOfThread") {}

/** What `hq_build_read` says about a linked item: only a Ticket names the Spec it belongs to. */
const ForgeItemRead = Schema.Struct({
  kind: Schema.String,
  parentId: Schema.NullOr(Schema.String),
});
const decodeForgeItemRead = Schema.decodeUnknownOption(ForgeItemRead);

const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const hq = yield* HqAgentConnections.HqAgentConnections;
  /** The Spec each item names, by the connection it was read on, so a Ticket is read once. */
  const specByItem = new Map<string, string>();

  /**
   * The Spec a linked item names, or none when it names none. Anything that stops the item being
   * read raises `BuildSpecUnavailable`: an older HQ, an address that has moved or a Weave that is
   * down are all "not yet", never "nothing to record".
   */
  const specOfItem = Effect.fnUntraced(function* (
    threadId: ThreadId,
    item: OrchestrationV2ThreadWorkItem,
  ) {
    const unavailable = () => new BuildSpecUnavailable({ threadId, origin: item.origin });
    const connection = yield* hq.read.pipe(Effect.mapError(unavailable));
    if (connection === null) return yield* Effect.fail(unavailable());
    const cacheKey = `${connection.connection}\n${item.itemId}`;
    const cached = specByItem.get(cacheKey);
    if (cached !== undefined) return Option.some(cached);
    const read = yield* hq
      .observe("hq_build_read", { itemId: item.itemId })
      .pipe(Effect.mapError(unavailable));
    const value = decodeForgeItemRead(read.value);
    // An answer T3 cannot read as an item may read fine when it next asks.
    if (Option.isNone(value)) return yield* Effect.fail(unavailable());
    const specId =
      value.value.kind === "spec"
        ? item.itemId
        : value.value.kind === "ticket"
          ? value.value.parentId
          : null;
    if (specId === null) return Option.none<string>();
    specByItem.set(cacheKey, specId);
    return Option.some(specId);
  });

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
          Effect.map(Option.some),
          Effect.catchTags({
            ProjectionStoreThreadNotFoundError: () => Effect.succeed(Option.none()),
          }),
          Effect.catch(() => Effect.fail(new BuildSpecUnavailable({ threadId, origin: null }))),
        );
        if (Option.isNone(thread)) return Option.none();
        const workItem = thread.value.workItem;
        if (workItem !== undefined && workItem !== null) {
          const specId = yield* specOfItem(threadId, workItem);
          return Option.isNone(specId)
            ? Option.none()
            : Option.some({
                specId: specId.value,
                origin: workItem.origin,
                leadThreadId: holder,
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
