import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type ExperimentAssignment,
  type ExperimentObservationInput,
  type OrchestrationV2ProviderThread,
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
import {
  ContextRolloverNotes,
  ROLLOVER_MIN_GROWTH_TOKENS,
  ROLLOVER_NOTE_MAX_BYTES,
  ROLLOVER_NOTE_TOOL_NAME,
} from "./ContextRollover.ts";
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

it.live("continues a thread on a fresh native session seeded with the rollover note", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("context-rollover");
      const threadId = ThreadId.make("thread:context-rollover");
      const captured = yield* Ref.make<Captured>(emptyCaptured);
      const note = "## Goal\nFinish the rollover feature.";

      const result = yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const eventSink = yield* EventSink.EventSinkV2;

        const completedRuns = (count: number) =>
          Effect.gen(function* () {
            return yield* eventSink
              .stream({ threadId, afterSequence: yield* eventSink.latestSequence({ threadId }) })
              .pipe(
                Stream.map((stored) => stored.event),
                Stream.filter(
                  (event) => event.type === "run.updated" && event.payload.status === "completed",
                ),
                Stream.take(count),
                Stream.runDrain,
                Effect.forkScoped,
              );
          });

        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:context-rollover:create"),
          threadId,
          projectId: ProjectId.make("project:context-rollover"),
          title: "Context rollover",
          modelSelection: selection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
        });
        const firstDone = yield* completedRuns(1);
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:context-rollover:first"),
          threadId,
          messageId: MessageId.make("message:context-rollover:first"),
          text: "first",
          attachments: [],
          modelSelection: selection,
          dispatchMode: { type: "start_immediately" },
        });
        yield* Fiber.join(firstDone);
        yield* worker.drain();
        const before = yield* orchestrator.getThreadProjection(threadId);
        const firstRun = before.runs[0]!;

        const refused = yield* orchestrator
          .dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:context-rollover:refused"),
            threadId,
            messageId: MessageId.make("message:context-rollover:refused"),
            text: "not from the server",
            attachments: [],
            modelSelection: selection,
            dispatchMode: { type: "start_immediately" },
            contextRollover: { note, ofRunId: firstRun.id },
          })
          .pipe(Effect.flip);

        const rolloverDone = yield* completedRuns(1);
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "agent",
          creationSource: "server",
          commandId: CommandId.make("command:context-rollover:resume"),
          threadId,
          messageId: MessageId.make("message:context-rollover:resume"),
          text: "Resume from the note.",
          notification: {
            source: { kind: "system" },
            outcome: "updated",
            summary: "Context rolled over to a fresh session",
            detail: "Resume from the note.",
          },
          attachments: [],
          modelSelection: selection,
          dispatchMode: { type: "start_immediately" },
          contextRollover: { note, ofRunId: firstRun.id },
        });
        yield* Fiber.join(rolloverDone);
        yield* worker.drain();
        return {
          before,
          after: yield* orchestrator.getThreadProjection(threadId),
          refused,
          captured: yield* Ref.get(captured),
        };
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: "context-rollover" },
            ProviderAdapterRegistry.layerSingle(makeAdapter(captured)),
          ),
        ),
      );
      const { before, after, refused, captured: calls } = result;

      assert.equal(refused._tag, "OrchestratorDispatchError");
      assert.lengthOf(after.runs, 2);
      const rolloverRun = after.runs[1]!;
      assert.equal(rolloverRun.status, "completed");

      // Same provider thread row, new native thread.
      assert.lengthOf(after.providerThreads, 1);
      const [row] = after.providerThreads;
      assert.equal(row!.id, before.providerThreads[0]!.id);
      assert.notEqual(
        row!.nativeThreadRef?.nativeId,
        before.providerThreads[0]!.nativeThreadRef?.nativeId,
      );
      assert.deepEqual(
        calls.ensured.map((call) => call.existing),
        [row!.id, row!.id],
      );

      // The fresh session gets the note, not a resume of the old native thread.
      const rolloverStart = calls.started[1]!;
      assert.isFalse(rolloverStart.nativeThreadHasTurns);
      assert.include(JSON.stringify(rolloverStart.message), "Finish the rollover feature.");

      const handoff = after.contextHandoffs.find((entry) => entry.targetRunId === rolloverRun.id);
      assert.equal(handoff?.strategy, "manual_context");
      assert.equal(handoff?.toProviderThreadId, row!.id);
      assert.isTrue(
        after.turnItems.some((item) => item.type === "handoff" && item.runId === rolloverRun.id),
      );
    }),
  ),
);

