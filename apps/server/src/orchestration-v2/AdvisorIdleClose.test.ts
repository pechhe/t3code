import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Orchestrator from "./Orchestrator.ts";
import * as EventSink from "./EventSink.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Reactor from "./AdvisorIdleCloseReactor.ts";
import * as ServerSettings from "../serverSettings.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider needed"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const testLayer = (minutes: number | null) => {
  const database = Sqlite.layerMemory;
  const runtime = ProviderReplayHarness.layerWithRegistry(
    { name: "advisor-idle-close" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false, advisorIdleCloseMinutes: minutes },
  );
  return Reactor.layer.pipe(
    Layer.provideMerge(runtime),
    Layer.provide(database),
    Layer.provide(ServerSettings.layerTest({ delegation: { advisorIdleCloseMinutes: minutes } })),
  );
};
const seed = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const sink = yield* EventSink.EventSinkV2;
  const parentId = ThreadId.make("thread:idle-parent");
  yield* engine.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-parent"),
    threadId: parentId,
    projectId: ProjectId.make("project:idle"),
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
    commandId: CommandId.make("parent-turn"),
    threadId: parentId,
    messageId: MessageId.make("parent-message"),
    text: "Ask advisor",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  const parent = yield* engine.getThreadRecords(parentId, ["runs"]);
  const run = parent.runs[0]!;
  const binding = {
    role: "advisor" as const,
    taskClass: "non-ui" as const,
    workId: "work",
    attemptId: "1",
    workspacePath: "/fixture/advisor",
    sourceRevision: "revision-one",
    requestFingerprint: "a".repeat(64),
    policyHash: "b".repeat(64),
    policyRevision: "test",
    briefHash: "c".repeat(64),
    sourceAccess: "read-only" as const,
    toolProfile: "source-reader" as const,
    requested: modelSelection,
    assigned: null,
    effective: modelSelection,
  };
  yield* engine.dispatch({
    type: "delegated_task.request",
    commandId: CommandId.make("delegate-advisor"),
    parentThreadId: parentId,
    parentRunId: run.id,
    parentNodeId: run.rootNodeId!,
    task: "Advise",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    agentTask: binding,
    createdBy: "agent",
    creationSource: "mcp",
  });
  const task = (yield* engine.getThreadRecords(parentId, ["subagents"])).subagents[0]!;
  const childId = task.childThreadId!;
  const childRun = (yield* engine.getThreadRecords(childId, ["runs"])).runs[0]!;
  const now = yield* DateTime.now;
  const complete = (state: "pending" | "delivered" | "acknowledged") =>
    sink.write({
      events: [
        {
          id: EventId.make(`child-${state}`),
          type: "run.updated" as const,
          threadId: childId,
          occurredAt: now,
          payload: { ...childRun, status: "completed" as const, completedAt: now },
        },
        {
          id: EventId.make(`task-${state}`),
          type: "subagent.updated" as const,
          threadId: parentId,
          occurredAt: now,
          payload: {
            ...task,
            status: "completed" as const,
            result: "Advice",
            completedAt: now,
            updatedAt: now,
            completionDelivery: { state, observedByRunId: null },
          },
        },
      ],
    });
  return { engine, sink, childId, childRun, task, complete };
});

it.effect("closes delivered idle advisors durably, keeps history and refuses new follow-ups", () =>
  Effect.gen(function* () {
    const f = yield* seed;
    yield* f.complete("delivered");
    const reactor = yield* Reactor.AdvisorIdleCloseReactor;
    yield* TestClock.adjust("59 seconds");
    yield* reactor.sweep;
    assert.isUndefined((yield* f.engine.getThreadRecords(f.childId, [])).thread.advisorClosedAt);
    yield* TestClock.adjust("2 seconds");
    yield* reactor.sweep;
    const child = yield* f.engine.getThreadRecords(f.childId, ["runs"]);
    assert.isDefined(child.thread.advisorClosedAt);
    assert.equal(child.runs.length, 1);
    assert.isDefined((yield* f.engine.getThreadShell(f.childId))?.advisorClosedAt);
    const parent = yield* f.engine.getThreadRecords(f.task.threadId, ["subagents"]);
    assert.equal(parent.subagents[0]?.completionDelivery?.state, "disposed");
    const error = yield* f.engine
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("closed-followup"),
        threadId: f.childId,
        messageId: MessageId.make("closed-followup"),
        text: "More",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "agent",
        creationSource: "mcp",
      })
      .pipe(Effect.flip);
    assert.equal(error._tag, "OrchestratorDispatchError");
    if (error._tag === "OrchestratorDispatchError")
      assert.include(String(error.cause), "Start a new advisor");
  }).pipe(Effect.provide(testLayer(1))),
);

it.effect.each(["off", "undelivered", "running", "followup"] as const)(
  "does not close an advisor that is %s",
  (scenario) =>
    Effect.gen(function* () {
      const f = yield* seed;
      if (scenario !== "running")
        yield* f.complete(scenario === "undelivered" ? "pending" : "acknowledged");
      yield* TestClock.adjust("2 minutes");
      if (scenario === "followup")
        yield* f.engine.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("new-followup"),
          threadId: f.childId,
          messageId: MessageId.make("new-followup"),
          text: "More",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "agent",
          creationSource: "mcp",
        });
      yield* (yield* Reactor.AdvisorIdleCloseReactor).sweep;
      assert.isUndefined((yield* f.engine.getThreadRecords(f.childId, [])).thread.advisorClosedAt);
    }).pipe(Effect.provide(testLayer(scenario === "off" ? null : 1))),
);

it.effect(
  "external result observation survives reads and does not keep extending the idle deadline",
  () =>
    Effect.gen(function* () {
      const f = yield* seed;
      yield* f.complete("delivered");
      const { thread } = yield* f.engine.getThreadRecords(f.childId, []);
      const now = yield* DateTime.now;
      yield* f.sink.write({
        events: [
          {
            id: EventId.make("external-advisor"),
            type: "thread.metadata-updated",
            threadId: f.childId,
            occurredAt: now,
            payload: {
              ...thread,
              lineage: { ...thread.lineage, parentThreadId: null, relationshipToParent: null },
            },
          },
        ],
      });
      yield* TestClock.adjust("2 minutes");
      yield* (yield* Reactor.AdvisorIdleCloseReactor).sweep;
      assert.isUndefined((yield* f.engine.getThreadRecords(f.childId, [])).thread.advisorClosedAt);
      yield* f.engine.dispatch({
        type: "advisor.result.observe",
        commandId: CommandId.make("observe-external"),
        threadId: f.childId,
        runId: f.childRun.id,
      });
      const observed = (yield* f.engine.getThreadRecords(f.childId, [])).thread
        .advisorResultObserved!;
      yield* TestClock.adjust("30 seconds");
      yield* f.engine.dispatch({
        type: "advisor.result.observe",
        commandId: CommandId.make("observe-external-again"),
        threadId: f.childId,
        runId: f.childRun.id,
      });
      assert.deepEqual(
        (yield* f.engine.getThreadRecords(f.childId, [])).thread.advisorResultObserved,
        observed,
      );
      yield* TestClock.adjust("31 seconds");
      yield* (yield* Reactor.AdvisorIdleCloseReactor).sweep;
      assert.isDefined((yield* f.engine.getThreadRecords(f.childId, [])).thread.advisorClosedAt);
    }).pipe(Effect.provide(testLayer(1))),
);
