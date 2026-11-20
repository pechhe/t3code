import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderCapabilities,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { snapshot as policySnapshot } from "../agents/agentPolicy.testkit.ts";
import * as ManagedAgent from "../agents/ManagedAgentService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as Reactor from "./ReviewerWrapUpReactor.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

const turns = (steer: boolean, restart: boolean) =>
  ({
    ...CodexProviderCapabilitiesV2.turns,
    supportsInterrupt: true,
    supportsActiveSteering: steer,
    supportsSteeringByInterruptRestart: restart,
    supportsQueuedMessages: true,
  }) satisfies OrchestrationV2ProviderCapabilities["turns"];

it("asks for the report at the threshold and restarts at half as many again, once each", () => {
  const none = new Set<Reactor.WrapUpStep>();
  assert.equal(Reactor.dueWrapUpStep(59, 60, none), undefined);
  assert.equal(Reactor.dueWrapUpStep(60, 60, none), "report");
  assert.equal(Reactor.dueWrapUpStep(89, 60, new Set(["report"])), undefined);
  assert.equal(Reactor.dueWrapUpStep(90, 60, new Set(["report"])), "restart");
  assert.equal(Reactor.dueWrapUpStep(120, 60, new Set(["report", "restart"])), undefined);
  // A count that jumps past both thresholds goes straight to the restart, and asks nothing after.
  assert.equal(Reactor.dueWrapUpStep(95, 60, none), "restart");
  assert.equal(Reactor.dueWrapUpStep(95, 60, new Set(["restart"])), undefined);
});

it("steers the report where the provider takes a message mid-turn, and otherwise restarts", () => {
  const run = RunId.make("run:review");
  // Pi: steers mid-turn, but stops the turn and runs the message next to restart it.
  const pi = turns(true, false);
  assert.deepEqual(Reactor.wrapUpDispatchMode("report", pi, run), {
    type: "steer_active",
    targetRunId: run,
  });
  assert.deepEqual(Reactor.wrapUpDispatchMode("restart", pi, run), {
    type: "restart_active",
    targetRunId: run,
  });
  // ACP: can only interrupt and restart, so both steps restart the turn.
  const acp = turns(false, true);
  for (const step of ["report", "restart"] as const)
    assert.deepEqual(Reactor.wrapUpDispatchMode(step, acp, run), {
      type: "restart_active",
      targetRunId: run,
    });
});

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const WRAP_UP_THRESHOLD = 4;

