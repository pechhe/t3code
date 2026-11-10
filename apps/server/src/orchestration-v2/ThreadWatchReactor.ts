import {
  CommandId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  ThreadId,
} from "@t3tools/contracts";
import { turnItemUpdateCanEndBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { parkedWaitDueAt, threadsWithWaits } from "./parkedWait.ts";
import { decideThreadWatch, watchedThreadRecords } from "./threadWatch.ts";

/**
 * Events catch nearly every change; the sweep catches one an event filter missed, and watches
 * whose thread finished while the server was down.
 */
const SWEEP_MINUTES = 5;

/** A held watch or parked wait on another thread. */
interface Watching {
  readonly watcherId: ThreadId;
  readonly watchId: string;
  readonly watchedThreadId: ThreadId;
}

/** When a parked wait must wake on its own: at its time, or when it gives up. */
interface Deadline {
  readonly threadId: ThreadId;
  readonly watchId: string;
  readonly dueAt: number;
}

function threadTargetsOf(watcher: OrchestrationV2AppThread): ReadonlyArray<Watching> {
  return [...(watcher.threadWatches ?? []), ...(watcher.parkedWaits ?? [])].flatMap((watch) =>
    watch.target.kind === "thread"
      ? [{ watcherId: watcher.id, watchId: watch.id, watchedThreadId: watch.target.threadId }]
      : [],
  );
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
  const crypto = yield* SecureRandom.SecureRandom;
  const serial = yield* Semaphore.make(1);
  /** Watched thread id to the watches on it. Rebuilt from each watcher's own thread events. */
  const byWatched = new Map<ThreadId, ReadonlyArray<Watching>>();
  /** Keyed by thread and wait id. Rebuilt the same way, and on startup by the first sweep. */
  const deadlines = new Map<string, Deadline>();
  const timer = yield* FiberHandle.make();

  const index = (watcher: OrchestrationV2AppThread) => {
    for (const [watchedId, entries] of byWatched) {
      const kept = entries.filter((entry) => entry.watcherId !== watcher.id);
      if (kept.length === 0) byWatched.delete(watchedId);
      else if (kept.length !== entries.length) byWatched.set(watchedId, kept);
    }
    let changed = false;
    for (const [key, deadline] of deadlines) {
      if (deadline.threadId !== watcher.id) continue;
      deadlines.delete(key);
      changed = true;
    }
    if (watcher.deletedAt !== null) return changed;
    for (const entry of threadTargetsOf(watcher)) {
      byWatched.set(entry.watchedThreadId, [
        ...(byWatched.get(entry.watchedThreadId) ?? []),
        entry,
      ]);
    }
    for (const wait of watcher.parkedWaits ?? []) {
      const dueAt = parkedWaitDueAt(wait);
      if (dueAt === undefined || Number.isNaN(dueAt)) continue;
      deadlines.set(`${watcher.id}\u0000${wait.id}`, {
        threadId: watcher.id,
        watchId: wait.id,
        dueAt,
      });
      changed = true;
    }
    return changed;
  };

  // The orchestrator decides from its own clock whether the time has come; firing early is a no-op.
  // A fired deadline leaves the map, so one that changes nothing waits for the next event or sweep.
  const fireDue = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const due = [...deadlines].filter(([, deadline]) => deadline.dueAt <= now);
    for (const [key] of due) deadlines.delete(key);
    yield* Effect.forEach(
      due,
      ([, deadline]) =>
        Effect.gen(function* () {
          const uuid = yield* crypto.uuidV4();
          yield* engine.dispatch({
            type: "thread.thread-watch.fire",
            commandId: CommandId.make(`server:parked-wait-due:${deadline.threadId}:${uuid}`),
            threadId: deadline.threadId,
            watchId: deadline.watchId,
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logDebug("parked wait deadline check failed", { ...deadline, cause }),
          ),
        ),
      { discard: true },
    ).pipe(Effect.uninterruptible);
  });

  const timerLoop = Effect.gen(function* () {
    while (deadlines.size > 0) {
      const next = Math.min(...[...deadlines.values()].map((deadline) => deadline.dueAt));
      const wait = next - (yield* Clock.currentTimeMillis);
      if (wait > 0) yield* Effect.sleep(`${wait} millis`);
      yield* fireDue;
    }
  });

  /** One timer for every parked deadline, restarted whenever the earliest may have moved. */
  const rearm = FiberHandle.run(timer, timerLoop).pipe(Effect.asVoid);

  // A cheap read of stored state picks the moment; the orchestrator decides again under the
  // watcher's lock, with the restart-continuation hold only it can see.
  // Untraced: it runs once per watch on every domain event, so a span per check would swamp traces.
  const evaluate = Effect.fnUntraced(
    function* ({ watcherId, watchId, watchedThreadId }: Watching) {
      const watched = yield* projections
        .getThreadRecords(watchedThreadId, watchedThreadRecords.fields, watchedThreadRecords.filter)
        .pipe(Effect.option);
      // The orchestrator confirms the row is gone before it ends the watch.
      if (
        Option.isSome(watched) &&
        decideThreadWatch(watched.value, yield* DateTime.now) === undefined
      )
        return;
      const uuid = yield* crypto.uuidV4();
      yield* engine.dispatch({
        type: "thread.thread-watch.fire",
        commandId: CommandId.make(`server:thread-watch-fire:${watcherId}:${uuid}`),
        threadId: watcherId,
        watchId,
      });
    },
    (effect, { watcherId, watchedThreadId }) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logDebug("thread watch check failed", {
            watcherId,
            watchedThreadId,
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
          if (index(thread)) yield* rearm;
          // A new watch on a thread that already finished fires at once.
          if (event.type === "thread.metadata-updated") {
            yield* Effect.forEach(threadTargetsOf(thread), evaluate, { discard: true });
          }
        }
        const watching = byWatched.get(event.threadId);
        if (watching === undefined || !canSettleWatchedThread(event)) return;
        yield* Effect.forEach(watching, evaluate, { discard: true });
      }),
    );

  const sweep = serial.withPermits(1)(
    Effect.gen(function* () {
      const rows = yield* threadsWithWaits(sql);
      byWatched.clear();
      deadlines.clear();
      for (const row of rows) index(yield* projections.getThread(ThreadId.make(row.thread_id)));
      yield* rearm;
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
