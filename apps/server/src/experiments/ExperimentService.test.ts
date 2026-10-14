import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  Experiment,
  ExperimentDefinition,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  MessageId,
  RunId,
  ThreadId,
  type ExperimentAssignInput,
  type ExperimentOutcomeInput,
  type ModelSelection,
  type OrchestrationV2Run,
  type TurnTokenUsage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Experiments from "./ExperimentService.ts";

const encodeExperiment = Schema.encodeSync(Schema.fromJsonString(Experiment));
const SchemaEncodeExpired = (value: typeof import("@t3tools/contracts").Experiment.Type) =>
  encodeExperiment({
    ...value,
    endsAt: "1900-01-01T00:00:00Z",
  });
const dependencies = ProjectionStore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
const layer = Experiments.layer.pipe(Layer.provideMerge(dependencies));
const modelSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
};
const definition = (id = "rollover"): ExperimentDefinition => ({
  id,
  title: "Natural stopping points",
  question: "Does earlier advice help?",
  lever: "rollover",
  primaryOutcome: "Verified completion",
  variants: [
    { id: "control", label: "Current", rollover: { softLimit: 220_000, hardLimit: 280_000 } },
    { id: "early", label: "Earlier", rollover: { softLimit: 180_000, hardLimit: 280_000 } },
  ],
  eligibility: { projectIds: [], models: [], taskCategories: [] },
  maxAssignments: 100,
  endsAt: "2999-01-01T00:00:00Z",
  stopConditions: ["Review constraint misses"],
  codeRevision: "commit:original",
  briefRevision: null,
});
const assignInput = (thread = "thread:1"): ExperimentAssignInput => ({
  threadId: ThreadId.make(thread),
  projectId: ProjectId.make("project:1"),
  modelSelection,
  unitKind: "thread",
  unitId: thread,
  enrollment: "new",
  unitCreatedAt: "2998-01-01T00:00:00Z",
});
const start = (id = "rollover") =>
  Effect.gen(function* () {
    const service = yield* Experiments.ExperimentService;
    yield* service.create(definition(id));
    return yield* service.transition({ experimentId: id, status: "running" });
  });

