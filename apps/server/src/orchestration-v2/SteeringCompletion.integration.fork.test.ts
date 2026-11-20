import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ScheduledTaskId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { SCHEDULED_TASK_NOTE } from "./ScheduledTaskPrompt.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const runSelection = {
  instanceId,
  model: "test-model",
  options: [{ id: "effort", value: "xhigh" }],
};
const nextTurnSelectionHarness = Effect.fn("nextTurnSelectionHarness")(function* (
  name: string,
  canRestart = false,
  canSteer = true,
  interruptTurn: Effect.Effect<void> = Effect.void,
  steeringAcceptsAttachments = true,
  nativeGoals?: boolean,
  onSteer: (
    turn: ProviderAdapter.ProviderAdapterV2SteerInput,
  ) => Effect.Effect<void, ProviderAdapter.ProviderAdapterV2Error> = () => Effect.void,
  extraAdapters: ReadonlyArray<ProviderAdapter.ProviderAdapterV2["Service"]> = [],
) {
  const driver = ProviderDriverKind.make(nativeGoals === undefined ? "codex" : "opencode");
  const cwd = yield* checkpointWorkspace(name);
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const started: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
  const steered: string[] = [];
  const steeredSelections: Array<ModelSelection | undefined> = [];
  const interrupted: ProviderTurnId[] = [];
  const capabilities = {
    ...CodexProviderCapabilitiesV2,
    turns: {
      ...CodexProviderCapabilitiesV2.turns,
      supportsActiveSteering: canSteer,
      supportsSteeringByInterruptRestart: canRestart,
      activeSteeringAcceptsAttachments: steeringAcceptsAttachments,
      ...(nativeGoals === undefined ? {} : { supportsNativeGoals: nativeGoals }),
    },
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
            model: runSelection.model,
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
              nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
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
              steeredSelections.push(turn.modelSelection);
            }).pipe(Effect.andThen(onSteer(turn))),
          interruptTurn: ({ providerTurnId }) =>
            Effect.sync(() => {
              interrupted.push(providerTurnId);
            }).pipe(
              Effect.andThen(interruptTurn),
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
  const layer = ProviderReplayHarness.layerWithRegistry(
    { name },
    ProviderAdapterRegistry.layerFromAdapters([adapter, ...extraAdapters]),
    { runEffectWorker: false },
  );
  const startFirstTurn = Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const threadId = ThreadId.make(`thread:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId,
      projectId: ProjectId.make(`project:${name}`),
      title: "Steer with changed options",
      modelSelection: runSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
      createdBy: "user",
      creationSource: "web",
    });
    const running = yield* orchestrator.streamDomainEvents.pipe(
      Stream.filter(
        (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
      ),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    );
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("first"),
      threadId,
      messageId: MessageId.make("message:first"),
      text: "first",
      attachments: [],
      modelSelection: runSelection,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    yield* worker.drain();
    yield* Fiber.join(running);
    // Ingestion checks turn ownership under this lock after committing the running turn.
    yield* (yield* ThreadCommandExecutor.ThreadCommandExecutor).withLock(threadId, Effect.void);
    return threadId;
  });
  return { cwd, events, started, steered, steeredSelections, interrupted, layer, startFirstTurn };
});

it.effect("frames a scheduled prompt steered into the running turn", () =>
  Effect.gen(function* () {
    const { started, steered, layer, startFirstTurn } = yield* nextTurnSelectionHarness(
      "steering-scheduled-prompt",
    );
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const threadId = yield* startFirstTurn;
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("scheduled-steer"),
        threadId,
        messageId: MessageId.make("message:scheduled-steer"),
        scheduledTaskId: ScheduledTaskId.make("heartbeat"),
        text: "Check the release.",
        attachments: [],
        modelSelection: runSelection,
        dispatchMode: { type: "steer_active", targetRunId: started[0]!.runId },
        createdBy: "agent",
        creationSource: "mcp",
      });
      yield* worker.drain();
    }).pipe(Effect.provide(layer));

    assert.lengthOf(steered, 1);
    assert.isTrue(steered[0]!.startsWith(SCHEDULED_TASK_NOTE));
    assert.isTrue(steered[0]!.endsWith("Scheduled task prompt:\nCheck the release."));
  }),
);
