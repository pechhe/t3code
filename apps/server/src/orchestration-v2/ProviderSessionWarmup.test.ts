import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as WorkspaceCustody from "../workspace/WorkspaceCustody.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderSessionWarmup from "./ProviderSessionWarmup.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const driver = ProviderDriverKind.make("codex");
const warmInstance = ProviderInstanceId.make("codex-warm");
const otherInstance = ProviderInstanceId.make("codex-other");
const selectionOn = (instanceId: ProviderInstanceId) =>
  ({ instanceId, model: "warm-model" }) satisfies ModelSelection;
// One session per thread, as for providers that cannot share a process between threads.
const exclusive: OrchestrationV2ProviderCapabilities = {
  ...CodexProviderCapabilitiesV2,
  sessions: {
    ...CodexProviderCapabilitiesV2.sessions,
    supportsMultipleProviderThreadsPerSession: false,
  },
};

interface Counts {
  readonly opened: ReadonlyArray<string>;
  readonly closed: number;
  /** Ahead of the first message: baselines taken, and process identities learned, by directory. */
  readonly baselines: ReadonlyArray<string>;
  readonly primed: ReadonlyArray<string>;
}

const makeAdapter = (
  counts: Ref.Ref<Counts>,
  instanceId: ProviderInstanceId,
): ProviderAdapter.ProviderAdapterV2["Service"] => ({
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(exclusive),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: (input) =>
    Effect.gen(function* () {
      yield* Ref.update(counts, (current) => ({
        ...current,
        opened: [...current.opened, input.providerSessionId],
      }));
      yield* Effect.addFinalizer(() =>
        Ref.update(counts, (current) => ({ ...current, closed: current.closed + 1 })),
      );
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const now = yield* DateTime.now;
      const providerSession: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver,
        providerInstanceId: instanceId,
        status: "ready",
        cwd: input.runtimePolicy.cwd ?? "/fallback",
        model: input.modelSelection.model,
        capabilities: exclusive,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      return {
        instanceId,
        driver,
        providerSessionId: input.providerSessionId,
        providerSession,
        getOwnedProcessIds: () => Effect.succeed([{ pid: 4242 }]),
        events: Stream.fromQueue(events),
        ensureThread: (threadInput) =>
          Effect.gen(function* () {
            const createdAt = yield* DateTime.now;
            return {
              id: ProviderThreadId.make(`provider-thread:${threadInput.threadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: threadInput.threadId,
              ownerNodeId: null,
              nativeThreadRef: {
                driver,
                nativeId: `native-thread:${threadInput.threadId}`,
                strength: "strong",
              },
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
        startTurn: (turn) =>
          Effect.gen(function* () {
            const occurredAt = yield* DateTime.now;
            const providerTurnId = ProviderTurnId.make(`provider-turn:${turn.attemptId}`);
            yield* Queue.offer(events, {
              type: "provider_turn.updated",
              driver,
              providerTurn: {
                id: providerTurnId,
                providerThreadId: turn.providerThread.id,
                nodeId: turn.rootNodeId,
                runAttemptId: turn.attemptId,
                nativeTurnRef: { driver, nativeId: `native:${providerTurnId}`, strength: "strong" },
                ordinal: turn.providerTurnOrdinal,
                status: "completed",
                startedAt: occurredAt,
                completedAt: occurredAt,
              },
            });
            yield* Queue.offer(events, {
              type: "turn.terminal",
              driver,
              providerThreadId: turn.providerThread.id,
              providerTurnId,
              runOrdinal: turn.runOrdinal,
              status: "completed",
              failure: null,
              threadDisposition: "reusable",
            });
          }),
        steerTurn: () => Effect.void,
        interruptTurn: () => Effect.void,
        respondToRuntimeRequest: () => Effect.void,
        readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
        rollbackThread: () => Effect.die("unused rollbackThread"),
        forkThread: () => Effect.die("unused forkThread"),
      };
    }),
});

const firstSession = (instanceId: ProviderInstanceId, threadId: ThreadId) =>
  IdAllocator.derive.firstProviderSession({ providerInstanceId: instanceId, threadId });

type Services =
  | Orchestrator.OrchestratorV2
  | EffectWorker.OrchestrationEffectWorkerV2
  | ProviderSessionManager.ProviderSessionManagerV2
  | ProviderSessionWarmup.ProviderSessionWarmup;

const withHarness = <A, E>(
  name: string,
  body: (counts: Ref.Ref<Counts>) => Effect.Effect<A, E, Services>,
) =>
  Effect.gen(function* () {
    const counts = yield* Ref.make<Counts>({ opened: [], closed: 0, baselines: [], primed: [] });
    const database = SqlitePersistence.layerMemory;
    const runtime = ProviderReplayHarness.layerWithRegistry(
      { name },
      ProviderAdapterRegistry.layerFromAdapters([
        makeAdapter(counts, warmInstance),
        makeAdapter(counts, otherInstance),
      ]),
      { databaseLayer: database },
    );
    const warmup = ProviderSessionWarmup.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          runtime,
          ProviderAdapterRegistry.layerFromAdapters([
            makeAdapter(counts, warmInstance),
            makeAdapter(counts, otherInstance),
          ]),
          ProjectionStore.layer.pipe(Layer.provide(database)),
          RuntimePolicy.layer.pipe(Layer.provide(ServerSettings.layerTest())),
          IdAllocator.layer,
          Layer.mock(CheckpointService.CheckpointServiceV2)({
            captureFirstRunBaseline: ({ threadId, cwd }) =>
              Ref.update(counts, (current) => ({
                ...current,
                baselines: [...current.baselines, `${threadId}@${cwd}`],
              })),
          }),
          Layer.mock(WorkspaceCustody.WorkspaceCustody)({
            primeControllers: (projectRoot, pids) =>
              Ref.update(counts, (current) => ({
                ...current,
                primed: [...current.primed, `${projectRoot}:${pids.join(",")}`],
              })),
          }),
        ),
      ),
    );
    return yield* body(counts).pipe(Effect.provide(Layer.merge(runtime, warmup)));
  });

const createThread = (threadId: ThreadId, cwd: string, instanceId = warmInstance) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:${threadId}:create`),
      threadId,
      projectId: ProjectId.make("project:warmup"),
      title: "Warm",
      modelSelection: selectionOn(instanceId),
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
    });
  });

const sendFirst = (threadId: ThreadId, instanceId: ProviderInstanceId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:${threadId}:first`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:first`),
      text: "hello",
      attachments: [],
      modelSelection: selectionOn(instanceId),
      dispatchMode: { type: "start_immediately" },
    });
    yield* worker.drain();
    return yield* orchestrator.getThreadProjection(threadId);
  });

