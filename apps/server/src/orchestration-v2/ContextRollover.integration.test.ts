import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type ExperimentAssignment,
  type ExperimentObservationInput,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RolloverHold,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as ExperimentService from "../experiments/ExperimentService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { ROLLOVER_MIN_GROWTH_TOKENS, ROLLOVER_NUDGE_COMMAND_PREFIX } from "./ContextRollover.ts";
import * as ContextRolloverReactor from "./ContextRolloverReactor.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const driver = ProviderDriverKind.make("codex");
const providerInstanceId = ProviderInstanceId.make("codex-rollover-test");
const selection = {
  instanceId: providerInstanceId,
  model: "rollover-model",
} satisfies ModelSelection;

interface Captured {
  readonly ensured: ReadonlyArray<{ readonly existing: ProviderThreadId | null }>;
  readonly started: ReadonlyArray<ProviderAdapter.ProviderAdapterV2TurnInput>;
  readonly steered: ReadonlyArray<ProviderAdapter.ProviderAdapterV2SteerInput>;
}

const emptyCaptured: Captured = { ensured: [], started: [], steered: [] };

interface HeldControl {
  /** Reports another usage figure from the running turn. */
  readonly reportUsage: (usedTokens: number, updatedAt?: string) => Effect.Effect<void>;
  readonly reportCompaction: (
    id: string,
    counts?: { beforeTokenCount: number; afterTokenCount: number },
  ) => Effect.Effect<void>;
  /** Completes the turn. */
  readonly complete: Effect.Effect<void>;
}

interface HeldTurn {
  /** The held turn's first usage report, in context tokens. */
  readonly usedTokens: number;
  readonly maxTokens?: number;
  /** Hold every turn, not only the first. */
  readonly holdEveryTurn?: boolean;
  /** Whether held turns after the first report their usage when they start (default true). */
  readonly laterTurnsReportUsage?: boolean;
  /** Receives the controls of each held turn once it is running. */
  readonly running: Queue.Queue<HeldControl>;
  /** Receives each steer into a held turn. */
  readonly steered: Queue.Queue<ProviderAdapter.ProviderAdapterV2SteerInput>;
}

/**
 * Completes every turn at once; each `ensureThread` mints a new native thread on
 * the row it is given. With `held`, the first turn (or every turn) instead
 * reports its usage and keeps running until the test completes it.
 */