const wrapUpHarness = Effect.fn("wrapUpHarness")(function* (
  name: string,
  steer: boolean,
  restart: boolean,
) {
  const cwd = yield* checkpointWorkspace(name);
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const started: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
  const steered: string[] = [];
  const interrupted: ProviderTurnId[] = [];
  const capabilities = {
    ...CodexProviderCapabilitiesV2,
    turns: turns(steer, restart),
  };
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const turnUpdated = (
          turn: ProviderAdapter.ProviderAdapterV2TurnInput,
          status: "running" | "interrupted",
        ) =>
          Queue.offer(events, {
            type: "provider_turn.updated",
            driver,
            providerTurn: {
              id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
              providerThreadId: turn.providerThread.id,
              nodeId: turn.rootNodeId,
              runAttemptId: turn.attemptId,
              nativeTurnRef: {
                driver,
                nativeId: `native:${turn.attemptId}`,
                strength: "strong",
              },
              ordinal: turn.providerTurnOrdinal,
              status,
              startedAt: now,
              completedAt: status === "running" ? null : now,
            },
          });
        const startTurn = (turn: ProviderAdapter.ProviderAdapterV2TurnInput) =>
          Effect.gen(function* () {
            started.push(turn);
            yield* turnUpdated(turn, "running");
          });
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd,
            model: modelSelection.model,
            capabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: ({ threadId }) =>
            Effect.succeed({
              id: ProviderThreadId.make(`provider-thread:${threadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: `native:${threadId}`, strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn,
          compactThread: startTurn,
          steerTurn: (turn) =>
            Effect.sync(() => {
              steered.push(turn.message.text);
            }),
          interruptTurn: ({ providerTurnId }) =>
            Effect.sync(() => {
              interrupted.push(providerTurnId);
            }).pipe(
              Effect.andThen(
                Effect.forEach(
                  started.filter(
                    (turn) =>
                      ProviderTurnId.make(`provider-turn:${turn.attemptId}`) === providerTurnId,
                  ),
                  (turn) =>
                    turnUpdated(turn, "interrupted").pipe(
                      Effect.andThen(
                        Queue.offer(events, {
                          type: "turn.terminal",
                          driver,
                          providerThreadId: turn.providerThread.id,
                          providerTurnId,
                          runOrdinal: turn.runOrdinal,
                          status: "interrupted",
                          failure: null,
                          threadDisposition: "reusable",
                        }),
                      ),
                    ),
                  { discard: true },
                ),
              ),
            ),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        };
      }),
  };

  const basePolicy = policySnapshot();
  const wrapUpPolicy = {
    ...basePolicy,
    manifest: {
      ...basePolicy.manifest,
      roles: {
        ...basePolicy.manifest.roles,
        reviewer: {
          ...basePolicy.manifest.roles.reviewer,
          wrapUpAfterToolCalls: WRAP_UP_THRESHOLD,
        },
      },
    },
  };
  const database = Sqlite.layerMemory;
  const runtime = Layer.mergeAll(
    database,
    ProjectionStore.layer.pipe(Layer.provide(database)),
    Layer.mock(ManagedAgent.ManagedAgentService)({
      snapshot: () => Effect.succeed(wrapUpPolicy),
    }),
    ProviderReplayHarness.layerWithRegistry(
      { name },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      { databaseLayer: database, runEffectWorker: false },
    ),
  );
  const layer = Reactor.layer.pipe(Layer.provideMerge(runtime));

  const startTask = Effect.fn("wrapUpHarness.startTask")(function* (role: "reviewer" | "advisor") {
    const engine = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
    const parentId = ThreadId.make(`thread:${name}-parent`);
    const watchRunningTurn = (threadId: ThreadId, afterTurnId?: ProviderTurnId) =>
      engine.streamDomainEvents.pipe(
        Stream.filter(
          (event) =>
            event.threadId === threadId &&
            event.type === "provider-turn.updated" &&
            event.payload.status === "running" &&
            (afterTurnId === undefined || event.payload.id !== afterTurnId),
        ),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkScoped({ startImmediately: true }),
      );

    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${name}`),
      threadId: parentId,
      projectId: ProjectId.make("project:wrap-up"),
      title: "Lead",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
      createdBy: "user",
      creationSource: "web",
    });
    const parentRunning = yield* watchRunningTurn(parentId);
    yield* engine.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`lead:${name}`),
      threadId: parentId,
      messageId: MessageId.make(`message:${name}-lead`),
      text: "Review the Spec",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* worker.drain();
    yield* Fiber.join(parentRunning);
    yield* executor.withLock(parentId, Effect.void);

    const parentRun = (yield* engine.getThreadRecords(parentId, ["runs"])).runs[0]!;
    yield* engine.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make(`delegate:${name}`),
      parentThreadId: parentId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task: "Review",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      agentTask: {
        role,
        taskClass: "non-ui",
        workId: name,
        attemptId: "1",
        workspacePath: cwd,
        sourceRevision: "revision",
        requestFingerprint: "a".repeat(64),
        policyHash: "b".repeat(64),
        policyRevision: "test",
        briefHash: "c".repeat(64),
        sourceAccess: "read-only",
        toolProfile: "source-reader",
        requested: modelSelection,
        assigned: null,
        effective: modelSelection,
      },
      createdBy: "agent",
      creationSource: "mcp",
    });
    const task = (yield* engine.getThreadRecords(parentId, ["subagents"])).subagents[0]!;
    const childId = task.childThreadId!;
    const childRunning = yield* watchRunningTurn(childId);
    yield* worker.drain();
    yield* Fiber.join(childRunning);
    yield* executor.withLock(childId, Effect.void);

    return { taskId: task.id, childId, watchRunningTurn };
  });

  return { layer, started, steered, interrupted, startTask };
});

/** Records tool calls in the active child run and hands each to the reactor. */
const toolCalls = Effect.fn("wrapUp.toolCalls")(function* (
  childId: ThreadId,
  from: number,
  through: number,
  handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>,
) {
  const engine = yield* Orchestrator.OrchestratorV2;
  const sink = yield* EventSink.EventSinkV2;
  for (let index = from; index <= through; index += 1) {
    const run = (yield* engine.getThreadRecords(childId, ["runs"])).runs.find(
      (candidate) => candidate.status === "running",
    )!;
    const now = yield* DateTime.now;
    const event = {
      id: EventId.make(`event:${childId}-tool-${index}`),
      type: "turn-item.updated",
      threadId: childId,
      runId: run.id,
      occurredAt: now,
      payload: {
        id: TurnItemId.make(`turn-item:${childId}-tool-${index}`),
        threadId: childId,
        runId: run.id,
        nodeId: run.rootNodeId!,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: index,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "command_execution",
        input: `rg ${index}`,
      },
    } satisfies OrchestrationV2DomainEvent;
    yield* sink.write({ events: [event] });
    yield* handle(event);
  }
});