it.live("starts the first turn in the session opened ahead, not a second one", () =>
  Effect.gen(function* () {
    const cwd = yield* checkpointWorkspace("warmup-reuse");
    const threadId = ThreadId.make("thread:warmup-reuse");
    yield* withHarness("warmup-reuse", (counts) =>
      Effect.gen(function* () {
        yield* createThread(threadId, cwd);
        yield* (yield* ProviderSessionWarmup.ProviderSessionWarmup).warm(threadId, {
          captureBaseline: true,
        });
        const warmId = firstSession(warmInstance, threadId);
        const ahead = yield* Ref.get(counts);
        assert.deepEqual(ahead.opened, [warmId]);
        assert.deepEqual(ahead.baselines, [`${threadId}@${cwd}`]);
        assert.deepEqual(ahead.primed, [`${cwd}:4242`]);

        const projection = yield* sendFirst(threadId, warmInstance);
        assert.deepEqual((yield* Ref.get(counts)).opened, [warmId]);
        assert.equal(projection.providerThreads[0]?.providerSessionId, warmId);
      }),
    );
  }),
);

it.live("opens a fresh session when the first message uses another provider instance", () =>
  Effect.gen(function* () {
    const cwd = yield* checkpointWorkspace("warmup-other-instance");
    const threadId = ThreadId.make("thread:warmup-other-instance");
    yield* withHarness("warmup-other-instance", (counts) =>
      Effect.gen(function* () {
        yield* createThread(threadId, cwd);
        // A checkout that is not the thread's own keeps its baseline for Send.
        yield* (yield* ProviderSessionWarmup.ProviderSessionWarmup).warm(threadId, {
          captureBaseline: false,
        });
        assert.isEmpty((yield* Ref.get(counts)).baselines);
        const projection = yield* sendFirst(threadId, otherInstance);
        const warmId = firstSession(warmInstance, threadId);
        const freshId = firstSession(otherInstance, threadId);
        assert.deepEqual((yield* Ref.get(counts)).opened, [warmId, freshId]);
        assert.equal(projection.providerThreads[0]?.providerSessionId, freshId);
      }),
    );
  }),
);

it.live("closes the session opened ahead when the never-run thread is deleted", () =>
  Effect.gen(function* () {
    const cwd = yield* checkpointWorkspace("warmup-release");
    const threadId = ThreadId.make("thread:warmup-release");
    yield* withHarness("warmup-release", (counts) =>
      Effect.gen(function* () {
        const warmup = yield* ProviderSessionWarmup.ProviderSessionWarmup;
        const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
        yield* createThread(threadId, cwd);
        yield* warmup.warm(threadId, { captureBaseline: false });
        const warmId = firstSession(warmInstance, threadId);
        assert.isTrue(yield* sessions.isLive(warmId));

        yield* (yield* Orchestrator.OrchestratorV2).dispatch({
          type: "thread.delete",
          commandId: CommandId.make("command:warmup-release:delete"),
          threadId,
        });
        yield* warmup.release(threadId);
        assert.isFalse(yield* sessions.isLive(warmId));
        assert.equal((yield* Ref.get(counts)).closed, 1);
      }),
    );
  }),
);