function makeAdapter(
  captured: Ref.Ref<Captured>,
  held?: HeldTurn,
): ProviderAdapter.ProviderAdapterV2["Service"] {
  return {
    instanceId: providerInstanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        return {
          instanceId: providerInstanceId,
          driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession: {
            id: sessionInput.providerSessionId,
            driver,
            providerInstanceId,
            status: "ready",
            cwd: sessionInput.runtimePolicy.cwd ?? "/fallback",
            model: sessionInput.modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const count = yield* Ref.modify(captured, (current) => [
                current.ensured.length + 1,
                {
                  ...current,
                  ensured: [
                    ...current.ensured,
                    { existing: threadInput.existingProviderThread?.id ?? null },
                  ],
                },
              ]);
              const createdAt = yield* DateTime.now;
              const nativeThreadRef = {
                driver,
                nativeId: `native-thread:${threadInput.threadId}:${count}`,
                strength: "strong" as const,
              };
              const existing = threadInput.existingProviderThread;
              if (existing !== undefined) {
                return { ...existing, nativeThreadRef, status: "idle", updatedAt: createdAt };
              }
              return {
                id: ProviderThreadId.make(`provider-thread:${threadInput.threadId}`),
                driver,
                providerInstanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef,
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (input) =>
            Effect.gen(function* () {
              const turnCount = yield* Ref.modify(captured, (current) => [
                current.started.length + 1,
                { ...current, started: [...current.started, input] },
              ]);
              const startedAt = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(`provider-turn:${input.attemptId}`);
              const providerTurn = {
                id: providerTurnId,
                providerThreadId: input.providerThread.id,
                nodeId: input.rootNodeId,
                runAttemptId: input.attemptId,
                nativeTurnRef: {
                  driver,
                  nativeId: `native:${providerTurnId}`,
                  strength: "strong" as const,
                },
                ordinal: input.providerTurnOrdinal,
                startedAt,
              };
              const complete = Effect.gen(function* () {
                yield* Queue.offer(events, {
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: {
                    ...providerTurn,
                    status: "completed",
                    completedAt: yield* DateTime.now,
                  },
                });
                yield* Queue.offer(events, {
                  type: "turn.terminal",
                  driver,
                  providerThreadId: input.providerThread.id,
                  providerTurnId,
                  runOrdinal: input.runOrdinal,
                  status: "completed",
                  failure: null,
                  threadDisposition: "reusable",
                });
              }).pipe(Effect.asVoid);
              if (held === undefined || (turnCount > 1 && held.holdEveryTurn !== true)) {
                return yield* complete;
              }
              const reportUsage = (usedTokens: number, updatedAt?: string) =>
                Effect.gen(function* () {
                  yield* Queue.offer(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: {
                      ...providerTurn,
                      status: "running",
                      completedAt: null,
                      tokenUsage: {
                        usedTokens,
                        ...(held.maxTokens === undefined ? {} : { maxTokens: held.maxTokens }),
                        updatedAt: updatedAt ?? DateTime.formatIso(yield* DateTime.now),
                      },
                    },
                  });
                }).pipe(Effect.asVoid);
              const reportCompaction: HeldControl["reportCompaction"] = (id, counts) =>
                Effect.gen(function* () {
                  const at = yield* DateTime.now;
                  yield* Queue.offer(events, {
                    type: "turn_item.updated",
                    driver,
                    turnItem: {
                      id: TurnItemId.make(id),
                      threadId: input.threadId,
                      runId: input.runId,
                      nodeId: input.rootNodeId,
                      providerThreadId: input.providerThread.id,
                      providerTurnId,
                      nativeItemRef: null,
                      parentItemId: null,
                      ordinal: 100,
                      status: "completed",
                      title: null,
                      startedAt: at,
                      completedAt: at,
                      updatedAt: at,
                      type: "compaction",
                      driver,
                      ...counts,
                    },
                  });
                }).pipe(Effect.asVoid);
              // Like the real adapters, a turn is announced as running before any usage.
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: { ...providerTurn, status: "running", completedAt: null },
              });
              if (turnCount === 1 || held.laterTurnsReportUsage !== false) {
                yield* reportUsage(held.usedTokens);
              }
              yield* Queue.offer(held.running, { reportUsage, reportCompaction, complete });
            }),
          steerTurn: (input) =>
            Effect.gen(function* () {
              yield* Ref.update(captured, (current) => ({
                ...current,
                steered: [...current.steered, input],
              }));
              if (held !== undefined) yield* Queue.offer(held.steered, input);
            }),
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
          rollbackThread: () => Effect.die("unused rollbackThread"),
          forkThread: () => Effect.die("unused forkThread"),
        };
      }),
  };
}

