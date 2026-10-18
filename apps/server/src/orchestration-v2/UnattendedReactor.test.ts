import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { serverContinuationChainLength } from "./serverContinuation.ts";
import * as UnattendedReactor from "./UnattendedReactor.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = UnattendedReactor.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "unattended" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
);

const CONTINUATION = "message:unattended-continuation:";

const setup = Effect.fn(function* (name: string, unattended: boolean) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = ThreadId.make(`thread:${name}`);
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${name}`),
    threadId,
    projectId: ProjectId.make("project:unattended"),
    title: name,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* orchestrator.dispatch({
    type: "thread.metadata.update",
    commandId: CommandId.make(`workflow:${name}`),
    threadId,
    workflow: { kind: "lead", unattended },
  });
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`start:${name}`),
    threadId,
    messageId: MessageId.make(`message:${name}`),
    text: "Run the Spec",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  const run = (yield* projections.getThreadRecords(threadId, ["runs"])).runs[0]!;
  return { threadId, run };
});

/** Records the run as ended and returns the event the reactor sees. */
const finish = Effect.fn(function* (
  run: OrchestrationV2Run,
  status: "completed" | "failed" | "interrupted" = "completed",
  endedAt?: DateTime.Utc,
) {
  const now = endedAt ?? (yield* DateTime.now);
  const event = {
    id: EventId.make(`event:finish:${run.id}`),
    type: "run.updated",
    threadId: run.threadId,
    runId: run.id,
    occurredAt: now,
    payload: { ...run, status, startedAt: run.startedAt ?? now, completedAt: now },
  } satisfies OrchestrationV2DomainEvent;
  yield* (yield* EventSink.EventSinkV2).write({ events: [event] });
  return event;
});

/** Records a tool call in the run, which is what counts as the run having done work. */
const toolCall = Effect.fn(function* (run: OrchestrationV2Run) {
  const now = yield* DateTime.now;
  const nodeId = NodeId.make(`node:tool:${run.id}`);
  yield* (yield* EventSink.EventSinkV2).write({
    events: [
      {
        id: EventId.make(`event:tool:${run.id}`),
        type: "node.updated",
        threadId: run.threadId,
        runId: run.id,
        nodeId,
        occurredAt: now,
        payload: {
          id: nodeId,
          threadId: run.threadId,
          runId: run.id,
          parentNodeId: run.rootNodeId,
          rootNodeId: run.rootNodeId!,
          kind: "tool_call",
          status: "completed",
          countsForRun: true,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: now,
        },
      },
    ],
  });
});

const runs = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    return yield* projections.getThreadRecords(threadId, ["runs", "messages"]);
  });

const continuations = (threadId: ThreadId) =>
  Effect.map(runs(threadId), ({ runs }) =>
    runs.filter((run) => run.userMessageId.startsWith(CONTINUATION)),
  );

it.layer(layerTest)("UnattendedReactor", (it) => {
  it.effect("continues an unattended thread once after a completed run", () =>
    Effect.gen(function* () {
      const reactor = yield* UnattendedReactor.UnattendedReactor;
      const { threadId, run } = yield* setup("continue", true);
      const event = yield* finish(run);
      yield* reactor.handle(event);
      yield* reactor.handle(event);
      const queued = yield* continuations(threadId);
      assert.equal(queued.length, 1);
      const { messages } = yield* runs(threadId);
      const message = messages.find((candidate) => candidate.id === queued[0]!.userMessageId)!;
      assert.equal(message.createdBy, "agent");
      assert.include(message.text, "Continue the remaining work");
    }),
  );

  it.effect("leaves an attended thread, and a failed or interrupted run, alone", () =>
    Effect.gen(function* () {
      const reactor = yield* UnattendedReactor.UnattendedReactor;
      const attended = yield* setup("attended", false);
      yield* reactor.handle(yield* finish(attended.run));
      assert.equal((yield* continuations(attended.threadId)).length, 0);
      const failed = yield* setup("failed", true);
      yield* reactor.handle(yield* finish(failed.run, "failed"));
      assert.equal((yield* continuations(failed.threadId)).length, 0);
      const stopped = yield* setup("stopped", true);
      yield* reactor.handle(yield* finish(stopped.run, "interrupted"));
      assert.equal((yield* continuations(stopped.threadId)).length, 0);
    }),
  );

  it.effect("keeps going while continuations do work, up to three in a row", () =>
    Effect.gen(function* () {
      const reactor = yield* UnattendedReactor.UnattendedReactor;
      const { threadId, run } = yield* setup("chain", true);
      yield* reactor.handle(yield* finish(run));
      for (let step = 1; step <= 3; step += 1) {
        const latest = (yield* continuations(threadId)).at(-1)!;
        yield* toolCall(latest);
        yield* reactor.handle(yield* finish(latest));
        assert.equal((yield* continuations(threadId)).length, Math.min(step + 1, 3));
      }
    }),
  );

  it.effect("leaves a snoozed thread alone", () =>
    Effect.gen(function* () {
      const reactor = yield* UnattendedReactor.UnattendedReactor;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId, run } = yield* setup("snoozed", true);
      const later = DateTime.add(yield* DateTime.now, { hours: 1 });
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("snooze:snoozed"),
        threadId,
        snoozedUntil: DateTime.formatIso(later),
      });
      yield* reactor.handle(yield* finish(run));
      assert.equal((yield* continuations(threadId)).length, 0);
    }),
  );

  it.effect("waits while a delegated task or a thread watch will wake the thread", () =>
    Effect.gen(function* () {
      const reactor = yield* UnattendedReactor.UnattendedReactor;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const delegating = yield* setup("delegating", true);
      yield* orchestrator.dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make("delegate:delegating"),
        parentThreadId: delegating.threadId,
        parentRunId: delegating.run.id,
        parentNodeId: delegating.run.rootNodeId!,
        task: "Research the sources",
        completionWake: "settled_only",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "agent",
        creationSource: "mcp",
      });
      const parentRun = (yield* projections.getThreadRecords(delegating.threadId, ["runs"]))
        .runs[0]!;
      yield* reactor.handle(yield* finish(parentRun));
      assert.equal((yield* continuations(delegating.threadId)).length, 0);

      const watched = yield* setup("watched", false);
      const watching = yield* setup("watching", true);
      yield* orchestrator.dispatch({
        type: "thread.thread-watch",
        commandId: CommandId.make("watch:watching"),
        threadId: watching.threadId,
        watchedThreadId: watched.threadId,
        watching: true,
      });
      yield* reactor.handle(yield* finish(watching.run));
      assert.equal((yield* continuations(watching.threadId)).length, 0);
    }),
  );

  it.effect("yields to a message already queued behind the run", () =>
    Effect.gen(function* () {
      const reactor = yield* UnattendedReactor.UnattendedReactor;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId, run } = yield* setup("queued", true);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("queue:queued"),
        threadId,
        messageId: MessageId.make("message:queued:next"),
        text: "And then this",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
      yield* reactor.handle(yield* finish(run));
      assert.equal((yield* continuations(threadId)).length, 0);
    }),
  );

  it.effect("stops after a continuation run that did no work", () =>
    Effect.gen(function* () {
      const reactor = yield* UnattendedReactor.UnattendedReactor;
      const { threadId, run } = yield* setup("idle", true);
      yield* reactor.handle(yield* finish(run));
      const [continuation] = yield* continuations(threadId);
      yield* reactor.handle(yield* finish(continuation!));
      assert.equal((yield* continuations(threadId)).length, 1);
    }),
  );

  it.effect("continues a run that completed while the server was down from the sweep", () =>
    Effect.gen(function* () {
      const reactor = yield* UnattendedReactor.UnattendedReactor;
      const { threadId, run } = yield* setup("restart", true);
      yield* finish(run);
      yield* reactor.sweep;
      yield* reactor.sweep;
      assert.equal((yield* continuations(threadId)).length, 1);
    }),
  );

  it.effect("does not sweep up a run that ended long before the restart", () =>
    Effect.gen(function* () {
      const reactor = yield* UnattendedReactor.UnattendedReactor;
      const { threadId, run } = yield* setup("stale", true);
      yield* finish(run, "completed", DateTime.subtract(yield* DateTime.now, { hours: 2 }));
      yield* reactor.sweep;
      assert.equal((yield* continuations(threadId)).length, 0);
    }),
  );

  it.effect("answers a live question with the away answer, but not a fixed choice", () =>
    Effect.gen(function* () {
      const reactor = yield* UnattendedReactor.UnattendedReactor;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const ask = Effect.fn(function* (
        name: string,
        unattended: boolean,
        allowCustomAnswer?: false,
        kind: "user_input" | "command" = "user_input",
      ) {
        const { threadId, run } = yield* setup(name, unattended);
        const sessionId = ProviderSessionId.make(`session:${name}`);
        yield* projections.apply({
          id: EventId.make(`event:session:${name}`),
          type: "provider-session.attached",
          threadId,
          occurredAt: now,
          payload: {
            id: sessionId,
            driver: adapter.driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd: "/repo",
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
        });
        const requestId = RuntimeRequestId.make(`request:${name}`);
        const request = {
          id: EventId.make(`event:request:${name}`),
          type: "runtime-request.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: {
            id: requestId,
            nodeId: run.rootNodeId!,
            providerTurnId: null,
            nativeRequestRef: null,
            kind,
            status: "pending",
            responseCapability: { type: "live", providerSessionId: sessionId },
            createdAt: now,
            resolvedAt: null,
          },
        } satisfies OrchestrationV2DomainEvent;
        // Claude records the request before the item holding its questions.
        yield* eventSink.write({ events: [request] });
        yield* reactor.handle(request);
        const item = {
          id: EventId.make(`event:item:${name}`),
          type: "turn-item.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: {
            type: "user_input_request",
            id: TurnItemId.make(`item:${name}`),
            threadId,
            runId: run.id,
            nodeId: NodeId.make(`node:${name}`),
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "waiting",
            title: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            requestId,
            questions: [
              {
                id: "Which database?",
                header: "Database",
                question: "Which database?",
                options: [],
                ...(allowCustomAnswer === false ? { allowCustomAnswer } : {}),
              },
            ],
          },
        } satisfies OrchestrationV2DomainEvent;
        yield* eventSink.write({ events: [item] });
        yield* reactor.handle(item);
        const { runtimeRequests } = yield* projections.getThreadRecords(threadId, [
          "runtimeRequests",
        ]);
        return runtimeRequests.find((candidate) => candidate.id === requestId)!;
      });
      const answered = yield* ask("question", true);
      assert.equal(answered.status, "resolved");
      assert.include(String(answered.answers?.["Which database?"]), "The owner is away");
      assert.equal((yield* ask("question-attended", false)).status, "pending");
      assert.equal((yield* ask("question-fixed", true, false)).status, "pending");
      assert.equal((yield* ask("approval", true, undefined, "command")).status, "pending");
    }),
  );

  it.effect(
    "dismisses a question asked after the turn ended and answers it in the continuation",
    () =>
      Effect.gen(function* () {
        const reactor = yield* UnattendedReactor.UnattendedReactor;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const { threadId, run } = yield* setup("late-question", true);
        const requestId = RuntimeRequestId.make("request:late-question");
        yield* projections.apply({
          id: EventId.make("event:late-question"),
          type: "runtime-request.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: {
            id: requestId,
            nodeId: run.rootNodeId!,
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability: { type: "message" },
            createdAt: now,
            resolvedAt: null,
          },
        });
        yield* reactor.handle(yield* finish(run));
        const records = yield* projections.getThreadRecords(threadId, [
          "runtimeRequests",
          "runs",
          "messages",
        ]);
        assert.notEqual(
          records.runtimeRequests.find((request) => request.id === requestId)?.status,
          "pending",
        );
        const continuation = records.runs.find((candidate) =>
          candidate.userMessageId.startsWith(CONTINUATION),
        )!;
        const message = records.messages.find((m) => m.id === continuation.userMessageId)!;
        assert.include(message.text, "The owner is away");
        assert.equal(message.createdBy, "agent");
      }),
  );
});

it("counts restart and unattended continuations as one chain", () => {
  const at = (seconds: number) => DateTime.makeUnsafe(seconds * 1000);
  const run = (ordinal: number, message: string, restart?: boolean) =>
    ({
      id: RunId.make(`run:${ordinal}`),
      ordinal,
      userMessageId: MessageId.make(message),
      startedAt: at(ordinal),
      completedAt: at(ordinal + 0.5),
      ...(restart ? { restartContinuationOfRunId: RunId.make(`run:${ordinal - 1}`) } : {}),
    }) as OrchestrationV2Run;
  const history = [
    run(1, "message:user"),
    run(2, `${CONTINUATION}run:1`),
    run(3, "message:restart-continuation:run:2", true),
    run(4, `${CONTINUATION}run:3`),
  ];
  assert.equal(serverContinuationChainLength(history, history[3]!), 3);
  assert.equal(serverContinuationChainLength(history, history[1]!), 1);
  assert.equal(serverContinuationChainLength(history, history[0]!), 0);
});