it.live("a message sent while a rollover note waits starts the fresh session with it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const name = "context-rollover-carried";
      const cwd = yield* checkpointWorkspace(name);
      const threadId = ThreadId.make(`thread:${name}`);
      const captured = yield* Ref.make<Captured>(emptyCaptured);

      const after = yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const notes = yield* ContextRolloverNotes;
        const runDone = Effect.gen(function* () {
          return yield* eventSink
            .stream({ threadId, afterSequence: yield* eventSink.latestSequence({ threadId }) })
            .pipe(
              Stream.map((stored) => stored.event),
              Stream.filter(
                (event) => event.type === "run.updated" && event.payload.status === "completed",
              ),
              Stream.take(1),
              Stream.runDrain,
              Effect.forkScoped,
            );
        });
        const send = (text: string) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`command:${name}:${text}`),
            threadId,
            messageId: MessageId.make(`message:${name}:${text}`),
            text,
            attachments: [],
            modelSelection: selection,
            dispatchMode: { type: "start_immediately" },
          });

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
        const firstDone = yield* runDone;
        yield* send("first");
        yield* Fiber.join(firstDone);
        yield* worker.drain();
        const firstRun = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        notes.save(threadId, { runId: firstRun.id, note: "## Goal\nCarry the note forward." });

        const nextDone = yield* runDone;
        yield* send("continue");
        yield* Fiber.join(nextDone);
        yield* worker.drain();
        return yield* orchestrator.getThreadProjection(threadId);
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name },
            ProviderAdapterRegistry.layerSingle(makeAdapter(captured)),
          ),
        ),
      );

      const next = after.runs[1]!;
      assert.equal(next.rolloverOfRunId, after.runs[0]!.id);
      const start = (yield* Ref.get(captured)).started[1]!;
      assert.isFalse(start.nativeThreadHasTurns);
      assert.include(JSON.stringify(start.message), "continue");
      assert.include(JSON.stringify(start.message), "Carry the note forward.");
    }),
  ),
);

/**
 * Runs a thread whose first turn reports 1.5k context tokens against a 1k/2k
 * rollover, waits for the reactor's steer, saves `note` when given, optionally
 * queues a user message, ends the turn and waits for the run that follows it.
 * With a `hold` set on the thread beforehand, no request is expected (`nudged: false`)
 * and the turn is the only run.
 */