const wrapUps = Effect.fn("wrapUp.read")(function* (childId: ThreadId) {
  const { messages, runs, providerTurns } =
    yield* (yield* Orchestrator.OrchestratorV2).getThreadRecords(childId, [
      "messages",
      "runs",
      "providerTurns",
    ]);
  return {
    sent: messages.filter((message) => message.id.startsWith("message:reviewer-wrap-up:")),
    runs,
    providerTurns,
  };
});

/** Upstream labels a message another agent sent; the reviewer's own prompt keeps its text. */
const withoutSenderNote = (texts: ReadonlyArray<string>) =>
  texts.map((text) => text.replace(/^\[T3 Code: [^\]]*\]\n\n/, ""));

it.effect.each([
  { label: "mid-turn steering (Pi-like)", steer: true, restart: false },
  { label: "interrupt-restart (ACP-like)", steer: false, restart: true },
] as const)(
  "asks a reviewer once at threshold and restarts at 1.5x over $label, surviving restart",
  ({ label, steer, restart }) =>
    Effect.gen(function* () {
      const slug = label.replace(/[^a-z0-9]+/gi, "-");
      const { layer, started, steered, interrupted, startTask } = yield* wrapUpHarness(
        `reviewer-wrap-up-${slug}`,
        steer,
        restart,
      );
      yield* Effect.gen(function* () {
        const reactor = yield* Reactor.ReviewerWrapUpReactor;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
        const { taskId, childId, watchRunningTurn } = yield* startTask("reviewer");
        const childTurns = () =>
          started.filter((turn) => turn.providerThread.appThreadId === childId);
        const latestTurnId = Effect.map(
          wrapUps(childId),
          ({ providerTurns }) => providerTurns.at(-1)!.id,
        );

        yield* toolCalls(childId, 1, WRAP_UP_THRESHOLD - 1, reactor.handle);
        yield* worker.drain();
        assert.deepEqual((yield* wrapUps(childId)).sent, []);
        assert.deepEqual(steered, []);
        assert.lengthOf(childTurns(), 1);
        assert.lengthOf(interrupted, 0);

        const reportTurnId = yield* latestTurnId;
        const reportRestarted = steer ? null : yield* watchRunningTurn(childId, reportTurnId);
        yield* toolCalls(childId, WRAP_UP_THRESHOLD, WRAP_UP_THRESHOLD, reactor.handle);
        yield* worker.drain();
        if (reportRestarted !== null) {
          yield* Fiber.join(reportRestarted);
          yield* executor.withLock(childId, Effect.void);
        }

        const afterReport = yield* wrapUps(childId);
        assert.deepEqual(
          afterReport.sent.map((message) => message.id),
          [Reactor.wrapUpMessageId(taskId, "report")],
        );
        if (steer) {
          assert.deepEqual(steered, [afterReport.sent[0]!.text]);
          assert.lengthOf(childTurns(), 1);
          assert.lengthOf(interrupted, 0);
          assert.lengthOf(afterReport.runs, 1);
        } else {
          assert.deepEqual(steered, []);
          assert.lengthOf(interrupted, 1);
          assert.lengthOf(afterReport.runs, 1);
          assert.deepEqual(withoutSenderNote(childTurns().map((turn) => turn.message.text)), [
            "Review",
            afterReport.sent[0]!.text,
          ]);
        }

        // A fresh reactor (server restart) rebuilds the count and already-sent steps from DB.
        const restartedReactor = yield* Effect.service(Reactor.ReviewerWrapUpReactor).pipe(
          Effect.provide(Layer.fresh(Reactor.layer)),
        );
        const restartThreshold = Math.ceil(WRAP_UP_THRESHOLD * 1.5);
        yield* toolCalls(
          childId,
          WRAP_UP_THRESHOLD + 1,
          restartThreshold - 1,
          restartedReactor.handle,
        );
        yield* worker.drain();
        assert.lengthOf((yield* wrapUps(childId)).sent, 1);
        assert.lengthOf(steered, steer ? 1 : 0);
        assert.lengthOf(childTurns(), steer ? 1 : 2);

        const preRestartTurnId = yield* latestTurnId;
        const restartRunning = yield* watchRunningTurn(childId, preRestartTurnId);
        yield* toolCalls(childId, restartThreshold, restartThreshold, restartedReactor.handle);
        yield* worker.drain();
        yield* Fiber.join(restartRunning);
        yield* executor.withLock(childId, Effect.void);

        const afterRestart = yield* wrapUps(childId);
        assert.deepEqual(
          afterRestart.sent.map((message) => message.id),
          [Reactor.wrapUpMessageId(taskId, "report"), Reactor.wrapUpMessageId(taskId, "restart")],
        );
        if (steer) {
          assert.lengthOf(steered, 1);
          assert.lengthOf(interrupted, 1);
          assert.deepEqual(
            afterRestart.runs.map((run) => run.status),
            ["interrupted", "running"],
          );
          assert.deepEqual(withoutSenderNote(childTurns().map((turn) => turn.message.text)), [
            "Review",
            afterRestart.sent[1]!.text,
          ]);
        } else {
          assert.deepEqual(steered, []);
          assert.lengthOf(interrupted, 2);
          assert.lengthOf(afterRestart.runs, 1);
          assert.deepEqual(withoutSenderNote(childTurns().map((turn) => turn.message.text)), [
            "Review",
            afterRestart.sent[0]!.text,
            afterRestart.sent[1]!.text,
          ]);
        }

        // Extra tool calls—and another server restart—never trigger a third message.
        yield* toolCalls(
          childId,
          restartThreshold + 1,
          restartThreshold + 2,
          restartedReactor.handle,
        );
        const afterBothReactor = yield* Effect.service(Reactor.ReviewerWrapUpReactor).pipe(
          Effect.provide(Layer.fresh(Reactor.layer)),
        );
        yield* toolCalls(
          childId,
          restartThreshold + 3,
          restartThreshold + 3,
          afterBothReactor.handle,
        );
        yield* worker.drain();
        assert.lengthOf((yield* wrapUps(childId)).sent, 2);
        assert.lengthOf(childTurns(), steer ? 2 : 3);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("retries a report refused between turns on the next tool call", () =>
  Effect.gen(function* () {
    const { layer, steered, startTask } = yield* wrapUpHarness(
      "reviewer-wrap-up-retry",
      true,
      false,
    );
    yield* Effect.gen(function* () {
      const reactor = yield* Reactor.ReviewerWrapUpReactor;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const sink = yield* EventSink.EventSinkV2;
      const { taskId, childId } = yield* startTask("reviewer");
      const setTurn = Effect.fn("setTurn")(function* (status: "pending" | "running") {
        const turn = (yield* wrapUps(childId)).providerTurns.at(-1)!;
        yield* sink.write({
          events: [
            {
              id: EventId.make(`event:${childId}-turn-${status}`),
              type: "provider-turn.updated",
              threadId: childId,
              occurredAt: yield* DateTime.now,
              payload: { ...turn, status },
            },
          ],
        });
      });

      yield* toolCalls(childId, 1, WRAP_UP_THRESHOLD - 1, reactor.handle);
      yield* setTurn("pending");
      yield* toolCalls(childId, WRAP_UP_THRESHOLD, WRAP_UP_THRESHOLD, reactor.handle);
      yield* worker.drain();
      assert.deepEqual((yield* wrapUps(childId)).sent, []);

      yield* setTurn("running");
      yield* toolCalls(childId, WRAP_UP_THRESHOLD + 1, WRAP_UP_THRESHOLD + 1, reactor.handle);
      yield* worker.drain();
      assert.deepEqual(
        (yield* wrapUps(childId)).sent.map((message) => message.id),
        [Reactor.wrapUpMessageId(taskId, "report")],
      );
      assert.lengthOf(steered, 1);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("leaves every other role alone", () =>
  Effect.gen(function* () {
    const { layer, started, steered, interrupted, startTask } = yield* wrapUpHarness(
      "advisor-wrap-up-ignored",
      true,
      false,
    );
    yield* Effect.gen(function* () {
      const reactor = yield* Reactor.ReviewerWrapUpReactor;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const { childId } = yield* startTask("advisor");
      yield* toolCalls(childId, 1, Math.ceil(WRAP_UP_THRESHOLD * 1.5) + 4, reactor.handle);
      yield* worker.drain();
      assert.deepEqual((yield* wrapUps(childId)).sent, []);
      assert.deepEqual(steered, []);
      assert.lengthOf(interrupted, 0);
      assert.lengthOf(
        started.filter((turn) => turn.providerThread.appThreadId === childId),
        1,
      );
    }).pipe(Effect.provide(layer));
  }),
);