const runHeldTurnScenario = (
  name: string,
  options: {
    readonly assignment?: ExperimentAssignment;
    readonly duringFirst?: (control: HeldControl) => Effect.Effect<void>;
    readonly rolloverEnabled?: boolean;
    readonly queueMessage?: boolean;
    readonly usedTokens?: number;
    readonly maxTokens?: number;
    readonly hold?: OrchestrationV2RolloverHold;
    /** The thread's own thresholds, as set by dragging its composer's context band. */
    readonly thresholds?: { readonly soft: number; readonly hard: number };
    readonly nudged?: boolean;
    readonly laterTurnsReportUsage?: boolean;
    /** Holds the queued run's turn too and runs this against it before completing it. */
    readonly duringSecond?: (
      control: HeldControl,
      steered: Queue.Queue<ProviderAdapter.ProviderAdapterV2SteerInput>,
    ) => Effect.Effect<void>;
    /** Runs against the orchestrator once the first run has completed. */
    readonly afterFirstRun?: (
      runId: OrchestrationV2Run["id"],
    ) => Effect.Effect<void, never, Orchestrator.OrchestratorV2>;
  } = {},
) =>
  Effect.gen(function* () {
    const cwd = yield* checkpointWorkspace(name);
    const threadId = ThreadId.make(`thread:${name}`);
    const captured = yield* Ref.make<Captured>(emptyCaptured);
    const observations: ExperimentObservationInput[] = [];
    const held: HeldTurn = {
      usedTokens: options.usedTokens ?? 1_500,
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      holdEveryTurn: options.duringSecond !== undefined,
      ...(options.laterTurnsReportUsage === undefined
        ? {}
        : { laterTurnsReportUsage: options.laterTurnsReportUsage }),
      running: yield* Queue.unbounded<HeldControl>(),
      steered: yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2SteerInput>(),
    };

    const layerHarness = ProviderReplayHarness.layerWithRegistry(
      { name },
      ProviderAdapterRegistry.layerSingle(makeAdapter(captured, held)),
    );
    // The reactor reads only runs and the thread row; serve them from the orchestrator.
    const layerProjections = Layer.unwrap(
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        return Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThread: (id) =>
            orchestrator.getThreadProjection(id).pipe(
              Effect.map((projection) => projection.thread),
              Effect.orDie,
            ),
          getThreadRecords: (id, fields) =>
            orchestrator.getThreadRecords(id, fields).pipe(Effect.orDie),
        });
      }),
    );
    const layerReactor = ContextRolloverReactor.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          layerProjections,
          Layer.mock(ExperimentService.ExperimentService)({
            list: () => Effect.succeed([]),
            getRolloverAssignment: () => Effect.succeed(options.assignment ?? null),
            assignForThread: () =>
              Effect.succeed(options.assignment === undefined ? [] : [options.assignment]),
            recordObservation: (input) =>
              Effect.sync(() => {
                observations.push(input);
                return { ...input, recordedAt: "2026-10-14T12:00:00.000Z" };
              }),
          }),
          ServerSettings.layerTest({
            providerInstances: { [providerInstanceId]: { driver } },
            contextRollover: {
              enabled: options.rolloverEnabled ?? true,
              softThreshold: 1_000,
              hardThreshold: 2_000,
              modelRules: [],
            },
          }).pipe(Layer.orDie),
          NodeServices.layer,
        ),
      ),
    );

    return yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const reactor = yield* ContextRolloverReactor.ContextRolloverReactor;
      yield* reactor.start();

      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`command:${name}:create`),
        threadId,
        projectId: ProjectId.make(`project:${name}`),
        title: name,
        modelSelection: selection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: cwd,
      });
      if (options.hold !== undefined) {
        yield* orchestrator.dispatch({
          type: "thread.rollover-hold.set",
          commandId: CommandId.make(`command:${name}:hold`),
          threadId,
          hold: options.hold,
        });
      }
      if (options.thresholds !== undefined) {
        yield* orchestrator.dispatch({
          type: "thread.rollover-thresholds.set",
          commandId: CommandId.make(`command:${name}:thresholds`),
          threadId,
          thresholds: options.thresholds,
        });
      }
      const nudged = options.nudged !== false;
      const allDone = yield* eventSink
        .stream({ threadId, afterSequence: yield* eventSink.latestSequence({ threadId }) })
        .pipe(
          Stream.map((stored) => stored.event),
          Stream.filter(
            (event) => event.type === "run.updated" && event.payload.status === "completed",
          ),
          Stream.take(options.queueMessage === true ? 2 : 1),
          Stream.runDrain,
          Effect.forkScoped,
        );
      const usageReported = yield* eventSink
        .stream({ threadId, afterSequence: yield* eventSink.latestSequence({ threadId }) })
        .pipe(
          Stream.map((stored) => stored.event),
          Stream.filter(
            (event) =>
              event.type === "provider-turn.updated" && event.payload.tokenUsage !== undefined,
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`command:${name}:first`),
        threadId,
        messageId: MessageId.make(`message:${name}:first`),
        text: "first",
        attachments: [],
        modelSelection: selection,
        dispatchMode: { type: "start_immediately" },
      });

      // Past the soft threshold the reactor steers a nudge into the running turn.
      const steer = nudged ? yield* Queue.take(held.steered) : undefined;
      // Nothing to wait for without a nudge: wait for the turn itself to be running.
      const earlyTurn = nudged ? undefined : yield* Queue.take(held.running);
      const firstRun = (yield* orchestrator.getThreadProjection(threadId)).runs.findLast(
        (run) => run.status === "running",
      )!;
      assert.equal(firstRun.status, "running");

      if (options.queueMessage === true) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`command:${name}:queued`),
          threadId,
          messageId: MessageId.make(`message:${name}:queued`),
          text: "queued",
          attachments: [],
          modelSelection: selection,
          dispatchMode: { type: "queue_after_active" },
        });
      }
      const running = earlyTurn ?? (yield* Queue.take(held.running));
      // Without a nudge to wait for, make sure the usage report was handled first.
      yield* Fiber.join(usageReported);
      yield* reactor.drain;
      if (options.duringFirst !== undefined) yield* options.duringFirst(running);
      yield* running.complete;
      if (options.duringSecond !== undefined) {
        const second = yield* Queue.take(held.running);
        yield* options.duringSecond(second, held.steered);
        yield* reactor.drain;
        yield* second.complete;
      }
      yield* Fiber.join(allDone);
      if (options.afterFirstRun !== undefined) yield* options.afterFirstRun(firstRun.id);
      yield* reactor.drain;
      yield* worker.drain();
      return {
        steer,
        firstRun,
        after: yield* orchestrator.getThreadProjection(threadId),
        captured: yield* Ref.get(captured),
        observations,
      };
    }).pipe(Effect.provide(Layer.provideMerge(layerReactor, layerHarness)));
  });

