import {
  CommandId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadWatch,
  ThreadId,
} from "@t3tools/contracts";
import { turnItemUpdateCanEndBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { decideThreadWatch, watchedThreadRecords } from "./threadWatch.ts";

/**
 * Events catch nearly every change; the sweep catches one an event filter missed, and watches
 * whose thread finished while the server was down.
 */
const SWEEP_MINUTES = 5;

interface Watching {
  readonly watcherId: ThreadId;
  readonly watch: OrchestrationV2ThreadWatch;
}

function threadPayloadOf(event: OrchestrationV2DomainEvent): OrchestrationV2AppThread | undefined {
  switch (event.type) {
    case "thread.created":
    case "thread.archived":
    case "thread.unarchived":
    case "thread.deleted":
    case "thread.settled":
    case "thread.unsettled":
    case "thread.snoozed":
    case "thread.unsnoozed":
    case "thread.pinned":
    case "thread.auto-settle-set":
    case "thread.rollover-hold-set":
    case "thread.rollover-thresholds-set":
    case "thread.compact-at-set":
    case "thread.unpinned":
    case "thread.pin-reordered":
    case "thread.active-reordered":
    case "thread.visited":
    case "thread.marked-unread":
    case "thread.metadata-updated":
    case "thread.pull-request-synced":
    case "thread.runtime-mode-updated":
    case "thread.interaction-mode-updated":
    case "thread.model-selection-updated":
    case "thread.provider-switched":
      return event.payload;
    default:
      return undefined;
  }
}

/** Whether the event can change a watched thread's outcome. Streaming output cannot. */
function canSettleWatchedThread(event: OrchestrationV2DomainEvent): boolean {
  switch (event.type) {
    case "turn-item.updated":
      return turnItemUpdateCanEndBackgroundWork(event.payload);
    case "run.created":
    case "run.updated":
    case "run.background-work-cancelled":
    case "runtime-request.updated":
    case "subagent.updated":
    case "provider-thread.updated":
    case "thread.archived":
    case "thread.deleted":
    case "thread.pull-request-synced":
    case "thread.pull-request-link-updated":
      return true;
    default:
      return false;
  }
}

export class ThreadWatchReactor extends Context.Service<
  ThreadWatchReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ThreadWatchReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const serial = yield* Semaphore.make(1);
  /** Watched thread id to the watches on it. Rebuilt from each watcher's own thread events. */
  const byWatched = new Map<ThreadId, ReadonlyArray<Watching>>();

  const index = (watcher: OrchestrationV2AppThread) => {
    for (const [watchedId, entries] of byWatched) {
      const kept = entries.filter((entry) => entry.watcherId !== watcher.id);
      if (kept.length === 0) byWatched.delete(watchedId);
      else if (kept.length !== entries.length) byWatched.set(watchedId, kept);
    }
    if (watcher.deletedAt !== null) return;
    for (const watch of watcher.threadWatches ?? []) {
      if (watch.target.kind !== "thread") continue;
      byWatched.set(watch.target.threadId, [
        ...(byWatched.get(watch.target.threadId) ?? []),
        { watcherId: watcher.id, watch },
      ]);
    }
  };

  // A cheap read of stored state picks the moment; the orchestrator decides again under the
  // watcher's lock, with the restart-continuation hold only it can see.
  // Untraced: it runs once per watch on every domain event, so a span per check would swamp traces.
  const evaluate = Effect.fnUntraced(
    function* ({ watcherId, watch }: Watching) {
      if (watch.target.kind !== "thread") return;
      const watched = yield* projections.getThreadRecords(
        watch.target.threadId,
        watchedThreadRecords.fields,
        watchedThreadRecords.filter,
      );
      if (decideThreadWatch(watched) === undefined) return;
      const uuid = yield* crypto.randomUUIDv4();
      yield* engine.dispatch({
        type: "thread.thread-watch.fire",
        commandId: CommandId.make(`server:thread-watch-fire:${watcherId}:${uuid}`),
        threadId: watcherId,
        watchId: watch.id,
      });
    },
    (effect, { watcherId, watch }) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logDebug("thread watch check failed", {
            watcherId,
            target: watch.target,
            cause,
          }),
        ),
      ),
  );

  const handle: ThreadWatchReactor["Service"]["handle"] = (event) =>
    serial.withPermits(1)(
      Effect.gen(function* () {
        const thread = threadPayloadOf(event);
        if (thread !== undefined) {
          index(thread);
          // A new watch on a thread that already finished fires at once.
          if (event.type === "thread.metadata-updated") {
            yield* Effect.forEach(
              thread.threadWatches ?? [],
              (watch) => evaluate({ watcherId: thread.id, watch }),
              { discard: true },
            );
          }
        }
        const watching = byWatched.get(event.threadId);
        if (watching === undefined || !canSettleWatchedThread(event)) return;
        yield* Effect.forEach(watching, evaluate, { discard: true });
      }),
    );

  const sweep = serial.withPermits(1)(
    Effect.gen(function* () {
      const rows = yield* sql<{ thread_id: string }>`
        SELECT thread_id FROM orchestration_v2_projection_threads
        WHERE deleted_at IS NULL
          AND json_array_length(payload_json, '$.threadWatches') > 0`;
      byWatched.clear();
      for (const row of rows) index(yield* projections.getThread(ThreadId.make(row.thread_id)));
      yield* Effect.forEach([...byWatched.values()].flat(), evaluate, { discard: true });
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("thread watch sweep failed", { cause })),
    ),
  );

  const start: ThreadWatchReactor["Service"]["start"] = Effect.fn("ThreadWatchReactor.start")(
    function* () {
      yield* forkParked(
        Stream.runForEach(engine.streamDomainEvents, handle).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("thread watch event stream failed", { cause }),
          ),
        ),
      );
      yield* forkParked(
        sweep.pipe(Effect.repeat(Schedule.spaced(`${SWEEP_MINUTES} minutes`)), Effect.asVoid),
      );
    },
  );

  return { start, handle, sweep } satisfies ThreadWatchReactor["Service"];
});

export const layer = Layer.effect(ThreadWatchReactor, make);
