import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2RolloverHold,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
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
  readonly reportUsage: (usedTokens: number) => Effect.Effect<void>;
  /** Completes the turn. */
  readonly complete: Effect.Effect<void>;
}

interface HeldTurn {
  /** The held turn's first usage report, in context tokens. */
  readonly usedTokens: number;
  /** Hold every turn, not only the first. */
  readonly holdEveryTurn?: boolean;
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
              const reportUsage = (usedTokens: number) =>
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
                        updatedAt: DateTime.formatIso(yield* DateTime.now),
                      },
                    },
                  });
                }).pipe(Effect.asVoid);
              yield* reportUsage(held.usedTokens);
              yield* Queue.offer(held.running, { reportUsage, complete });
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
    readonly queueMessage?: boolean;
    readonly hold?: OrchestrationV2RolloverHold;
    readonly nudged?: boolean;
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
    const held: HeldTurn = {
      usedTokens: 1_500,
      holdEveryTurn: options.duringRollover !== undefined,
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
          ServerSettings.layerTest({
            contextRollover: {
              enabled: true,
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
      const nudged = options.nudged !== false;
      const bothDone = yield* eventSink
        .stream({ threadId, afterSequence: yield* eventSink.latestSequence({ threadId }) })
        .pipe(
          Stream.map((stored) => stored.event),
          Stream.filter(
            (event) => event.type === "run.updated" && event.payload.status === "completed",
          ),
          Stream.take(nudged ? 2 : 1),
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

      // Past the soft threshold the reactor steers a note request into the running turn.
      const steer = nudged ? yield* Queue.take(held.steered) : undefined;
      const firstRun = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
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
      const running = yield* Queue.take(held.running);
      // Without a request to wait for, make sure the usage report was handled first.
      yield* Fiber.join(usageReported);
      yield* reactor.drain;
      yield* running.complete;
      if (options.duringRollover !== undefined) {
        const rolloverTurn = yield* Queue.take(held.running);
        yield* options.duringRollover(rolloverTurn, held.steered);
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
      }),
    ),
);

it.live("asks once more, now, when the agent ends its turn without a note", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { after, captured } = yield* runHeldTurnScenario(
        "context-rollover-reactor-fallback",
        null,
      );

      // One follow-up run on the same native session carries the hard request; no rollover.
      assert.lengthOf(after.runs, 2);
      const followUp = captured.started[1]!;
      assert.isTrue(followUp.nativeThreadHasTurns);
      assert.include(JSON.stringify(followUp.message), "hand off now");
      assert.isFalse(
        after.contextHandoffs.some((entry) => entry.targetRunId === after.runs[1]!.id),
      );
    }),
  ),
);

it.live("drops the note and lets a queued message run on when it starts before the rollover", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { after, noteLeft, captured } = yield* runHeldTurnScenario(
        "context-rollover-reactor-queued",
        "## Goal\nNever delivered.",
        { queueMessage: true },
      );

      // The queued message runs on the same native session; no rollover follows.
      assert.lengthOf(after.runs, 2);
      assert.isUndefined(noteLeft);
      const queued = captured.started[1]!;
      assert.isTrue(queued.nativeThreadHasTurns);
      assert.include(JSON.stringify(queued.message), "queued");
      assert.notInclude(JSON.stringify(queued.message), "Never delivered.");
      assert.isFalse(after.contextHandoffs.some((entry) => entry.strategy === "manual_context"));
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
              yield* control.reportUsage(1_500 + ROLLOVER_MIN_GROWTH_TOKENS);
              rolloverSteer = yield* Queue.take(steered);
            }),
        },
      );

      // runs[1] is the rollover run; the hard request may be followed by a run-end retry.
      assert.equal(after.runs[1]!.status, "completed");
      assert.isTrue(after.contextHandoffs.some((entry) => entry.targetRunId === after.runs[1]!.id));
      assert.equal(rolloverSteer?.runId, after.runs[1]!.id);
      assert.include(JSON.stringify(rolloverSteer?.message), "hand off now");
      assert.lengthOf(captured.steered, 2);
    }),
  ),
);
