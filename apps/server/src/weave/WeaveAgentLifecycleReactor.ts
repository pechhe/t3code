import {
  isOrchestrationV2TaskClosed,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";
import * as WeaveAgentConnections from "./WeaveAgentConnections.ts";
import * as WeaveForgeRecords from "./WeaveForgeRecords.ts";
import * as WeaveForgeRecordingReactor from "./WeaveForgeRecordingReactor.ts";

const FINISHED_RUN_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

/** The child thread of a local delegated task this event closes, if it closes one. */
const closedChildOf = (event: OrchestrationV2DomainEvent): ThreadId | undefined =>
  event.type === "subagent.updated" &&
  event.payload.origin === "app_owned" &&
  event.payload.childThreadId !== null &&
  isOrchestrationV2TaskClosed(event.payload)
    ? event.payload.childThreadId
    : undefined;

/**
 * Ends a thread's Weave agent when its delegated task is over (closed by `task_cancel`, nothing of it
 * running) or the thread is deleted, never when a run or turn finishes: Weave replaces an ended agent
 * with a new id, and Forge lets only the agent that opened a bind or session end it. Archiving keeps
 * it too. Ends are queued so the thread's Forge records reach Weave first.
 */
export class WeaveAgentLifecycleReactor extends Context.Service<
  WeaveAgentLifecycleReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/weave/WeaveAgentLifecycleReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const connections = yield* WeaveAgentConnections.WeaveAgentConnections;
  const records = yield* WeaveForgeRecords.WeaveForgeRecords;
  const recording = yield* WeaveForgeRecordingReactor.WeaveForgeRecordingReactor;

  /** Acts on the thread's agent; a thread with no Weave role never had one. */
  const withAgentOf = <E>(
    threadId: ThreadId,
    act: (
      agent: Omit<WeaveAgentConnections.WeaveAgent, "model">,
      thread: OrchestrationV2AppThread,
    ) => Effect.Effect<void, E>,
  ) =>
    projections.getThread(threadId).pipe(
      Effect.flatMap((thread) => {
        const role = WeaveAgentConnections.weaveAgentRole(thread);
        return role === undefined ? Effect.void : act({ threadId, role }, thread);
      }),
    );

  /**
   * Queues the agent's end once its task is closed and none of its runs is live, whichever of the two
   * comes last. The projection may already show a last run whose own event is still to come, so what
   * that run owes is queued first; queueing it again when its event arrives stores nothing new.
   */
  const endIfTaskOver = Effect.fn("WeaveAgentLifecycleReactor.endIfTaskOver")(function* (
    agent: Omit<WeaveAgentConnections.WeaveAgent, "model">,
    recordedRunId?: string,
  ) {
    // Each follow-up is a task of its own on the same child thread; cancelling any of them closes
    // the conversation, as it refuses further follow-ups.
    const tasks = yield* projections.getSubagentsByChildThread(agent.threadId);
    if (!tasks.some(isOrchestrationV2TaskClosed)) return;
    const { runs } = yield* projections.getThreadRecords(agent.threadId, ["runs"], {
      runStatuses: ThreadManagementService.ACTIVE_RUN_STATUSES,
      includeLatestRun: true,
    });
    if (runs.some(ThreadManagementService.isActiveRun)) return;
    const last = runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
    if (last !== undefined && last.id !== recordedRunId && FINISHED_RUN_STATUSES.has(last.status))
      yield* recording.recordCompletion(agent.threadId, last);
    yield* records.enqueue({ kind: "end", threadId: agent.threadId, role: agent.role });
  });

  const handleNow = Effect.fn("WeaveAgentLifecycleReactor.handle")(
    function* (event: OrchestrationV2DomainEvent) {
      switch (event.type) {
        case "run.updated": {
          const { status, delegatedTaskId } = event.payload;
          if (!FINISHED_RUN_STATUSES.has(status)) return;
          return yield* withAgentOf(event.threadId, (agent, thread) =>
            // Only a follow-up run carries its task's id; a task's first run is told by its parent.
            (delegatedTaskId === undefined && thread.lineage.parentThreadId === null
              ? Effect.void
              : recording.recordCompletion(agent.threadId, event.payload)
            ).pipe(Effect.andThen(endIfTaskOver(agent, event.payload.id))),
          );
        }
        case "subagent.updated": {
          const childThreadId = closedChildOf(event);
          if (childThreadId === undefined) return;
          return yield* withAgentOf(childThreadId, (agent) => endIfTaskOver(agent));
        }
        case "thread.deleted":
          return yield* withAgentOf(event.threadId, (agent) =>
            // Nothing can act as a deleted thread, so what it still owes goes with it, and its
            // agent is ended now rather than on the queue's next pass.
            records.forgetThread(agent.threadId).pipe(Effect.andThen(connections.forget(agent))),
          );
        default:
          return;
      }
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not end a thread's Weave agent", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  /**
   * One thread's events are handled in the order they happened, so an end never overtakes an earlier
   * run's record that is still being queued. Registering an event takes its place at once; the effect
   * it returns waits for the thread's earlier events and then handles it.
   */
  const latest = new Map<ThreadId, Deferred.Deferred<void>>();
  const inOrder = Effect.fnUntraced(function* (event: OrchestrationV2DomainEvent) {
    const threadId =
      event.type === "run.updated" || event.type === "thread.deleted"
        ? event.threadId
        : closedChildOf(event);
    if (threadId === undefined) return undefined;
    const before = latest.get(threadId);
    const done = yield* Deferred.make<void>();
    latest.set(threadId, done);
    return (before === undefined ? Effect.void : Deferred.await(before)).pipe(
      Effect.andThen(handleNow(event)),
      Effect.ensuring(
        Effect.suspend(() => {
          if (latest.get(threadId) === done) latest.delete(threadId);
          return Deferred.succeed(done, undefined);
        }),
      ),
    );
  });

  const handle: WeaveAgentLifecycleReactor["Service"]["handle"] = (event) =>
    inOrder(event).pipe(Effect.flatMap((ordered) => ordered ?? Effect.void));

  const start: WeaveAgentLifecycleReactor["Service"]["start"] = Effect.fn(
    "WeaveAgentLifecycleReactor.start",
  )(function* () {
    // Ending calls Weave, so one slow request must not hold up other threads' events.
    const ends = yield* FiberSet.make<void, never>();
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) =>
        inOrder(event).pipe(
          Effect.flatMap((ordered) =>
            ordered === undefined ? Effect.void : FiberSet.run(ends, ordered),
          ),
        ),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Weave agent lifecycle event stream failed", { cause }),
        ),
      ),
    );
  });

  return { start, handle } satisfies WeaveAgentLifecycleReactor["Service"];
});

export const layer = Layer.effect(WeaveAgentLifecycleReactor, make);