it.live("nudges a running agent past the soft threshold and keeps its run and conversation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { steer, firstRun, after, captured } = yield* runHeldTurnScenario(
        "context-compaction-nudge",
      );

      assert.equal(steer!.runId, firstRun.id);
      assert.include(JSON.stringify(steer!.message), "next natural break");
      assert.include(JSON.stringify(steer!.message), "compacted automatically");

      // The provider compacts natively: no resume message, new run, session or handoff.
      assert.lengthOf(after.runs, 1);
      assert.lengthOf(captured.started, 1);
      assert.lengthOf(captured.ensured, 1);
      assert.isEmpty(after.contextHandoffs);
      assert.isUndefined(after.runs[0]!.rolloverOfRunId);

      // The nudge is a system row, not a user message.
      const rows = after.turnItems.filter((item) => item.type === "notification");
      assert.deepEqual(
        rows.map((row) => row.summary),
        ["Context at 2k tokens: asked to prepare for compaction at the next break"],
      );
      assert.isFalse(
        after.turnItems.some(
          (item) => item.type === "user_message" && item.creationSource === "server",
        ),
      );
    }),
  ),
);

it.live.each([1_500, 2_500])("starts no further work after a nudge at %i tokens", (usedTokens) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { after, captured } = yield* runHeldTurnScenario(
        `context-compaction-no-restart-${usedTokens}`,
        { usedTokens },
      );
      assert.lengthOf(after.runs, 1);
      assert.lengthOf(captured.started, 1);
      assert.lengthOf(captured.steered, 1);
    }),
  ),
);

it.live("drops a nudge that arrives after its run ended instead of starting new work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const name = "context-compaction-late-nudge";
      const { after, captured } = yield* runHeldTurnScenario(name, {
        nudged: false,
        afterFirstRun: (runId) =>
          Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const exit = yield* orchestrator
              .dispatch({
                type: "message.dispatch",
                createdBy: "agent",
                creationSource: "server",
                commandId: CommandId.make(`${ROLLOVER_NUDGE_COMMAND_PREFIX}${name}:late`),
                threadId: ThreadId.make(`thread:${name}`),
                messageId: MessageId.make(`message:${name}:late`),
                text: "prepare for compaction",
                notification: {
                  source: { kind: "system" },
                  outcome: "updated",
                  summary: "late",
                  detail: "late",
                },
                attachments: [],
                modelSelection: selection,
                dispatchMode: { type: "steer_active", targetRunId: runId },
              })
              .pipe(Effect.exit);
            assert.isTrue(exit._tag === "Failure");
          }),
      });
      assert.lengthOf(after.runs, 1);
      assert.lengthOf(captured.started, 1);
    }),
  ),
);

