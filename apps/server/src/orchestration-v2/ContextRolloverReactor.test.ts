import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  RunId,
  RunAttemptId,
  ProviderInstanceId,
  ProviderThreadId,
  DEFAULT_SERVER_SETTINGS,
  ThreadId,
  type Experiment,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as ExperimentService from "../experiments/ExperimentService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ContextRolloverReactor from "./ContextRolloverReactor.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const usageHarness = Effect.gen(function* () {
  const threadId = ThreadId.make("usage-cache");
  let run = {
    id: RunId.make("run:1"),
    activeAttemptId: RunAttemptId.make("attempt:1"),
    status: "running",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  } as OrchestrationV2Run;
  let thread = {
    id: threadId,
    createdAt: DateTime.makeUnsafe("2026-10-18T00:00:00Z"),
    creationSource: "web",
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    rolloverThresholds: null,
    rolloverHold: null,
  } as OrchestrationV2AppThread;
  let settings = {
    ...DEFAULT_SERVER_SETTINGS,
    contextRollover: {
      ...DEFAULT_SERVER_SETTINGS.contextRollover,
      enabled: true,
      softThreshold: 1_000,
      hardThreshold: 2_000,
      modelRules: [],
    },
  };
  let experiments: ReadonlyArray<Experiment> = [];
  const counts = { runsLoads: 0, enrollments: 0, dispatches: 0 };
  const events = yield* Queue.unbounded<{
    event: OrchestrationV2DomainEvent;
    consumed: Deferred.Deferred<void>;
  }>();
  const dependencies = Layer.mergeAll(
    NodeCrypto.layer,
    Layer.mock(Orchestrator.OrchestratorV2)({
      streamDomainEvents: Stream.fromQueue(events).pipe(
        Stream.flatMap(({ event, consumed }) =>
          Stream.make(event).pipe(
            Stream.concat(Stream.fromEffectDrain(Deferred.succeed(consumed, undefined))),
          ),
        ),
      ),
      dispatch: () =>
        Effect.sync(() => {
          counts.dispatches++;
        }).pipe(Effect.as({} as never)),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThread: () => Effect.sync(() => thread),
      getThreadRecords: () =>
        Effect.sync(() => {
          counts.runsLoads++;
          return { runs: [run] } as never;
        }),
    }),
    Layer.mock(ServerSettings.ServerSettingsService)({ getSettings: Effect.sync(() => settings) }),
    Layer.mock(ExperimentService.ExperimentService)({
      list: () => Effect.sync(() => experiments),
      getRolloverAssignment: () => Effect.succeed(null),
      assignForThread: () =>
        Effect.sync(() => {
          counts.enrollments++;
          return [];
        }),
    }),
  );
  const context = yield* Layer.build(
    ContextRolloverReactor.layer.pipe(Layer.provide(dependencies)),
  );
  const reactor = yield* ContextRolloverReactor.ContextRolloverReactor.pipe(
    Effect.provide(context),
  );
  yield* reactor.start();
  const send = Effect.fnUntraced(function* (event: OrchestrationV2DomainEvent) {
    const consumed = yield* Deferred.make<void>();
    yield* Queue.offer(events, { event, consumed });
    // The source acknowledges only after the reactor has enqueued the event.
    yield* Deferred.await(consumed);
    yield* reactor.drain;
  });
  let report = 0;
  const usage = (usedTokens = 100, attemptId = run.activeAttemptId!, provider = "session:1") =>
    send({
      type: "provider-turn.updated",
      threadId,
      payload: {
        id: "turn:1",
        runAttemptId: attemptId,
        providerThreadId: ProviderThreadId.make(provider),
        status: "running",
        tokenUsage: {
          usedTokens,
          updatedAt: DateTime.formatIso(DateTime.makeUnsafe(1_700_000_000_000 + report++)),
        },
      },
    } as OrchestrationV2DomainEvent);
  const runUpdated = () =>
    send({ type: "run.updated", threadId, payload: run } as OrchestrationV2DomainEvent);
  return {
    counts,
    usage,
    runUpdated,
    changeAttempt: () => {
      run = { ...run, activeAttemptId: RunAttemptId.make("attempt:2") };
    },
    changeStatus: (status: OrchestrationV2Run["status"]) => {
      run = { ...run, status };
    },
    changeSettings: () => {
      settings = {
        ...settings,
        contextRollover: { ...settings.contextRollover, softThreshold: 500 },
      };
    },
    changeExperiments: () => {
      experiments = [{ id: "experiment:1", status: "running" } as Experiment];
    },
    changeThresholds: Effect.fnUntraced(function* (
      thresholds: { soft: number; hard: number } | null,
    ) {
      thread = { ...thread, rolloverThresholds: thresholds };
      yield* send({
        type: "thread.rollover-thresholds-set",
        threadId,
        payload: thread,
      } as OrchestrationV2DomainEvent);
    }),
  };
});

it.effect(
  "loads runs and attempts enrollment only once for repeated usage of an unchanged attempt",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* usageHarness;
        for (let i = 0; i < 30; i++) yield* h.usage();
        assert.equal(h.counts.runsLoads, 1);
        assert.equal(h.counts.enrollments, 1);
        assert.equal(h.counts.dispatches, 0);
        h.changeSettings();
        yield* h.usage(600);
        assert.equal(h.counts.enrollments, 2);
        assert.equal(h.counts.dispatches, 1);
        h.changeExperiments();
        yield* h.usage();
        assert.equal(h.counts.enrollments, 3);
        yield* h.changeThresholds({ soft: 50, hard: 2_000 });
        yield* h.usage();
        assert.equal(h.counts.dispatches, 2);
        yield* h.changeThresholds(null);
        yield* h.usage();
        assert.equal(h.counts.enrollments, 4);
      }),
    ),
);

it.effect(
  "invalidates runs for lifecycle changes and rejects a superseded attempt before session reset",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* usageHarness;
        yield* h.usage(1_100);
        assert.equal(h.counts.dispatches, 1);
        h.changeAttempt();
        yield* h.runUpdated();
        yield* h.usage(1_100);
        assert.equal(h.counts.runsLoads, 2);
        assert.equal(h.counts.enrollments, 2);
        yield* h.usage(100, RunAttemptId.make("attempt:1"), "obsolete-session");
        yield* h.usage(1_200);
        assert.equal(h.counts.dispatches, 1);
        yield* h.usage(1_200, undefined, "session:2");
        assert.equal(h.counts.dispatches, 2);
        h.changeStatus("interrupted");
        yield* h.runUpdated();
        yield* h.usage(2_100);
        assert.equal(h.counts.dispatches, 2);
        h.changeStatus("waiting");
        yield* h.runUpdated();
        yield* h.usage(2_100);
        assert.equal(h.counts.dispatches, 3);
      }),
    ),
);
