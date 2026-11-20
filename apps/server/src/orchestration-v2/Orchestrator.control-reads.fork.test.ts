import * as AdviceService from "../agents/AdviceService.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as Threads from "./ThreadManagementService.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";

import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  CommandId,
  MessageId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import {
  request as agentTaskRequest,
  snapshot as agentPolicySnapshot,
} from "../agents/agentPolicy.testkit.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

declare module "node:sqlite" {
  interface StatementSync {
    // Node 26 has this; @types/node 24 does not declare it yet.
    stat(counter: "vmStep"): number;
  }
}

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for metadata controls"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const adviceAdapter = {
  ...adapter,
  openSession: (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      return {
        instanceId,
        driver: adapter.driver,
        providerSessionId: input.providerSessionId,
        providerSession: {
          id: input.providerSessionId,
          driver: adapter.driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: "/source",
          model: modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          extensionStatuses: [],
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
        events: Stream.never,
        ensureThread: () => Effect.die("No provider process needed for advice controls"),
        resumeThread: () => Effect.die("No provider process needed for advice controls"),
        startTurn: () => Effect.die("No provider process needed for advice controls"),
        steerTurn: () => Effect.die("No provider process needed for advice controls"),
        interruptTurn: () => Effect.die("No provider process needed for advice controls"),
        respondToRuntimeRequest: () => Effect.die("No provider process needed for advice controls"),
        readThreadSnapshot: () => Effect.die("No provider process needed for advice controls"),
        rollbackThread: () => Effect.die("No provider process needed for advice controls"),
        forkThread: () => Effect.die("No provider process needed for advice controls"),
      } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
    }),
};
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "control-reads" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const layerAdviceTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "advice-controls" },
    ProviderAdapterRegistry.layerFromAdapters([adviceAdapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const completeAndSnoozeThread = Effect.fn("test.completeAndSnoozeThread")(function* (
  name: string,
  snoozeMinutes: number,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = ThreadId.make(`thread:${name}`);
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create-${name}`),
    threadId,
    projectId: ProjectId.make(`project:${name}`),
    title: "Snoozed completion",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`dispatch-${name}`),
    threadId,
    messageId: MessageId.make(`dispatch-${name}`),
    text: "Run in the background",
    attachments: [],
    dispatchMode: { type: "defer_start" },
    createdBy: "agent",
    creationSource: "mcp",
  });
  yield* orchestrator.dispatch({
    type: "run.interrupt",
    commandId: CommandId.make(`interrupt-${name}`),
    threadId,
    runId: (yield* projections.getThreadProjection(threadId)).runs[0]!.id,
  });
  const completedAt = (yield* projections.getThreadProjection(threadId)).runs.at(-1)?.completedAt;
  assert.ok(completedAt);
  yield* TestClock.adjust("1 second");
  const snoozedUntil = DateTime.add(yield* DateTime.now, { minutes: snoozeMinutes });
  yield* orchestrator.dispatch({
    type: "thread.snooze",
    commandId: CommandId.make(`snooze-${name}`),
    threadId,
    snoozedUntil: DateTime.formatIso(snoozedUntil),
  });
  return { threadId, completedAt, snoozedUntil };
});

it.effect("mark unread clears a pending read-on-completion marker", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const { threadId, completedAt, snoozedUntil } = yield* completeAndSnoozeThread(
      "mark-unread-clears-marker",
      60,
    );
    const pendingRunId = RunId.make("run:mark-unread-clears-marker:pending");
    yield* orchestrator.dispatch({
      type: "thread.mark-read",
      commandId: CommandId.make("read-on-completion"),
      threadId,
      whenRunCompletes: pendingRunId,
    });
    assert.equal((yield* projections.getThread(threadId)).readOnCompletionRunId, pendingRunId);

    yield* orchestrator.dispatch({
      type: "thread.mark-unread",
      commandId: CommandId.make("mark-unread-clears-marker"),
      threadId,
    });
    const cleared = yield* projections.getThread(threadId);
    assert.isNull(cleared.readOnCompletionRunId);
    // A marker the dismissed wake could no longer settle is retired with the visit rewind.
    assert.deepEqual(cleared.lastVisitedAt, DateTime.subtract(completedAt, { milliseconds: 1 }));
    assert.deepEqual(cleared.snoozedUntil, snoozedUntil);
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "parent advice steers running turns for blocking and nonblocking requests, queues before a turn, and starts idle parents",
  () =>
    Effect.gen(function* () {
      const engine = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const policy = agentPolicySnapshot();
      const managed = {
        ...agentTaskRequest({ role: "scout", workspacePath: "/source", sourceRevision: "source" }),
        requestFingerprint: "c".repeat(64),
        policyHash: policy.hash,
        policyRevision: policy.sourceRevision,
        briefHash: policy.briefs.implementer.hash,
        sourceAccess: "read-only" as const,
        toolProfile: "source-reader" as const,
        requested: modelSelection,
        assigned: null,
        effective: modelSelection,
      };
      const scope = (threadId: ThreadId): McpInvocationScope => ({
        environmentId: EnvironmentId.make("advice-environment"),
        capabilities: new Set(["orchestration"]),
        issuedAt: 0,
        requestNamespace: threadId,
        client: undefined,
        thread: {
          threadId,
          providerInstanceId: instanceId,
          providerSessionId: `session:${threadId}`,
        },
      });
      for (const scenario of [
        { status: "running", blocking: true },
        { status: "running", blocking: false },
        { status: "preparing", blocking: true },
        { status: "waiting", blocking: true },
        { status: "completed", blocking: true },
        { status: "completed", blocking: false },
      ] as const) {
        const { status: parentState, blocking } = scenario;
        const state = `${parentState}:${blocking}`;
        const parentId = ThreadId.make(`advice-parent:${state}`);
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`advice-create:${state}`),
          threadId: parentId,
          projectId: ProjectId.make("advice-project"),
          title: "Parent",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* engine.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`advice-start:${state}`),
          threadId: parentId,
          messageId: MessageId.make(`advice-message:${state}`),
          text: "Work",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const parentRun = (yield* projections.getThreadRecords(parentId, ["runs"])).runs[0]!;
        yield* engine.dispatch({
          type: "delegated_task.request",
          commandId: CommandId.make(`advice-delegate:${state}`),
          parentThreadId: parentId,
          parentRunId: parentRun.id,
          parentNodeId: parentRun.rootNodeId!,
          task: "Investigate",
          agentTask: managed,
          completionWake: "settled_only",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          createdBy: "agent",
          creationSource: "mcp",
        });
        const task = (yield* projections.getThreadRecords(parentId, ["subagents"])).subagents[0]!;
        yield* sink.write({
          events: [
            {
              id: EventId.make(`advice-parent-state:${state}`),
              type: "run.updated",
              threadId: parentId,
              runId: parentRun.id,
              occurredAt: now,
              payload: {
                ...parentRun,
                status: parentState,
                ...(parentState === "completed" ? { completedAt: now } : {}),
              },
            },
          ],
        });
        if (parentState === "running") {
          const providerThread = (yield* projections.getThreadProjection(
            parentId,
          )).providerThreads.find((thread) => thread.id === parentRun.providerThreadId)!;
          const sessionId = ProviderSessionId.make(`advice-session:${state}`);
          yield* (yield* ProviderSessionManager.ProviderSessionManagerV2).open({
            threadId: parentId,
            providerSessionId: sessionId,
            modelSelection,
            runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
          });
          yield* sink.write({
            events: [
              {
                id: EventId.make(`advice-provider-thread:${state}`),
                type: "provider-thread.updated",
                threadId: parentId,
                occurredAt: now,
                payload: { ...providerThread, providerSessionId: sessionId },
              },
            ],
          });
          yield* sink.write({
            events: [
              {
                id: EventId.make(`advice-parent-turn:${state}`),
                type: "provider-turn.updated",
                threadId: parentId,
                runId: parentRun.id,
                occurredAt: now,
                payload: {
                  id: ProviderTurnId.make(`advice-parent-turn:${state}`),
                  providerThreadId: parentRun.providerThreadId!,
                  nodeId: parentRun.rootNodeId!,
                  runAttemptId: parentRun.activeAttemptId!,
                  nativeTurnRef: {
                    driver: ProviderDriverKind.make("codex"),
                    nativeId: state,
                    strength: "strong",
                  },
                  ordinal: 1,
                  status: "running",
                  startedAt: now,
                  completedAt: null,
                },
              },
            ],
          });
        }
        yield* Effect.gen(function* () {
          const advice = yield* AdviceService.AdviceService;
          const request = {
            question: "Which contract?",
            evidence: "Two callers disagree.",
            recommendation: "Keep v1.",
            blocking,
          };
          const accepted = yield* advice.ask(scope(task.childThreadId!), "contract", request);
          yield* advice.ask(scope(task.childThreadId!), "contract", request);
          const requestedParent = yield* projections.getThreadProjection(parentId);
          const requestMessage = requestedParent.messages.find(
            (message) => message.senderThreadId === task.childThreadId,
          )!;
          if (parentState === "running") {
            assert.equal(accepted.delivery, "delivered");
            assert.isFalse(
              requestedParent.runs.some((run) => run.userMessageId === requestMessage.id),
            );
            assert.equal(
              requestedParent.runs.find((run) => run.id === parentRun.id)!.status,
              "running",
            );
            const outbox = yield* EffectOutbox.EffectOutboxV2;
            const effects = yield* outbox.listByCommandId(
              CommandId.make(`command:${requestMessage.id.slice("message:".length)}`),
            );
            assert.isTrue(effects.some((effect) => effect.request.type === "provider-turn.steer"));
          } else if (parentState !== "completed") {
            assert.equal(accepted.delivery, "pending");
          }
          const yielded = (yield* projections.getThreadRecords(task.childThreadId!, [
            "runs",
          ])).runs.find((run) => run.status !== "queued")!;
          yield* sink.write({
            events: [
              {
                id: EventId.make(`advice-yield:${state}`),
                type: "run.updated",
                threadId: task.childThreadId!,
                runId: yielded.id,
                occurredAt: now,
                payload: { ...yielded, status: "completed", completedAt: now },
              },
            ],
          });
          if (blocking) {
            const publication = {
              guardDelegatedCompletion: { threadId: task.childThreadId!, runId: yielded.id },
              events: [
                {
                  id: EventId.make(`stale-advice-publication:${state}`),
                  type: "subagent.updated" as const,
                  threadId: parentId,
                  occurredAt: now,
                  payload: {
                    ...task,
                    status: "completed" as const,
                    result: "Premature result",
                    completedAt: now,
                    updatedAt: now,
                  },
                },
              ],
              effects: [],
            };
            assert.isEmpty(yield* sink.writeWithEffects(publication));
          }
          yield* engine.recoverDelegatedTask(task.childThreadId!, yielded.id);
          const settledTask = (yield* projections.getThreadRecords(parentId, [
            "subagents",
          ])).subagents.find((candidate) => candidate.id === task.id)!;
          if (!blocking) {
            assert.isNotNull(settledTask.result);
            const late = yield* engine
              .dispatch({
                type: "message.dispatch",
                adviceDelivery: {
                  workerThreadId: task.childThreadId!,
                  runId: yielded.id,
                  blocking: true,
                },
                commandId: CommandId.make(`completed-advice:${state}`),
                threadId: task.childThreadId!,
                messageId: MessageId.make(`completed-advice:${state}`),
                text: "Late",
                attachments: [],
                dispatchMode: { type: "queue_after_active" },
                createdBy: "agent",
                creationSource: "server",
              })
              .pipe(Effect.flip);
            assert.equal(late._tag, "OrchestratorDispatchError");
            yield* advice.recover();
            const disposedParent = yield* projections.getThreadProjection(parentId);
            const disposedWakes = disposedParent.messages.filter(
              (message) => message.senderThreadId === task.childThreadId,
            );
            assert.equal(disposedWakes.length, 1);
            assert.isFalse(
              disposedParent.runs.some(
                (run) => run.status === "queued" && run.userMessageId === disposedWakes[0]!.id,
              ),
            );
            assert.equal(
              (yield* advice.read(scope(task.childThreadId!), task.childThreadId!, "contract"))
                .status,
              "cancelled",
            );
            assert.equal(
              (yield* advice
                .answer(scope(parentId), task.childThreadId!, "contract", "Late")
                .pipe(Effect.flip)).code,
              "capability_denied",
            );
            return;
          }
          assert.isNull(settledTask.result);
          const parent = yield* projections.getThreadProjection(parentId);
          const wakes = parent.messages.filter(
            (message) => message.senderThreadId === task.childThreadId,
          );
          assert.equal(wakes.length, 1);
          assert.equal(wakes[0]!.senderThreadId, task.childThreadId);
          assert.isEmpty(parent.runtimeRequests);
          assert.isEmpty(
            (yield* projections.getThreadRecords(task.childThreadId!, ["runtimeRequests"]))
              .runtimeRequests,
          );
          const wakeRun = parent.runs.find((run) => run.userMessageId === wakes[0]!.id);
          if (parentState === "running") assert.isUndefined(wakeRun);
          else if (parentState === "completed")
            assert.include(["preparing", "starting", "running"], wakeRun!.status);
          else assert.equal(wakeRun!.status, "queued");
          yield* advice.answer(scope(parentId), task.childThreadId!, "contract", "Keep v1.");
          yield* advice.answer(scope(parentId), task.childThreadId!, "contract", "Keep v1.");
          assert.isFalse(
            (yield* projections.getThreadRecords(parentId, ["runs"])).runs.some(
              (run) => run.userMessageId === wakes[0]!.id && run.status === "queued",
            ),
          );
          const child = yield* projections.getThreadProjection(task.childThreadId!);
          assert.equal(
            child.messages.filter((message) =>
              message.text.includes("Advice contract from your parent"),
            ).length,
            1,
          );
          assert.isEmpty(child.runtimeRequests);
          if (parentState === "completed") {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`UPDATE advice_consultations SET answer_delivered = 0 WHERE worker_thread_id = ${task.childThreadId!} AND request_id = 'contract'`;
            const replyRun = child.runs
              .filter((run) => run.status !== "queued")
              .toSorted((a, b) => b.ordinal - a.ordinal)[0]!;
            yield* sink.write({
              events: [
                {
                  id: EventId.make(`advice-reply-finished:${state}`),
                  type: "run.updated",
                  threadId: task.childThreadId!,
                  runId: replyRun.id,
                  occurredAt: now,
                  payload: { ...replyRun, status: "completed", completedAt: now },
                },
              ],
            });
            yield* engine.recoverDelegatedTask(task.childThreadId!, replyRun.id);
            assert.isNull(
              (yield* projections.getThreadRecords(parentId, ["subagents"])).subagents.find(
                (candidate) => candidate.id === task.id,
              )!.result,
            );
            yield* advice.recover();
            assert.isNotNull(
              (yield* projections.getThreadRecords(parentId, ["subagents"])).subagents.find(
                (candidate) => candidate.id === task.id,
              )!.result,
            );
            const completedTask = (yield* projections.getThreadRecords(parentId, [
              "subagents",
            ])).subagents.find((candidate) => candidate.id === task.id)!;
            const result = completedTask.result;
            assert.isNotNull(result);
            const completionDelivery = completedTask.completionDelivery;
            assert.isDefined(completionDelivery);
            yield* advice.recover();
            const recovered = (yield* projections.getThreadRecords(parentId, [
              "subagents",
            ])).subagents.find((candidate) => candidate.id === task.id)!;
            assert.equal(recovered.result, result);
            assert.deepEqual(recovered.completionDelivery, completionDelivery);
            return;
          }
          yield* advice.ask(scope(task.childThreadId!), "cancel-hold", {
            ...request,
            question: "Should the follow-on migration preserve the old index?",
          });
          const cancelRun = (yield* projections.getThreadRecords(task.childThreadId!, [
            "runs",
          ])).runs
            .filter((run) => run.status !== "queued")
            .toSorted((a, b) => b.ordinal - a.ordinal)[0]!;
          yield* sink.write({
            events: [
              {
                id: EventId.make(`advice-cancel-yield:${state}`),
                type: "run.updated",
                threadId: task.childThreadId!,
                runId: cancelRun.id,
                occurredAt: now,
                payload: { ...cancelRun, status: "completed", completedAt: now },
              },
            ],
          });
          yield* engine.recoverDelegatedTask(task.childThreadId!, cancelRun.id);
          assert.isNull(
            (yield* projections.getThreadRecords(parentId, ["subagents"])).subagents.find(
              (candidate) => candidate.id === task.id,
            )!.result,
          );
          yield* advice.cancel(scope(parentId), task.childThreadId!, "cancel-hold");
          yield* advice.recover();
          const afterCancel = yield* projections.getThreadProjection(parentId);
          const cancelWakes = afterCancel.messages.filter(
            (message) =>
              message.senderThreadId === task.childThreadId && message.id.includes("cancel-hold"),
          );
          assert.equal(cancelWakes.length, 1);
          assert.isFalse(
            afterCancel.runs.some(
              (run) => run.userMessageId === cancelWakes[0]!.id && run.status === "queued",
            ),
          );
          assert.isNotNull(
            (yield* projections.getThreadRecords(parentId, ["subagents"])).subagents.find(
              (candidate) => candidate.id === task.id,
            )!.result,
          );
          yield* engine.dispatch({
            type: "thread.stop",
            commandId: CommandId.make(`advice-stop:${state}`),
            threadId: task.childThreadId!,
          });
          const rejected = yield* engine
            .dispatch({
              type: "message.dispatch",
              adviceDelivery: { workerThreadId: task.childThreadId!, runId: null, blocking: true },
              commandId: CommandId.make(`late-advice:${state}`),
              threadId: task.childThreadId!,
              messageId: MessageId.make(`late-advice:${state}`),
              text: "Late advice",
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              createdBy: "agent",
              creationSource: "server",
            })
            .pipe(Effect.flip);
          assert.equal(rejected._tag, "OrchestratorDispatchError");
          assert.isFalse(
            (yield* projections.getThreadRecords(task.childThreadId!, ["messages"])).messages.some(
              (message) => message.id === `late-advice:${state}`,
            ),
          );
        }).pipe(
          Effect.provide(
            AdviceService.layer.pipe(
              Layer.provide(
                Layer.mock(Threads.ThreadManagementService)({
                  getThreadShell: engine.getThreadShell,
                  getThreadRecords: engine.getThreadRecords,
                  dispatch: engine.dispatch,
                  streamDomainEvents: engine.streamDomainEvents,
                  recoverDelegatedTask: engine.recoverDelegatedTask,
                  delegatedTaskResultPending: engine.delegatedTaskResultPending,
                }),
              ),
            ),
          ),
        );
      }
    }).pipe(Effect.provide(layerAdviceTest)),
);