it.live("asks again as the next turn starts when a turn ends unanswered", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let secondSteer: ProviderAdapter.ProviderAdapterV2SteerInput | undefined;
      const { after } = yield* runHeldTurnScenario("context-compaction-ask-again", {
        queueMessage: true,
        // The queued turn reports no usage: it is nudged as it starts, from the 1.5k
        // the first turn reported.
        laterTurnsReportUsage: false,
        duringSecond: (_control, steered) =>
          Queue.take(steered).pipe(Effect.map((steer) => void (secondSteer = steer))),
      });

      assert.lengthOf(after.runs, 2);
      assert.equal(secondSteer?.runId, after.runs[1]!.id);
      assert.include(JSON.stringify(secondSteer?.message), "next natural break");
    }),
  ),
);

it.live("uses the provider context boundary when configured thresholds are too high", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { steer, after } = yield* runHeldTurnScenario("context-compaction-bounded", {
        maxTokens: 1_600,
      });
      assert.include(JSON.stringify(steer!.message), "at any moment");
      assert.lengthOf(after.runs, 1);
    }),
  ),
);

it.live("keeps queued work on the same conversation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { after, captured } = yield* runHeldTurnScenario("context-compaction-queued", {
        queueMessage: true,
      });
      assert.lengthOf(after.runs, 2);
      assert.isTrue(captured.started[1]!.nativeThreadHasTurns);
      assert.include(JSON.stringify(captured.started[1]!.message), "queued");
      assert.isEmpty(after.contextHandoffs);
    }),
  ),
);

it.live("sends no nudge while a thread's context hold is off", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { after, captured } = yield* runHeldTurnScenario("context-compaction-held", {
        hold: { kind: "off" },
        nudged: false,
      });

      assert.lengthOf(after.runs, 1);
      assert.lengthOf(captured.steered, 0);
    }),
  ),
);

it.live("nudges at a thread's own thresholds with the setting off globally", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { steer, firstRun } = yield* runHeldTurnScenario("context-compaction-own-thresholds", {
        rolloverEnabled: false,
        thresholds: { soft: 1_000, hard: 2_000 },
      });

      assert.equal(steer!.runId, firstRun.id);
      assert.include(JSON.stringify(steer!.message), "next natural break");
    }),
  ),
);

it.live("nudges again once a pause has lapsed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const lapsed = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { minutes: 1 }));
      const { steer, firstRun } = yield* runHeldTurnScenario("context-compaction-lapsed", {
        hold: { kind: "paused", until: lapsed },
      });

      assert.equal(steer!.runId, firstRun.id);
    }),
  ),
);

it.live(
  "does not nudge a compacted conversation again until it grows past its compacted size",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let growthSteer: ProviderAdapter.ProviderAdapterV2SteerInput | undefined;
        const { after, captured } = yield* runHeldTurnScenario("context-compaction-floor", {
          queueMessage: true,
          duringFirst: (control) =>
            control.reportCompaction("compaction:floor", {
              beforeTokenCount: 1_500,
              afterTokenCount: 1_500,
            }),
          duringSecond: (control, steered) =>
            Effect.gen(function* () {
              // Reports in order: had the 1.5k report nudged, that steer would come first.
              // A delayed high-usage report must not trigger the next nudge.
              yield* control.reportUsage(90_000, "2000-01-01T00:00:00.000Z");
              yield* control.reportUsage(1_500 + ROLLOVER_MIN_GROWTH_TOKENS);
              growthSteer = yield* Queue.take(steered);
            }),
        });

        assert.lengthOf(after.runs, 2);
        assert.equal(growthSteer?.runId, after.runs[1]!.id);
        assert.include(JSON.stringify(growthSteer?.message), "at any moment");
        assert.include(JSON.stringify(growthSteer?.message), "22k");
        assert.notInclude(JSON.stringify(growthSteer?.message), "90k");
        assert.lengthOf(captured.steered, 2);
      }),
    ),
);