const addThread = Effect.fn(function* (id: string) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(id);
  yield* store.apply({
    id: EventId.make(`event:${id}:created`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("project:1"),
      title: id,
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
});
const addRunTurn = Effect.fn(function* (
  thread: string,
  suffix: string,
  usage: TurnTokenUsage | undefined,
  delegatedTask?: string,
  timing?: { requested: number; start: number; end: number },
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const startedAt = timing ? DateTime.makeUnsafe(timing.start) : now;
  const completedAt = timing ? DateTime.makeUnsafe(timing.end) : now;
  const requestedAt = timing ? DateTime.makeUnsafe(timing.requested) : now;
  const threadId = ThreadId.make(thread);
  const runId = RunId.make(`run:${suffix}`);
  const nodeId = NodeId.make(`node:${suffix}`);
  const providerThreadId = ProviderThreadId.make(`provider:${suffix}`);
  const run: OrchestrationV2Run = {
    id: runId,
    threadId,
    ordinal: Number(suffix.replace(/\D/g, "")) || 1,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    providerThreadId,
    userMessageId: MessageId.make(`message:${suffix}`),
    rootNodeId: nodeId,
    activeAttemptId: null,
    status: "completed",
    requestedAt,
    startedAt,
    completedAt,
    checkpointId: null,
    contextHandoffId: null,
    ...(delegatedTask ? { delegatedTaskId: NodeId.make(delegatedTask) } : {}),
  };
  yield* store.apply({
    id: EventId.make(`event:${suffix}:run`),
    type: "run.created",
    threadId,
    runId,
    nodeId,
    occurredAt: now,
    payload: run,
  });
  yield* store.apply({
    id: EventId.make(`event:${suffix}:node`),
    type: "node.updated",
    threadId,
    runId,
    nodeId,
    occurredAt: now,
    payload: {
      id: nodeId,
      threadId,
      runId,
      parentNodeId: null,
      rootNodeId: nodeId,
      kind: "root_turn",
      status: "completed",
      countsForRun: true,
      providerThreadId,
      providerTurnId: ProviderTurnId.make(`turn:${suffix}`),
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt,
      completedAt,
    },
  });
  yield* store.apply({
    id: EventId.make(`event:${suffix}:turn`),
    type: "provider-turn.updated",
    threadId,
    runId,
    nodeId,
    occurredAt: now,
    payload: {
      id: ProviderTurnId.make(`turn:${suffix}`),
      providerThreadId,
      nodeId,
      runAttemptId: null,
      nativeTurnRef: null,
      ordinal: 1,
      status: "completed",
      startedAt,
      completedAt,
      ...(usage ? { turnTokenUsage: usage } : {}),
    },
  });
  return { runId, nodeId };
});

describe("ExperimentService", () => {
  it.effect(
    "creates drafts and retains balanced immutable assignment across service reconstruction, pause and stop",
    () =>
      Effect.gen(function* () {
        const service = yield* Experiments.ExperimentService;
        assert.strictEqual((yield* service.create(definition())).status, "draft");
        assert.deepStrictEqual(yield* service.assign(assignInput()), []);
        yield* service.transition({ experimentId: "rollover", status: "running" });
        const first = (yield* service.assign(assignInput()))[0]!;
        const parallel = yield* Effect.all(
          Array.from({ length: 8 }, () => service.assign(assignInput())),
          { concurrency: "unbounded" },
        );
        assert.isTrue(parallel.every((items) => items[0]?.id === first.id));
        for (let index = 2; index <= 10; index++)
          yield* service.assign(assignInput(`thread:${index}`));
        const samples = yield* service.assignments({ experimentId: "rollover" });
        assert.strictEqual(samples.filter((s) => s.variant.id === "control").length, 5);
        assert.strictEqual(samples.filter((s) => s.variant.id === "early").length, 5);
        yield* service.transition({ experimentId: "rollover", status: "paused" });
        assert.deepStrictEqual(yield* service.assign(assignInput("new-while-paused")), []);
        // Rebuild the service over the same migrated DB, as after a server restart.
        const resumed = yield* Experiments.ExperimentService.pipe(
          Effect.provide(Experiments.layer),
        );
        assert.deepStrictEqual((yield* resumed.assign(assignInput()))[0], first);
        yield* service.transition({ experimentId: "rollover", status: "stopped" });
        assert.deepStrictEqual((yield* resumed.assign(assignInput()))[0], first);
        assert.deepStrictEqual(yield* resumed.assign(assignInput("new-while-stopped")), []);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("enforces cap, time, eligibility and refusal of conflicting running experiments", () =>
    Effect.gen(function* () {
      const service = yield* Experiments.ExperimentService;
      yield* service.create({
        ...definition(),
        maxAssignments: 1,
        eligibility: {
          projectIds: [ProjectId.make("project:1")],
          models: ["gpt-5.4"],
          taskCategories: [],
        },
      });
      yield* service.transition({ experimentId: "rollover", status: "running" });
      yield* service.create(definition("conflicting"));
      assert.strictEqual(
        (yield* Effect.flip(service.transition({ experimentId: "conflicting", status: "running" })))
          .reason,
        "conflict",
      );
      assert.deepStrictEqual(
        yield* service.assign({ ...assignInput(), unitCreatedAt: "1900-01-01T00:00:00Z" }),
        [],
      );
      assert.deepStrictEqual(
        yield* service.assign({ ...assignInput(), projectId: ProjectId.make("excluded") }),
        [],
      );
      assert.lengthOf(yield* service.assign(assignInput()), 1);
      assert.deepStrictEqual(yield* service.assign(assignInput("over-cap")), []);
      yield* service.transition({ experimentId: "rollover", status: "paused" });
      assert.strictEqual(
        (yield* Effect.flip(service.transition({ experimentId: "rollover", status: "running" })))
          .reason,
        "invalid-transition",
      );
      const sql = yield* SqlClient.SqlClient;
      yield* service.transition({ experimentId: "conflicting", status: "running" });
      // Simulates an end date reached without waiting on wall-clock time.
      const other = yield* service.list();
      const expired = other.find((e) => e.id === "conflicting")!;
      yield* sql`UPDATE experiments SET definition_json = ${SchemaEncodeExpired(expired)} WHERE id = 'conflicting'`;
      assert.deepStrictEqual(yield* service.assign(assignInput("after-end")), []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "keeps historical method, effective model and evidence separate from prospective randomization",
    () =>
      Effect.gen(function* () {
        const service = yield* Experiments.ExperimentService;
        const taskModel: ModelSelection = {
          instanceId: ProviderInstanceId.make("muse"),
          model: "wonder",
        };
        yield* service.create({
          ...definition("review"),
          lever: "reviewer",
          variants: [
            { id: "control", label: "Codex", modelSelection },
            { id: "early", label: "Muse", modelSelection: taskModel },
          ],
        });
        yield* service.transition({ experimentId: "review", status: "running" });
        const assigned = (yield* service.assignForTask({
          ...assignInput("future-child"),
          unitId: "task:1",
          taskLever: "reviewer",
        }))[0]!;
        assert.deepStrictEqual(assigned.assignedModelSelection, assigned.variant.modelSelection);
        yield* service.importHistorical({
          experimentId: "review",
          variantId: "early",
          unitId: "historical-task",
          threadId: ThreadId.make("old-thread"),
          projectId: ProjectId.make("project:1"),
          taskCategory: "review",
          assignedModelSelection: modelSelection,
          assignedAt: "2026-10-13T09:00:00Z",
          codeRevision: "old-code",
          briefRevision: "original-brief",
          provenance: "quota-fallback; original handwritten trial",
        });
        const historical = (yield* service.assignments({ experimentId: "review" })).find(
          (a) => a.enrollment === "historical",
        )!;
        const input: ExperimentOutcomeInput = {
          id: "finding",
          assignmentId: historical.id,
          runId: null,
          kind: "validated-finding",
          source: "human-review",
          evidence: ["issue:123"],
          note: "Independent fix confirms finding",
          actualModelSelection: modelSelection,
          fallbackReason: "quota",
        };
        assert.deepStrictEqual(
          yield* service.recordOutcome(input),
          yield* service.recordOutcome(input),
        );
        assert.strictEqual(
          (yield* Effect.flip(service.recordOutcome({ ...input, note: "rewritten" }))).reason,
          "conflict",
        );
        const report = yield* service.report({ experimentId: "review" });
        assert.strictEqual(report.randomizedCount, 1);
        assert.strictEqual(report.observationalCount, 1);
        assert.strictEqual(report.assignments[1]?.assignment.provenance, historical.provenance);
        assert.strictEqual(report.assignments[1]?.outcomes[0]?.fallbackReason, "quota");
        assert.strictEqual(report.assignments[0]?.usage.inputTokens, null);
        assert.strictEqual(report.assignments[0]?.projectionAvailable, false);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("reports partial usage without zero filling and keeps self-report labelled", () =>
    Effect.gen(function* () {
      yield* start();
      yield* addThread("thread:1");
      const service = yield* Experiments.ExperimentService;
      const assignment = (yield* service.assign(assignInput()))[0]!;
      yield* addRunTurn("thread:1", "1", {
        usageScope: "main_agent",
        usageStatus: "complete",
        inputTokens: 100,
        outputTokens: 20,
        reasoningTokens: 5,
        hasSubagents: false,
      });
      yield* addRunTurn("thread:1", "2", {
        usageScope: "main_agent",
        usageStatus: "partial",
        inputTokens: 50,
        hasSubagents: false,
      });
      yield* addRunTurn("thread:1", "3", undefined);
      yield* service.recordOutcome({
        id: "self-complete",
        assignmentId: assignment.id,
        runId: RunId.make("run:1"),
        kind: "verified-completion",
        source: "self-report",
        evidence: [],
        note: "Agent says done",
        actualModelSelection: null,
        fallbackReason: null,
      });
      yield* service.recordObservation({
        id: "soft:run:1",
        assignmentId: assignment.id,
        runId: RunId.make("run:1"),
        kind: "soft",
        usedTokens: 180_000,
        maxTokens: null,
        evidence: ["provider-turn:turn:1"],
      });
      const entry = (yield* service.report({ experimentId: "rollover" })).assignments[0]!;
      assert.lengthOf(entry.turns, 3);
      assert.lengthOf(entry.runs, 3);
      assert.strictEqual(entry.usage.status, "partial");
      assert.strictEqual(entry.usage.inputTokens, null);
      assert.strictEqual(entry.usage.outputTokens, null);
      assert.strictEqual(entry.usage.cachedInputTokens, null);
      assert.strictEqual(entry.usage.partialTurns, 1);
      assert.strictEqual(entry.usage.missingTurns, 1);
      assert.strictEqual(entry.outcomes[0]?.source, "self-report");
      assert.strictEqual(entry.observations[0]?.maxTokens, null);
      assert.strictEqual(entry.turns[0]?.modelSource, "run-selection");
    }).pipe(Effect.provide(layer)),
  );
  it.effect("aggregates only task-linked descendants and unions overlapping execution time", () =>
    Effect.gen(function* () {
      yield* start();
      yield* addThread("thread:1");
      yield* addThread("child");
      const service = yield* Experiments.ExperimentService;
      yield* service.assign(assignInput());
      const complete = (inputTokens: number, outputTokens: number): TurnTokenUsage => ({
        usageScope: "main_agent",
        usageStatus: "complete",
        inputTokens,
        outputTokens,
        hasSubagents: false,
      });
      const root = yield* addRunTurn("thread:1", "1", complete(100, 20), undefined, {
        requested: 1000,
        start: 3000,
        end: 13000,
      });
      yield* addRunTurn("child", "2", complete(50, 10), "task:child", {
        requested: 5000,
        start: 5000,
        end: 9000,
      });
      yield* addRunTurn("child", "3", complete(999, 999), "task:unrelated", {
        requested: 5000,
        start: 5000,
        end: 9000,
      });
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const child = {
        id: NodeId.make("task:child"),
        threadId: ThreadId.make("thread:1"),
        runId: root.runId,
        parentNodeId: root.nodeId,
        origin: "app_owned" as const,
        createdBy: "agent" as const,
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: modelSelection.instanceId,
        providerThreadId: null,
        childThreadId: ThreadId.make("child"),
        nativeTaskRef: null,
        prompt: "Delegate",
        title: "Child",
        model: "gpt-5.4",
        status: "completed" as const,
        result: "Done",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      };
      yield* store.apply({
        id: EventId.make("event:child"),
        type: "subagent.updated",
        threadId: child.threadId,
        runId: root.runId,
        nodeId: child.id,
        occurredAt: now,
        payload: child,
      });
      const entry = (yield* service.report({ experimentId: "rollover" })).assignments[0]!;
      assert.deepStrictEqual(
        entry.turns.map((t) => t.runId),
        [RunId.make("run:1"), RunId.make("run:2")],
      );
      assert.strictEqual(entry.usage.inputTokens, 150);
      assert.strictEqual(entry.usage.outputTokens, 30);
      assert.strictEqual(entry.wallClockMs, 12000);
      assert.strictEqual(entry.activeMs, 10000);
      assert.strictEqual(entry.waitMs, 2000);
      assert.strictEqual(entry.descendantCoverage, "complete");
      yield* store.apply({
        id: EventId.make("event:missing-child"),
        type: "subagent.updated",
        threadId: child.threadId,
        runId: root.runId,
        nodeId: NodeId.make("task:missing"),
        occurredAt: now,
        payload: {
          ...child,
          id: NodeId.make("task:missing"),
          childThreadId: ThreadId.make("missing-child"),
        },
      });
      const partial = (yield* service.report({ experimentId: "rollover" })).assignments[0]!;
      assert.strictEqual(partial.usage.status, "partial");
      assert.strictEqual(partial.descendantCoverage, "partial");
      assert.deepStrictEqual(partial.missingThreadIds, [ThreadId.make("missing-child")]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "explicit boundary enrollment excludes earlier runs and exposes report page counts",
    () =>
      Effect.gen(function* () {
        yield* start();
        yield* addThread("existing");
        const service = yield* Experiments.ExperimentService;
        yield* addRunTurn("existing", "1", undefined);
        const boundary = yield* addRunTurn("existing", "2", {
          usageScope: "main_agent",
          usageStatus: "complete",
          inputTokens: 7,
          outputTokens: 2,
          hasSubagents: false,
        });
        yield* service.assign({
          ...assignInput("existing"),
          enrollment: "existing-boundary",
          boundaryRunId: boundary.runId,
        });
        yield* service.assign(assignInput("next"));
        const first = yield* service.report({ experimentId: "rollover", limit: 1 });
        assert.strictEqual(first.totalAssignments, 2);
        assert.strictEqual(first.randomizedCount, 2);
        assert.strictEqual(first.hasMore, true);
        assert.lengthOf(first.assignments, 1);
        assert.deepStrictEqual(
          first.assignments[0]?.turns.map((t) => t.runId),
          [boundary.runId],
        );
        const last = yield* service.report({ experimentId: "rollover", offset: 1, limit: 1 });
        assert.strictEqual(last.offset, 1);
        assert.strictEqual(last.hasMore, false);
        assert.strictEqual(last.assignments[0]?.assignment.threadId, ThreadId.make("next"));
        assert.strictEqual(
          (yield* Effect.flip(
            service.create({
              ...definition("invalid"),
              variants: [{ id: "one", label: "bad", rollover: { softLimit: 10, hardLimit: 10 } }],
            }),
          )).reason,
          "invalid-definition",
        );
      }).pipe(Effect.provide(layer)),
  );
});