const runHeldTurnScenario = (
  name: string,
  note: string | null,
  options: {
    readonly assignment?: ExperimentAssignment;
    readonly duringFirst?: (control: HeldControl) => Effect.Effect<void>;
    readonly rolloverEnabled?: boolean;
    readonly queueMessage?: boolean;
    /** Leaves a message held in the queue, as stopping an earlier turn does. */
    readonly heldQueuedMessage?: boolean;
    readonly usedTokens?: number;
    readonly maxTokens?: number;
    readonly hold?: OrchestrationV2RolloverHold;
    /** The thread's own thresholds, as set by dragging its composer's rollover band. */
    readonly thresholds?: { readonly soft: number; readonly hard: number };
    readonly nudged?: boolean;
    readonly laterTurnsReportUsage?: boolean;
    /** Holds the rollover run's turn too and runs this against it before completing it. */
    readonly duringRollover?: (
      control: HeldControl,
      steered: Queue.Queue<ProviderAdapter.ProviderAdapterV2SteerInput>,
    ) => Effect.Effect<void>;
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
      holdEveryTurn: options.duringRollover !== undefined,
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
      const notes = yield* ContextRolloverNotes;
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
      if (options.heldQueuedMessage === true) {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`command:${name}:stopped`),
          threadId,
          messageId: MessageId.make(`message:${name}:stopped`),
          text: "stopped",
          attachments: [],
          modelSelection: selection,
          dispatchMode: { type: "start_immediately" },
        });
        yield* Queue.take(held.running);
        // Its usage is past the soft threshold; take the request before stopping it.
        yield* Queue.take(held.steered);
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`command:${name}:held`),
          threadId,
          messageId: MessageId.make(`message:${name}:held`),
          text: "held",
          attachments: [],
          modelSelection: selection,
          dispatchMode: { type: "queue_after_active" },
        });
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make(`command:${name}:stop`),
          threadId,
          runId: (yield* orchestrator.getThreadProjection(threadId)).runs[0]!.id,
          holdQueue: true,
        });
        yield* worker.drain();
        yield* reactor.drain;
      }
      const nudged = options.nudged !== false;
      const bothDone = yield* eventSink
        .stream({ threadId, afterSequence: yield* eventSink.latestSequence({ threadId }) })
        .pipe(
          Stream.map((stored) => stored.event),
          Stream.filter(
            (event) => event.type === "run.updated" && event.payload.status === "completed",
          ),
          Stream.take(note !== null || options.queueMessage === true ? 2 : 1),
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
      // A user's own send releases a held queue, so the held-queue scenario's run comes from an agent.
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        ...(options.heldQueuedMessage === true
          ? { createdBy: "agent" as const, creationSource: "mcp" as const }
          : { createdBy: "user" as const, creationSource: "web" as const }),
        commandId: CommandId.make(`command:${name}:first`),
        threadId,
        messageId: MessageId.make(`message:${name}:first`),
        text: "first",
        attachments: [],
        modelSelection: selection,
        dispatchMode: { type: "start_immediately" },
      });

      // Past the soft threshold the reactor steers a note request into the running turn.
      const steer = nudged ? yield* Queue.take(held.steered) : undefined;
      // Nothing to wait for without a request: wait for the turn itself to be running.
      const earlyTurn = nudged ? undefined : yield* Queue.take(held.running);
      const firstRun = (yield* orchestrator.getThreadProjection(threadId)).runs.findLast(
        (run) => run.status === "running",
      )!;
      assert.equal(firstRun.status, "running");

      if (note !== null) notes.save(threadId, { runId: firstRun.id, note });
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
      // Without a request to wait for, make sure the usage report was handled first.
      yield* Fiber.join(usageReported);
      yield* reactor.drain;
      if (options.duringFirst !== undefined) yield* options.duringFirst(running);
      yield* running.complete;
      if (options.duringRollover !== undefined) {
        const rolloverTurn = yield* Queue.take(held.running);
        yield* options.duringRollover(rolloverTurn, held.steered);
        yield* reactor.drain;
        yield* rolloverTurn.complete;
      }
      yield* Fiber.join(bothDone);
      yield* reactor.drain;
      yield* worker.drain();
      return {
        steer,
        firstRun,
        after: yield* orchestrator.getThreadProjection(threadId),
        noteLeft: notes.get(threadId),
        captured: yield* Ref.get(captured),
        observations,
      };
    }).pipe(Effect.provide(Layer.provideMerge(layerReactor, layerHarness)));
  });

it.live(
  "asks a running agent for a note past the soft threshold and rolls over when its run completes",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        // As long a note as the tool accepts still reaches the fresh session whole.
        const tail = "End of the note.";
        const filler = "x".repeat(ROLLOVER_NOTE_MAX_BYTES - 60);
        const note = `## Goal\nShip the reactor test.\n${filler}\n${tail}`;
        assert.isAtMost(Buffer.byteLength(note, "utf8"), ROLLOVER_NOTE_MAX_BYTES);
        const { steer, firstRun, after, noteLeft, captured } = yield* runHeldTurnScenario(
          "context-rollover-reactor",
          note,
        );

        assert.equal(steer!.runId, firstRun.id);
        assert.include(JSON.stringify(steer!.message), ROLLOVER_NOTE_TOOL_NAME);
        assert.include(JSON.stringify(steer!.message), "next natural break");

        assert.lengthOf(after.runs, 2);
        const rolloverRun = after.runs[1]!;
        assert.equal(rolloverRun.status, "completed");
        assert.isUndefined(noteLeft);

        const rolloverStart = captured.started[1]!;
        assert.isFalse(rolloverStart.nativeThreadHasTurns);
        assert.include(JSON.stringify(rolloverStart.message), "Ship the reactor test.");
        assert.include(JSON.stringify(rolloverStart.message), tail);
        const handoff = after.contextHandoffs.find((entry) => entry.targetRunId === rolloverRun.id);
        assert.equal(handoff?.strategy, "manual_context");

        // The timeline shows T3's request and the rollover as system rows, not user
        // messages, and the rollover row opens to the note the fresh session got.
        const rows = after.turnItems.filter((item) => item.type === "notification");
        assert.deepEqual(
          rows.map((row) => row.summary),
          [
            "Context at 2k tokens: asked for a handoff at the next break",
            "Context rolled over to a fresh session",
          ],
        );
        assert.include(rows[0]!.detail, ROLLOVER_NOTE_TOOL_NAME);
        assert.equal(rows[1]!.detail, note);
        assert.isFalse(
          after.turnItems.some(
            (item) => item.type === "user_message" && item.creationSource === "server",
          ),
        );
      }),
    ),
);

