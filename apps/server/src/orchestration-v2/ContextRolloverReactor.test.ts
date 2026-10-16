import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as ExperimentService from "../experiments/ExperimentService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ContextRolloverNotes } from "./ContextRollover.ts";
import * as ContextRolloverReactor from "./ContextRolloverReactor.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

it.effect("releases the completed source result when its last queued turn is cancelled", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make("cancel-held-rollover");
      const source = {
        id: RunId.make("source"),
        threadId,
        status: "completed",
      } as OrchestrationV2Run;
      const queued = {
        id: RunId.make("queued"),
        threadId,
        status: "queued",
      } as OrchestrationV2Run;
      const runs = yield* Ref.make([source, queued]);
      const sourceRead = yield* Deferred.make<void>();
      const recovered = yield* Deferred.make<{ threadId: ThreadId; runId: RunId }>();
      const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
      const dispatches = yield* Ref.make(0);
      const dependencies = Layer.mergeAll(
        NodeCrypto.layer,
        Layer.mock(Orchestrator.OrchestratorV2)({
          streamDomainEvents: Stream.fromQueue(events),
          dispatch: () =>
            Ref.update(dispatches, (count) => count + 1).pipe(
              Effect.andThen(Effect.die("Unexpected continuation")),
            ),
          recoverDelegatedTask: (threadId, runId) =>
            Deferred.succeed(recovered, { threadId, runId }).pipe(Effect.asVoid),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: () =>
            Ref.get(runs).pipe(
              Effect.tap(() => Deferred.succeed(sourceRead, undefined)),
              Effect.map((runs) => ({ runs }) as never),
            ),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({}),
        Layer.mock(ExperimentService.ExperimentService)({}),
      );
      yield* Effect.gen(function* () {
        const notes = yield* ContextRolloverNotes;
        const reactor = yield* ContextRolloverReactor.ContextRolloverReactor;
        notes.save(threadId, { runId: source.id, note: "Continue existing work" });
        yield* reactor.start();
        const event = (run: OrchestrationV2Run) =>
          ({ type: "run.updated", threadId, payload: run }) as OrchestrationV2DomainEvent;
        yield* Queue.offer(events, event(source));
        yield* Deferred.await(sourceRead);
        yield* reactor.drain;
        assert.isTrue(notes.holdsResult(source));
        const cancelled = { ...queued, status: "cancelled" as const };
        yield* Ref.set(runs, [source, cancelled]);
        yield* Queue.offer(events, event(cancelled));
        assert.deepEqual(yield* Deferred.await(recovered), { threadId, runId: source.id });
        yield* reactor.drain;
        assert.isUndefined(notes.get(threadId));
        assert.isFalse(notes.holdsResult(source));
        assert.equal(yield* Ref.get(dispatches), 0);
      }).pipe(Effect.provide(ContextRolloverReactor.layer.pipe(Layer.provide(dependencies))));
    }),
  ),
);