const testAssignment: ExperimentAssignment = {
  id: "assignment:rollover-test",
  experimentId: "rollover-test",
  revision: 1,
  lever: "rollover",
  unitKind: "thread",
  unitId: "thread:context-rollover-experiment",
  threadId: ThreadId.make("thread:context-rollover-experiment"),
  projectId: ProjectId.make("project:context-rollover-experiment"),
  taskCategory: null,
  boundaryRunId: null,
  variant: { id: "baseline", label: "Baseline", rollover: { softLimit: 1_000, hardLimit: 2_000 } },
  assignedModelSelection: selection,
  enrollment: "new",
  assignmentMethod: "randomized",
  assignedAt: "2026-10-14T00:00:00.000Z",
  codeRevision: null,
  briefRevision: null,
  provenance: null,
};

it.live("applies an assigned policy with global defaults off and records the nudge", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { observations, after } = yield* runHeldTurnScenario("context-compaction-experiment", {
        assignment: testAssignment,
        rolloverEnabled: false,
      });
      assert.deepEqual(
        observations.map((entry) => entry.kind),
        ["soft"],
      );
      assert.isTrue(observations.every((entry) => entry.assignmentId === testAssignment.id));
      assert.equal(observations[0]!.runId, after.runs[0]!.id);
      assert.lengthOf(after.runs, 1);
    }),
  ),
);

it.live("a manual hold prevents an assigned experiment from nudging", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { observations, captured } = yield* runHeldTurnScenario(
        "context-compaction-experiment-held",
        {
          assignment: testAssignment,
          rolloverEnabled: false,
          hold: { kind: "off" },
          nudged: false,
        },
      );
      assert.lengthOf(captured.steered, 0);
      assert.lengthOf(observations, 0);
    }),
  ),
);

it.live(
  "records observed context drops and the first subsequent growth, ignoring stale reports",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { observations } = yield* runHeldTurnScenario("context-drop-observation", {
          assignment: testAssignment,
          duringFirst: (control) =>
            Effect.gen(function* () {
              yield* control.reportUsage(800);
              yield* control.reportUsage(700, "2000-01-01T00:00:00.000Z");
              yield* control.reportUsage(900);
              yield* control.reportUsage(950);
            }),
        });
        const drops = observations.filter((item) => item.kind === "context-drop");
        const growth = observations.filter((item) => item.kind === "context-growth");
        assert.lengthOf(drops, 1);
        assert.equal(drops[0]!.usedTokens, 800);
        assert.equal(drops[0]!.recoveredTokens, 700);
        assert.lengthOf(growth, 1);
        assert.equal(growth[0]!.usedTokens, 900);
        assert.equal(growth[0]!.growthTokens, 100);
      }),
    ),
);

it.live(
  "records completed native compaction items once and leaves unreported token counts unknown",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { observations } = yield* runHeldTurnScenario("native-compaction-observation", {
          assignment: testAssignment,
          duringFirst: (control) =>
            Effect.gen(function* () {
              yield* control.reportCompaction("compaction:unknown");
              yield* control.reportCompaction("compaction:unknown");
              yield* control.reportCompaction("compaction:counted", {
                beforeTokenCount: 1_500,
                afterTokenCount: 800,
              });
              yield* control.reportUsage(800);
              yield* control.reportUsage(900);
            }),
        });
        const compactions = observations.filter((item) => item.kind === "native-compaction");
        assert.lengthOf(compactions, 2);
        assert.isNull(compactions[0]!.usedTokens);
        assert.isUndefined(compactions[0]!.recoveredTokens);
        assert.include(compactions[0]!.evidence, "turn-item:compaction:unknown");
        assert.equal(compactions[1]!.usedTokens, 800);
        assert.equal(compactions[1]!.recoveredTokens, 700);
        assert.lengthOf(
          observations.filter((item) => item.kind === "context-growth"),
          1,
        );
      }),
    ),
);