it.live.each([1_500, 2_500])(
  "does not restart completed work without a note at %i tokens",
  (usedTokens) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { after, captured } = yield* runHeldTurnScenario(
          `context-rollover-reactor-no-restart-${usedTokens}`,
          null,
          { usedTokens },
        );
        assert.lengthOf(after.runs, 1);
        assert.lengthOf(captured.started, 1);
        assert.lengthOf(captured.steered, 1);
        assert.isFalse(after.contextHandoffs.some((entry) => entry.strategy === "manual_context"));
      }),
    ),
);

it.live("asks again as the next turn starts when a turn ends without a note", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let secondSteer: ProviderAdapter.ProviderAdapterV2SteerInput | undefined;
      const { after } = yield* runHeldTurnScenario("context-rollover-reactor-ask-again", null, {
        queueMessage: true,
        // The queued turn reports no usage: it is asked as it starts, from the 1.5k
        // the first turn reported before ending without a note.
        laterTurnsReportUsage: false,
        duringRollover: (_control, steered) =>
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
      const { steer, after } = yield* runHeldTurnScenario(
        "context-rollover-reactor-bounded",
        null,
        { maxTokens: 1_600 },
      );
      assert.include(JSON.stringify(steer!.message), "hand off now");
      assert.lengthOf(after.runs, 1);
    }),
  ),
);

it.live("starts queued user work on a fresh session seeded with the saved rollover note", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { after, noteLeft, captured, observations } = yield* runHeldTurnScenario(
        "context-rollover-reactor-queued",
        "## Goal\nFinish the existing task and incorporate the queued request.",
        { queueMessage: true, assignment: testAssignment, duringRollover: () => Effect.void },
      );

      // Preserve the queued run/message identity while making its session fresh.
      assert.lengthOf(after.runs, 2);
      assert.isUndefined(noteLeft);
      const queued = captured.started[1]!;
      assert.isFalse(queued.nativeThreadHasTurns);
      assert.include(JSON.stringify(queued.message), "queued");
      assert.include(JSON.stringify(queued.message), "Finish the existing task");
      assert.equal(after.runs[1]!.rolloverOfRunId, after.runs[0]!.id);
      assert.lengthOf(
        observations.filter((entry) => entry.kind === "rollover"),
        1,
      );
      assert.lengthOf(
        observations.filter((entry) => entry.kind === "fresh-context"),
        1,
      );
      assert.lengthOf(
        observations.filter((entry) => entry.kind === "continuation-ended"),
        1,
      );
      assert.isTrue(after.contextHandoffs.some((entry) => entry.strategy === "manual_context"));
    }),
  ),
);

it.live("keeps queued work on the current session when no rollover note was saved", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { after, captured } = yield* runHeldTurnScenario(
        "context-rollover-queued-without-note",
        null,
        { queueMessage: true },
      );
      assert.lengthOf(after.runs, 2);
      assert.isUndefined(after.runs[1]!.rolloverOfRunId);
      assert.isTrue(captured.started[1]!.nativeThreadHasTurns);
      assert.include(JSON.stringify(captured.started[1]!.message), "queued");
      assert.isEmpty(after.contextHandoffs);
    }),
  ),
);

it.live("rolls over without waiting for a held queue, which stays held", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { firstRun, after, noteLeft, captured } = yield* runHeldTurnScenario(
        "context-rollover-held-queue",
        "## Goal\nContinue past the held queue.",
        { heldQueuedMessage: true, duringRollover: () => Effect.void },
      );

      assert.isUndefined(noteLeft);
      const rolloverRun = after.runs.find((run) => run.rolloverOfRunId === firstRun.id);
      assert.equal(rolloverRun?.status, "completed");
      const rolloverStart = captured.started.at(-1)!;
      assert.equal(rolloverStart.runId, rolloverRun!.id);
      assert.isFalse(rolloverStart.nativeThreadHasTurns);
      assert.include(JSON.stringify(rolloverStart.message), "Continue past the held queue.");
      const heldRun = after.runs.find((run) => run.status === "queued");
      assert.isTrue(heldRun?.queueHeld);
    }),
  ),
);

