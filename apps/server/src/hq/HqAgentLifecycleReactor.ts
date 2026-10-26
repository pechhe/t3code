import type {
  OrchestrationV2AppThread,
  OrchestrationV2DomainEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as HqAgentConnections from "./HqAgentConnections.ts";
import * as HqForgeRecords from "./HqForgeRecords.ts";
import * as HqForgeRecordingReactor from "./HqForgeRecordingReactor.ts";

/**
 * Ends a thread's HQ agent when its work is over: a delegated task that completed, failed or was
 * cancelled. A deleted thread's agent is dropped. An interrupted run is left alone, since a
 * restart continues it. T3 only ever ends agents; revoking one is the person's call in HQ.
 *
 * The end is queued rather than sent: ending replaces the agent's identity, so every Forge record
 * the thread still owes Weave has to reach it first (Spec #4395). A thread with nothing queued
 * ahead of its end is ended on the queue's next pass, as it was before the queue existed. The
 * records its finished run owes are queued here, in the same fiber, rather than from another
 * reactor, so they are always ahead of the end.
 *
 * Archiving a thread keeps its agent. HQ lets only the agent that opened a Forge bind or session
 * end it, and an ended agent is replaced by one with a new id, so ending it on archive would leave
 * an open session that nothing can end once the thread is unarchived. Whether the thread still
 * links a Forge item at that point says nothing about whether its agent owns a session.
 */
export class HqAgentLifecycleReactor extends Context.Service<
  HqAgentLifecycleReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/hq/HqAgentLifecycleReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const connections = yield* HqAgentConnections.HqAgentConnections;
  const records = yield* HqForgeRecords.HqForgeRecords;
  const recording = yield* HqForgeRecordingReactor.HqForgeRecordingReactor;

  /** Acts on the thread's agent; a thread with no HQ role never had one. */
  const withAgentOf = (
    threadId: ThreadId,
    act: (
      agent: Omit<HqAgentConnections.HqAgent, "model">,
      thread: OrchestrationV2AppThread,
    ) => Effect.Effect<void, HqForgeRecords.HqForgeRecordError>,
  ) =>
    projections.getThread(threadId).pipe(
      Effect.flatMap((thread) => {
        const role = HqAgentConnections.hqAgentRole(thread);
        return role === undefined ? Effect.void : act({ threadId, role }, thread);
      }),
    );

  const handle: HqAgentLifecycleReactor["Service"]["handle"] = Effect.fn(
    "HqAgentLifecycleReactor.handle",
  )(
    function* (event: OrchestrationV2DomainEvent) {
      switch (event.type) {
        case "run.updated": {
          const { status, delegatedTaskId } = event.payload;
          if (status !== "completed" && status !== "failed" && status !== "cancelled") return;
          return yield* withAgentOf(event.threadId, (agent, thread) =>
            // Only a follow-up run carries its task's id; a task's first run is told by its parent.
            delegatedTaskId === undefined && thread.lineage.parentThreadId === null
              ? Effect.void
              : recording.recordCompletion(agent.threadId, event.payload).pipe(
                  Effect.andThen(
                    records.enqueue({
                      kind: "end",
                      // One end per run: a follow-up run gets a fresh agent, which needs its own end.
                      recordKey: `end:${agent.threadId}:${event.payload.id}`,
                      threadId: agent.threadId,
                      role: agent.role,
                    }),
                  ),
                ),
          );
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
          Effect.logWarning("Could not end a thread's HQ agent", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  const start: HqAgentLifecycleReactor["Service"]["start"] = Effect.fn(
    "HqAgentLifecycleReactor.start",
  )(function* () {
    // Ending calls HQ, so one slow request must not hold up the events behind it.
    const ends = yield* FiberSet.make<void, never>();
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, (event) =>
        event.type === "run.updated" || event.type === "thread.deleted"
          ? FiberSet.run(ends, handle(event)).pipe(Effect.asVoid)
          : Effect.void,
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("HQ agent lifecycle event stream failed", { cause }),
        ),
      ),
    );
  });

  return { start, handle } satisfies HqAgentLifecycleReactor["Service"];
});

export const layer = Layer.effect(HqAgentLifecycleReactor, make);