it.live("sends no request and no end-of-run fallback while a thread's rollover is off", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { after, captured } = yield* runHeldTurnScenario(
        "context-rollover-reactor-held",
        null,
        { hold: { kind: "off" }, nudged: false },
      );

      assert.lengthOf(after.runs, 1);
      assert.lengthOf(captured.steered, 0);
      assert.lengthOf(captured.started, 1);
    }),
  ),
);

it.live("rolls a thread over at its own thresholds with rollover off globally", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { steer, firstRun } = yield* runHeldTurnScenario(
        "context-rollover-reactor-own-thresholds",
        null,
        { rolloverEnabled: false, thresholds: { soft: 1_000, hard: 2_000 } },
      );

      assert.equal(steer!.runId, firstRun.id);
      assert.include(JSON.stringify(steer!.message), ROLLOVER_NOTE_TOOL_NAME);
    }),
  ),
);

it.live("asks again once a pause has lapsed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const lapsed = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { minutes: 1 }));
      const { steer, firstRun } = yield* runHeldTurnScenario(
        "context-rollover-reactor-lapsed",
        null,
        { hold: { kind: "paused", until: lapsed } },
      );

      assert.equal(steer!.runId, firstRun.id);
      assert.include(JSON.stringify(steer!.message), ROLLOVER_NOTE_TOOL_NAME);
    }),
  ),
);

it.live("does not roll a fresh session over again until it grows past its starting size", () =>
  Effect.scoped(
    Effect.gen(function* () {
      // Every turn reports 1.5k against a 1k/2k rollover, as a fresh session whose
      // system prompt and note alone pass the threshold would.
      let rolloverSteer: ProviderAdapter.ProviderAdapterV2SteerInput | undefined;
      const { after, captured } = yield* runHeldTurnScenario(
        "context-rollover-reactor-floor",
        "## Goal\nKeep going.",
        {
          duringRollover: (control, steered) =>
            Effect.gen(function* () {
              // Reports in order: had the 1.5k report asked for a note, that steer would come first.
              // A delayed high-usage report must not trigger the next nudge.
              yield* control.reportUsage(90_000, "2000-01-01T00:00:00.000Z");
              yield* control.reportUsage(1_500 + ROLLOVER_MIN_GROWTH_TOKENS);
              rolloverSteer = yield* Queue.take(steered);
            }),
        },
      );

      // runs[1] is the rollover run; completing it without a note starts no extra run.
      assert.equal(after.runs[1]!.status, "completed");
      assert.isTrue(after.contextHandoffs.some((entry) => entry.targetRunId === after.runs[1]!.id));
      assert.equal(rolloverSteer?.runId, after.runs[1]!.id);
      assert.include(JSON.stringify(rolloverSteer?.message), "hand off now");
      assert.include(JSON.stringify(rolloverSteer?.message), "22k");
      assert.notInclude(JSON.stringify(rolloverSteer?.message), "90k");
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

it.live("applies assigned rollover with global defaults off and records the observed handoff", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { observations, after } = yield* runHeldTurnScenario(
        "context-rollover-experiment",
        "## Goal\nContinue the assigned work.",
        { assignment: testAssignment, rolloverEnabled: false, duringRollover: () => Effect.void },
      );
      assert.deepEqual(
        observations.map((entry) => entry.kind),
        ["soft", "rollover", "fresh-context", "continuation-ended"],
      );
      assert.isTrue(observations.every((entry) => entry.assignmentId === testAssignment.id));
      assert.equal(observations[0]!.runId, after.runs[0]!.id);
      assert.equal(observations[2]!.runId, after.runs[1]!.id);
      assert.equal(observations[2]!.usedTokens, 1_500);
      assert.equal(observations[2]!.recoveredTokens, 0);
      assert.isTrue(observations[2]!.lowYield);
      assert.lengthOf(after.runs, 2);
    }),
  ),
);

it.live("a manual hold prevents an assigned experiment from nudging", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { observations, captured } = yield* runHeldTurnScenario(
        "context-rollover-experiment-held",
        null,
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
        const { observations } = yield* runHeldTurnScenario("context-drop-observation", null, {
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
        const { observations } = yield* runHeldTurnScenario("native-compaction-observation", null, {
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
