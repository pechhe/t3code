import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
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
  type AgentTaskBinding,
  type ExperimentAssignInput,
  type ExperimentOutcomeInput,
  type ModelSelection,
  type OrchestrationV2Run,
  type TurnTokenUsage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ManagedAgent from "../agents/ManagedAgentService.ts";
import * as Experiments from "./ExperimentService.ts";
import {
  claudeModel,
  codexModel,
  changeReview,
  request as agentTaskRequest,
  snapshot as agentPolicySnapshot,
} from "../agents/agentPolicy.testkit.ts";

const encodeExperiment = Schema.encodeSync(Schema.fromJsonString(Experiment));
const SchemaEncodeExpired = (value: typeof import("@t3tools/contracts").Experiment.Type) =>
  encodeExperiment({
    ...value,
    endsAt: "1900-01-01T00:00:00Z",
  });
/** Rewrites a stored reviewer definition as it was before typed review scope existed. */
const storeAsUnscopedLegacy = (experimentId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      definition_json: string;
    }>`SELECT definition_json FROM experiments WHERE id = ${experimentId}`;
    const stored = JSON.parse(rows[0]!.definition_json);
    delete stored.eligibility.reviewScopes;
    yield* sql`UPDATE experiments SET definition_json = ${JSON.stringify(stored)} WHERE id = ${experimentId}`;
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
const externalOwner = (clientSessionId = "client:owner", externalSessionKey = "a".repeat(64)) => ({
  environmentId: EnvironmentId.make("environment:1"),
  clientSessionId,
  externalSessionKey,
  projectId: ProjectId.make("project:1"),
  ceiling: "full-access" as const,
});
const externalBinding = (owner = externalOwner(), attemptId = "attempt:1"): AgentTaskBinding => {
  const policy = agentPolicySnapshot();
  const task = agentTaskRequest({ workId: "work:shared", attemptId });
  return {
    ...task,
    requestFingerprint: "c".repeat(64),
    policyHash: policy.hash,
    policyRevision: policy.sourceRevision,
    briefHash: policy.briefs[task.role]!.hash,
    sourceAccess: "scoped-write",
    toolProfile: "implementation",
    requested: modelSelection,
    assigned: null,
    effective: modelSelection,
    externalOwner: owner,
  };
};
const externalDefinition = (): ExperimentDefinition => ({
  ...definition("external-delegation"),
  lever: "delegation",
  variants: [
    { id: "baseline", label: "Baseline", modelSelection },
    {
      id: "alternate",
      label: "Alternate",
      modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "claude-sonnet" },
    },
  ],
  eligibility: { projectIds: [], models: [], taskCategories: ["implementation"] },
});
const assignExternalAttempt = (
  service: Experiments.ExperimentService["Service"],
  thread: string,
  owner = externalOwner(),
  attemptId = "attempt:1",
) =>
  service.assign({
    agentTask: externalBinding(owner, attemptId),
    threadId: ThreadId.make(thread),
    projectId: ProjectId.make("project:1"),
    modelSelection,
    unitKind: "task",
    unitId: `external-work:${owner.externalSessionKey}:work:shared`,
    taskCategory: "implementation",
    taskLever: "delegation",
    enrollment: "new",
    unitCreatedAt: "2998-01-01T00:00:00Z",
  });
const addExternalWorkRows = Effect.fn(function* (
  owner: ReturnType<typeof externalOwner>,
  attempts: ReadonlyArray<{
    readonly taskId: string;
    readonly attemptId: string;
    readonly threadId: string;
  }>,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO external_agent_sessions (session_key, client_session_id, external_session_id, payload_json)
    VALUES (${owner.externalSessionKey}, ${owner.clientSessionId}, ${"external-session"}, ${"{}"})`;
  for (const attempt of attempts) {
    yield* sql`INSERT INTO external_agent_work (
      task_id, session_key, work_id, attempt_id, request_id, thread_id, fingerprint, payload_json, state
    ) VALUES (
      ${attempt.taskId}, ${owner.externalSessionKey}, ${"work:shared"}, ${attempt.attemptId},
      ${`request:${attempt.attemptId}`}, ${attempt.threadId}, ${"d".repeat(64)}, ${"{}"}, ${"accepted"}
    )`;
  }
});
const start = (id = "rollover") =>
  Effect.gen(function* () {
    const service = yield* Experiments.ExperimentService;
    yield* service.create(definition(id));
    return yield* service.transition({ experimentId: id, status: "running" });
  });

const addThread = Effect.fn(function* (id: string, parent?: string) {
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
      lineage: {
        parentThreadId: parent ? ThreadId.make(parent) : null,
        relationshipToParent: parent ? "subagent" : null,
        rootThreadId: parent ? ThreadId.make(parent) : threadId,
      },
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
          eligibility: { ...definition().eligibility, reviewScopes: ["change"] },
        });
        // The original trial predates typed review scope; its unscoped tasks still enroll.
        yield* storeAsUnscopedLegacy("review");
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
      yield* service.recordObservation({
        id: "native:run:1",
        assignmentId: assignment.id,
        runId: RunId.make("run:1"),
        kind: "native-compaction",
        usedTokens: null,
        maxTokens: null,
        evidence: ["provider:compaction-event"],
      });
      const entry = (yield* service.report({ experimentId: "rollover" })).assignments[0]!;
      assert.strictEqual(entry.observations[1]?.usedTokens, null);
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
  it.effect("splits a thread's runs at a setup cut point", () =>
    Effect.gen(function* () {
      yield* start();
      yield* addThread("thread:1");
      const service = yield* Experiments.ExperimentService;
      const assignment = (yield* service.assign(assignInput()))[0]!;
      const timing = (at: number) => ({ requested: at, start: at, end: at + 1 });
      yield* addRunTurn("thread:1", "1", undefined, undefined, timing(1_000));
      yield* addRunTurn("thread:1", "2", undefined, undefined, timing(2_000));
      yield* addRunTurn("thread:1", "3", undefined, undefined, timing(3_000));
      yield* service.recordObservation({
        id: "setup-change:run:2",
        assignmentId: assignment.id,
        runId: RunId.make("run:2"),
        kind: "setup-change",
        usedTokens: null,
        maxTokens: null,
        setupChanges: [{ subject: "agent-config", from: "aaa", to: "bbb" }],
        evidence: ["run-setup:run:1", "run-setup:run:2"],
      });
      // A rollover episode whose continuation starts after the cut.
      for (const [id, runId] of [
        ["capture:before", "run:1"],
        ["capture:after", "run:2"],
      ] as const)
        yield* service.recordEvidence({
          id,
          assignmentId: assignment.id,
          episodeId: "episode:spanning",
          recipeRevision: "rollover-v1",
          runId: RunId.make(runId),
          phase: "after",
          source: "runtime",
          artifacts: [],
          missing: ["history-unavailable"],
        });
      const entry = (yield* service.report({ experimentId: "rollover" })).assignments[0]!;
      assert.deepEqual(
        (entry.episodes ?? []).map((episode) => [episode.setupSegment, episode.captureIds]),
        [
          [0, ["capture:before"]],
          [1, ["capture:after"]],
        ],
      );
      assert.deepEqual(
        entry.runs.map((run) => `${run.runId}:${run.setupSegment}`),
        ["run:1:0", "run:2:1", "run:3:1"],
      );
      assert.deepEqual(entry.observations[0]?.setupChanges, [
        { subject: "agent-config", from: "aaa", to: "bbb" },
      ]);
    }).pipe(Effect.provide(layer)),
  );
  it.effect(
    "scopes external assignment, outcome and report reads to the owning session and reuses the assignment on a paused retry",
    () =>
      Effect.gen(function* () {
        const service = yield* Experiments.ExperimentService;
        yield* service.create(externalDefinition());
        yield* service.transition({ experimentId: "external-delegation", status: "running" });
        yield* addThread("external-attempt-1");
        yield* addThread("external-attempt-2");
        yield* addThread("external-unrelated");
        const ownedAttemptRun = yield* addRunTurn("external-attempt-2", "202", undefined);
        const unrelatedRun = yield* addRunTurn("external-unrelated", "203", undefined);
        const owner = externalOwner();
        const foreign = { ...owner, clientSessionId: "client:other" };
        yield* addExternalWorkRows(owner, [
          { taskId: "stored-attempt-1", attemptId: "attempt:1", threadId: "external-attempt-1" },
          { taskId: "stored-attempt-2", attemptId: "attempt:2", threadId: "external-attempt-2" },
        ]);

        const first = (yield* assignExternalAttempt(service, "external-attempt-1", owner))[0]!;
        yield* service.transition({ experimentId: "external-delegation", status: "paused" });
        const retry = (yield* assignExternalAttempt(
          service,
          "external-attempt-2",
          owner,
          "attempt:2",
        ))[0]!;
        assert.strictEqual(retry.id, first.id);
        assert.strictEqual(retry.threadId, first.threadId);

        assert.lengthOf(
          yield* service.assignments({ experimentId: "external-delegation" }, owner),
          1,
        );
        assert.lengthOf(
          yield* service.assignments({ experimentId: "external-delegation" }, foreign),
          0,
        );
        const outcome: ExperimentOutcomeInput = {
          id: "external-outcome",
          assignmentId: first.id,
          runId: null,
          kind: "verified-completion",
          source: "self-report",
          evidence: [],
          note: "External agent reports completion.",
          actualModelSelection: null,
          fallbackReason: null,
        };
        assert.strictEqual(
          (yield* Effect.flip(service.recordOutcome(outcome, foreign))).reason,
          "not-found",
        );
        assert.strictEqual(
          (yield* Effect.flip(
            service.recordOutcome(
              {
                ...outcome,
                id: "external-independent-claim",
                source: "independent-evidence",
                evidence: ["Agent supplied a claim"],
              },
              owner,
            ),
          )).reason,
          "invalid-evidence",
        );
        assert.strictEqual(
          (yield* Effect.flip(
            service.recordOutcome(
              { ...outcome, id: "external-unrelated-run", runId: unrelatedRun.runId },
              owner,
            ),
          )).reason,
          "invalid-evidence",
        );
        const accepted = yield* service.recordOutcome(
          { ...outcome, id: "external-owned-attempt-run", runId: ownedAttemptRun.runId },
          owner,
        );
        assert.strictEqual(accepted.runId, ownedAttemptRun.runId);

        const trustedInternal = yield* service.recordOutcome({
          ...outcome,
          id: "internal-trusted-outcome",
          runId: unrelatedRun.runId,
          source: "human-review",
          evidence: ["internal review"],
        });
        assert.strictEqual(trustedInternal.runId, unrelatedRun.runId);

        const hidden = yield* service.report({ experimentId: "external-delegation" }, foreign);
        assert.strictEqual(hidden.totalAssignments, 0);
        assert.lengthOf(hidden.assignments, 0);
        const visible = yield* service.report({ experimentId: "external-delegation" }, owner);
        assert.strictEqual(visible.totalAssignments, 1);
        assert.strictEqual(visible.assignments[0]?.assignment.id, first.id);
        assert.strictEqual(visible.assignments[0]?.outcomes[0]?.source, "self-report");
      }).pipe(Effect.provide(layer)),
  );
  it.effect("aggregates external attempt usage once and unions parallel elapsed time", () =>
    Effect.gen(function* () {
      const service = yield* Experiments.ExperimentService;
      yield* service.create(externalDefinition());
      yield* service.transition({ experimentId: "external-delegation", status: "running" });
      yield* addThread("external-attempt-1");
      yield* addThread("external-attempt-2");
      const owner = externalOwner();
      yield* addExternalWorkRows(owner, [
        { taskId: "stored-attempt-1", attemptId: "attempt:1", threadId: "external-attempt-1" },
        { taskId: "stored-attempt-2", attemptId: "attempt:2", threadId: "external-attempt-2" },
      ]);
      const assignment = (yield* assignExternalAttempt(service, "external-attempt-1", owner))[0]!;
      const base = Date.parse("2026-01-01T00:00:00.000Z");
      const usage = (inputTokens: number, outputTokens: number): TurnTokenUsage => ({
        usageScope: "main_agent",
        usageStatus: "complete",
        inputTokens,
        outputTokens,
        hasSubagents: false,
      });
      yield* addRunTurn("external-attempt-1", "101", usage(100, 10), undefined, {
        requested: base,
        start: base + 1_000,
        end: base + 11_000,
      });
      yield* addRunTurn("external-attempt-2", "102", usage(50, 5), undefined, {
        requested: base + 5_000,
        start: base + 6_000,
        end: base + 16_000,
      });

      const entry = (yield* service.report({ experimentId: "external-delegation" }, owner))
        .assignments[0]!;
      assert.strictEqual(entry.assignment.id, assignment.id);
      assert.lengthOf(entry.runs, 2);
      assert.lengthOf(entry.turns, 2);
      assert.strictEqual(entry.usage.inputTokens, 150);
      assert.strictEqual(entry.usage.outputTokens, 15);
      assert.strictEqual(entry.wallClockMs, 16_000);
      assert.strictEqual(entry.activeMs, 15_000);
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
  it.effect(
    "resolves only prospective randomized rollover policy without enrolling or using history",
    () =>
      Effect.gen(function* () {
        const service = yield* Experiments.ExperimentService;
        yield* service.create(definition("history"));
        yield* service.importHistorical({
          experimentId: "history",
          variantId: "early",
          unitId: "thread:1",
          threadId: ThreadId.make("thread:1"),
          projectId: ProjectId.make("project:1"),
          taskCategory: null,
          assignedModelSelection: modelSelection,
          assignedAt: "2020-01-01T00:00:00Z",
          codeRevision: null,
          briefRevision: null,
          provenance: "Original observational policy",
        });
        assert.strictEqual(yield* service.getRolloverAssignment(ThreadId.make("thread:1")), null);
        assert.lengthOf(yield* service.assignments({ threadId: ThreadId.make("thread:1") }), 1);
        yield* start();
        const recorded = (yield* service.assign(assignInput()))[0]!;
        assert.deepStrictEqual(
          yield* service.getRolloverAssignment(ThreadId.make("thread:1")),
          recorded,
        );
        yield* service.transition({ experimentId: "rollover", status: "paused" });
        assert.deepStrictEqual(
          yield* service.getRolloverAssignment(ThreadId.make("thread:1")),
          recorded,
        );
        yield* service.transition({ experimentId: "rollover", status: "stopped" });
        assert.deepStrictEqual(
          yield* service.getRolloverAssignment(ThreadId.make("thread:1")),
          recorded,
        );
        assert.strictEqual(yield* service.getRolloverAssignment(ThreadId.make("unassigned")), null);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "reports descendant and ancestor treatments but excludes future and unrelated task exposure",
    () =>
      Effect.gen(function* () {
        const service = yield* Experiments.ExperimentService;
        yield* start();
        yield* addThread("thread:1");
        yield* addThread("child", "thread:1");
        const rollover = (yield* service.assign(assignInput()))[0]!;
        yield* service.create({
          ...definition("review"),
          lever: "reviewer",
          variants: [
            { id: "control", label: "Control", modelSelection },
            {
              id: "early",
              label: "Alternative",
              modelSelection: { ...modelSelection, model: "gpt-5.5" },
            },
          ],
          eligibility: { ...definition().eligibility, reviewScopes: ["change"] },
        });
        yield* storeAsUnscopedLegacy("review");
        yield* service.transition({ experimentId: "review", status: "running" });
        const review = (yield* service.assignForTask({
          ...assignInput("child"),
          unitId: "task:child",
          taskLever: "reviewer",
        }))[0]!;
        const unrelated = (yield* service.assignForTask({
          ...assignInput("child"),
          unitId: "task:unrelated",
          taskLever: "reviewer",
        }))[0]!;
        const now = yield* DateTime.now;
        const base = DateTime.toEpochMillis(now);
        const complete: TurnTokenUsage = {
          usageScope: "main_agent",
          usageStatus: "complete",
          inputTokens: 10,
          outputTokens: 2,
          hasSubagents: false,
        };
        const root = yield* addRunTurn("thread:1", "1", complete, undefined, {
          requested: base,
          start: base,
          end: base + 10000,
        });
        yield* addRunTurn("child", "2", complete, "task:child", {
          requested: base + 1000,
          start: base + 1000,
          end: base + 5000,
        });
        yield* addRunTurn("child", "3", complete, "task:unrelated", {
          requested: base + 15000,
          start: base + 15000,
          end: base + 20000,
        });
        const store = yield* ProjectionStore.ProjectionStoreV2;
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
          prompt: "Review",
          title: "Review",
          model: "gpt-5.4",
          status: "completed" as const,
          result: "Done",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        };
        yield* store.apply({
          id: EventId.make("event:exposure-child"),
          type: "subagent.updated",
          threadId: child.threadId,
          runId: root.runId,
          nodeId: child.id,
          occurredAt: now,
          payload: child,
        });
        yield* TestClock.setTime(base + 30000);
        const future = (yield* service.assign(assignInput("child")))[0]!;
        const parentReport = (yield* service.report({ experimentId: "rollover" })).assignments.find(
          (entry) => entry.assignment.id === rollover.id,
        )!;
        assert.deepStrictEqual(parentReport.coExposureIds, [review.id]);
        assert.notInclude(parentReport.coExposureIds, unrelated.id);
        assert.notInclude(parentReport.coExposureIds, future.id);
        const childReport = (yield* service.report({ experimentId: "review" })).assignments.find(
          (entry) => entry.assignment.id === review.id,
        )!;
        assert.deepStrictEqual(childReport.coExposureIds, [rollover.id]);
        assert.notInclude(childReport.coExposureIds, unrelated.id);
        assert.notInclude(childReport.coExposureIds, future.id);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "does not report complete token totals or execution timing when a started run has no turn evidence",
    () =>
      Effect.gen(function* () {
        yield* start();
        yield* addThread("thread:1");
        const service = yield* Experiments.ExperimentService;
        yield* service.assign(assignInput());
        const complete: TurnTokenUsage = {
          usageScope: "main_agent",
          usageStatus: "complete",
          inputTokens: 100,
          outputTokens: 20,
          hasSubagents: false,
        };
        yield* addRunTurn("thread:1", "1", complete);
        yield* addRunTurn("thread:1", "2", complete);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM orchestration_v2_projection_provider_turns WHERE provider_turn_id = 'turn:2'`;
        const missing = (yield* service.report({ experimentId: "rollover" })).assignments[0]!;
        assert.lengthOf(missing.runs, 2);
        assert.lengthOf(missing.turns, 1);
        assert.strictEqual(missing.usage.status, "partial");
        assert.strictEqual(missing.usage.missingTurns, 1);
        assert.strictEqual(missing.usage.inputTokens, null);
        assert.strictEqual(missing.usage.outputTokens, null);
        assert.strictEqual(missing.activeMs, null);
        assert.strictEqual(missing.waitMs, null);
        // A run cancelled before execution has no provider turn and does not hide billed usage.
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const records = yield* store.getThreadRecords(ThreadId.make("thread:1"), ["runs"]);
        const neverStarted = records.runs.find((run) => run.id === RunId.make("run:2"))!;
        yield* store.apply({
          id: EventId.make("event:never-started-cancelled"),
          type: "run.updated",
          threadId: ThreadId.make("thread:1"),
          runId: neverStarted.id,
          occurredAt: yield* DateTime.now,
          payload: { ...neverStarted, status: "cancelled", startedAt: null },
        });
        const cancelled = (yield* service.report({ experimentId: "rollover" })).assignments[0]!;
        assert.strictEqual(cancelled.runs[1]?.status, "cancelled");
        assert.strictEqual(cancelled.usage.status, "complete");
        assert.strictEqual(cancelled.usage.inputTokens, 100);
      }).pipe(Effect.provide(layer)),
  );
});

describe("ExperimentService trial admission against the managed policy", () => {
  const withPolicy = Experiments.layer.pipe(
    Layer.provide(
      Layer.mock(ManagedAgent.ManagedAgentService)({
        snapshot: () => Effect.succeed(agentPolicySnapshot()),
      }),
    ),
    Layer.provideMerge(dependencies),
  );
  const trial = (id: string, second: ModelSelection): ExperimentDefinition => ({
    ...externalDefinition(),
    id,
    variants: [
      {
        id: "baseline",
        label: "Baseline",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: codexModel },
      },
      { id: "alternate", label: "Alternate", modelSelection: second },
    ],
  });
  const claude = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: claudeModel,
  } satisfies ModelSelection;
  const unlisted = { instanceId: ProviderInstanceId.make("codex"), model: "unlisted-model" };

  it.effect("refuses a trial arm no pool allows and accepts one the pools allow", () =>
    Effect.gen(function* () {
      const service = yield* Experiments.ExperimentService;
      const refused = yield* Effect.flip(service.create(trial("unlisted", unlisted)));
      assert.strictEqual(refused.reason, "invalid-definition");
      assert.strictEqual((yield* service.create(trial("allowed", claude))).status, "draft");
    }).pipe(Effect.provide(withPolicy)),
  );

  it.effect("leaves trial creation unchanged when no managed policy is configured", () =>
    Effect.gen(function* () {
      const service = yield* Experiments.ExperimentService;
      assert.strictEqual((yield* service.create(trial("no-policy", unlisted))).status, "draft");
    }).pipe(Effect.provide(layer)),
  );
});

describe("ExperimentService review scope", () => {
  const reviewerBinding = (scope?: "change" | "spec"): AgentTaskBinding => {
    const policy = agentPolicySnapshot();
    const task = agentTaskRequest({
      role: scope === "spec" ? "spec-reviewer" : "ticket-reviewer",
      sourceRevision: "candidate",
      ...(scope === undefined
        ? {}
        : {
            review:
              scope === "change"
                ? { ...changeReview }
                : {
                    scope,
                    baseRevision: "spec-base",
                    includedChanges: [],
                    specRef: "owner/repo#12",
                    specRevision: "body-3",
                    coverage: "complete",
                  },
          }),
    });
    return {
      ...task,
      requestFingerprint: "c".repeat(64),
      policyHash: policy.hash,
      policyRevision: policy.sourceRevision,
      briefHash: policy.briefs["ticket-reviewer"].hash,
      sourceAccess: "read-only",
      toolProfile: "source-reader",
      requested: modelSelection,
      assigned: null,
      effective: modelSelection,
    };
  };
  const reviewTrial = (
    id: string,
    reviewScopes?: ReadonlyArray<"change" | "spec">,
  ): ExperimentDefinition => ({
    ...definition(id),
    lever: "reviewer",
    variants: [
      { id: "control", label: "Control", modelSelection },
      {
        id: "early",
        label: "Alternative",
        modelSelection: { ...modelSelection, model: "gpt-5.5" },
      },
    ],
    eligibility: {
      ...definition().eligibility,
      ...(reviewScopes === undefined ? {} : { reviewScopes }),
    },
  });
  const review = (
    service: Experiments.ExperimentService["Service"],
    unit: string,
    scope?: "change" | "spec",
  ) =>
    service.assignForTask({
      ...assignInput(`thread:${unit}`),
      unitId: unit,
      taskLever: "reviewer",
      ...(scope === undefined && unit.startsWith("bare")
        ? {}
        : { agentTask: reviewerBinding(scope) }),
    });

  it.effect("requires new reviewer trials to name the review units they compare", () =>
    Effect.gen(function* () {
      const service = yield* Experiments.ExperimentService;
      assert.strictEqual(
        (yield* Effect.flip(service.create(reviewTrial("unscoped")))).reason,
        "invalid-definition",
      );
      assert.strictEqual(
        (yield* Effect.flip(
          service.create({
            ...externalDefinition(),
            eligibility: { ...externalDefinition().eligibility, reviewScopes: ["change"] },
          }),
        )).reason,
        "invalid-definition",
      );
      assert.strictEqual(
        (yield* service.create(reviewTrial("change", ["change"]))).status,
        "draft",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("enrolls only the declared scope and never pools legacy and scoped reviews", () =>
    Effect.gen(function* () {
      const service = yield* Experiments.ExperimentService;
      yield* service.create(reviewTrial("change-trial", ["change"]));
      yield* service.transition({ experimentId: "change-trial", status: "running" });
      assert.lengthOf(yield* review(service, "change-1", "change"), 1);
      assert.lengthOf(yield* review(service, "spec-1", "spec"), 0);
      assert.lengthOf(yield* review(service, "legacy-1"), 0);
      assert.lengthOf(yield* review(service, "bare-1"), 0);
      // A Spec trial runs beside it; disjoint scopes do not conflict.
      yield* service.create(reviewTrial("spec-trial", ["spec"]));
      yield* service.transition({ experimentId: "spec-trial", status: "running" });
      assert.lengthOf(yield* review(service, "spec-2", "spec"), 1);
      // A second change trial would compete for the same units.
      yield* service.create(reviewTrial("change-again", ["change", "spec"]));
      assert.strictEqual(
        (yield* Effect.flip(
          service.transition({ experimentId: "change-again", status: "running" }),
        )).reason,
        "conflict",
      );
      const report = yield* service.report({ experimentId: "change-trial" });
      assert.deepStrictEqual(
        report.reviewScopes?.map(({ scope, count }) => ({ scope, count })),
        [{ scope: "change", count: 1 }],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps a legacy reviewer trial to the unscoped reviews it was designed for", () =>
    Effect.gen(function* () {
      const service = yield* Experiments.ExperimentService;
      yield* service.create(reviewTrial("legacy", ["change"]));
      yield* storeAsUnscopedLegacy("legacy");
      yield* service.transition({ experimentId: "legacy", status: "running" });
      assert.lengthOf(yield* review(service, "bare-1"), 1);
      assert.lengthOf(yield* review(service, "legacy-unscoped"), 1);
      assert.lengthOf(yield* review(service, "change-1", "change"), 0);
      const scopes = (yield* service.report({ experimentId: "legacy" })).reviewScopes ?? [];
      assert.isTrue(scopes.every((entry) => entry.scope === "unscoped"));
      assert.strictEqual(
        scopes.reduce((total, entry) => total + entry.count, 0),
        2,
      );
    }).pipe(Effect.provide(layer)),
  );
});

describe("experiment evidence", () => {
  it.effect(
    "preserves captures across service reconstruction and keeps evaluation usage separate",
    () =>
      Effect.gen(function* () {
        yield* start();
        yield* addThread("thread:1");
        yield* addRunTurn("thread:1", "1", {
          usageScope: "main_agent",
          usageStatus: "complete",
          inputTokens: 100,
          outputTokens: 20,
          hasSubagents: false,
        });
        const service = yield* Experiments.ExperimentService;
        const assignment = (yield* service.assign(assignInput()))[0]!;
        const capture = {
          id: "capture:before",
          assignmentId: assignment.id,
          episodeId: "episode:1",
          recipeRevision: "custom-v1",
          runId: RunId.make("run:1"),
          phase: "before" as const,
          source: "human" as const,
          artifacts: [
            {
              kind: "instruction",
              reference: "message:original",
              content: "Keep the user's constraints",
            },
          ],
          missing: ["tool-state-unavailable"],
        };
        const first = yield* service.recordEvidence(capture);
        assert.deepStrictEqual(yield* service.recordEvidence(capture), first);
        assert.equal(
          (yield* Effect.flip(service.recordEvidence({ ...capture, artifacts: [] }))).reason,
          "conflict",
        );
        for (let index = 2; index <= 3; index++)
          yield* service.recordEvidence({ ...capture, id: `capture:${index}`, phase: "after" });
        const evaluation = {
          id: "evaluation:1",
          assignmentId: assignment.id,
          episodeId: "episode:1",
          rubricRevision: "rubric-v1",
          evaluator: "independent evaluator",
          source: "automated-judgement" as const,
          evidenceIds: [first.id],
          findings: [
            {
              criterion: "constraint-preservation",
              result: "unknown" as const,
              evidenceIds: [first.id],
              note: "No resumed evidence yet",
            },
          ],
          usage: {
            usageScope: "main_agent" as const,
            usageStatus: "complete" as const,
            inputTokens: 500,
            outputTokens: 50,
            hasSubagents: false,
          },
          supersedesId: null,
        };
        const judged = yield* service.recordEvaluation(evaluation);
        assert.deepStrictEqual(yield* service.recordEvaluation(evaluation), judged);
        yield* service.recordEvaluation({
          ...evaluation,
          id: "evaluation:2",
          supersedesId: judged.id,
          rubricRevision: "rubric-v2",
        });
        const bundle = yield* service.readEvidence({
          assignmentId: assignment.id,
          episodeId: "episode:1",
          limit: 1,
        });
        assert.lengthOf(bundle.captures, 1);
        assert.isTrue(bundle.hasMoreCaptures);
        assert.equal(bundle.nextOffset, 1);
        assert.lengthOf(bundle.evaluations, 2);
        const recovered = yield* Effect.gen(function* () {
          const rebuilt = yield* Experiments.ExperimentService;
          return yield* rebuilt.readEvidence({
            assignmentId: assignment.id,
            episodeId: "episode:1",
            offset: 1,
            limit: 5,
          });
        }).pipe(Effect.provide(Experiments.layer));
        assert.lengthOf(recovered.captures, 2);
        assert.isFalse(recovered.hasMoreCaptures);
        const report = (yield* service.report({ experimentId: "rollover" })).assignments[0]!;
        assert.equal(report.usage.inputTokens, 100);
        assert.deepStrictEqual(report.episodes?.[0]?.evaluationIds, [
          "evaluation:2",
          "evaluation:1",
        ]);
        assert.lengthOf(report.episodes?.[0]?.captureIds ?? [], 3);
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "rejects foreign evidence, unsupported conclusions and cross-episode supersession",
    () =>
      Effect.gen(function* () {
        yield* start();
        yield* addThread("thread:1");
        yield* addRunTurn("thread:1", "1", undefined);
        const service = yield* Experiments.ExperimentService;
        const assignment = (yield* service.assign(assignInput()))[0]!;
        yield* service.recordEvidence({
          id: "fact",
          assignmentId: assignment.id,
          episodeId: "episode",
          recipeRevision: "v1",
          runId: RunId.make("run:1"),
          phase: "after",
          source: "human",
          artifacts: [],
          missing: ["history-unavailable"],
        });
        const evaluation = {
          id: "judgement",
          assignmentId: assignment.id,
          episodeId: "episode",
          rubricRevision: "v1",
          evaluator: "human",
          source: "human-review" as const,
          evidenceIds: ["fact"],
          findings: [
            {
              criterion: "quality",
              result: "pass" as const,
              evidenceIds: [] as string[],
              note: "",
            },
          ],
          usage: null,
          supersedesId: null,
        };
        assert.equal(
          (yield* Effect.flip(service.recordEvaluation(evaluation))).reason,
          "invalid-evidence",
        );
        assert.equal(
          (yield* Effect.flip(
            service.recordEvaluation({ ...evaluation, evidenceIds: ["nonexistent"] }),
          )).reason,
          "invalid-evidence",
        );
        yield* service.recordEvaluation({
          ...evaluation,
          findings: [{ ...evaluation.findings[0]!, result: "unknown" }],
        });
        assert.equal(
          (yield* Effect.flip(
            service.recordEvaluation({ ...evaluation, id: "next", supersedesId: "nonexistent" }),
          )).reason,
          "invalid-evidence",
        );
        assert.equal(
          (yield* Effect.flip(
            service.recordEvidence({
              id: "foreign",
              assignmentId: assignment.id,
              episodeId: "episode",
              recipeRevision: "v1",
              runId: RunId.make("other-run"),
              phase: "before",
              source: "human",
              artifacts: [],
              missing: ["unknown"],
            }),
          )).reason,
          "invalid-evidence",
        );
      }).pipe(Effect.provide(layer)),
  );

  it.effect("automatically snapshots rollover policy and marks unavailable evidence", () =>
    Effect.gen(function* () {
      yield* start();
      yield* addThread("thread:1");
      yield* addRunTurn("thread:1", "1", undefined);
      const service = yield* Experiments.ExperimentService;
      const assignment = (yield* service.assign(assignInput()))[0]!;
      const observation = {
        id: "soft-observation",
        assignmentId: assignment.id,
        episodeId: "rollover-episode",
        runId: RunId.make("run:1"),
        kind: "soft" as const,
        usedTokens: 180000,
        maxTokens: 200000,
        configuredPolicy: { softLimit: 220000, hardLimit: 280000 },
        effectivePolicy: { softLimit: 144000, hardLimit: 180000 },
        evidence: ["turn:1"],
      };
      yield* service.recordObservation(observation);
      // Replaying the event must retain the original snapshot, not recapture changed state.
      yield* service.recordObservation(observation);
      const bundle = yield* service.readEvidence({
        assignmentId: assignment.id,
        episodeId: "rollover-episode",
      });
      assert.lengthOf(bundle.captures, 1);
      assert.equal(bundle.captures[0]?.source, "runtime");
      assert.equal(bundle.rubric?.revision, "rollover-quality-v1");
      assert.include(bundle.captures[0]?.missing ?? [], "initiating-message-unavailable");
      assert.include(
        bundle.captures[0]?.artifacts.find((item) => item.kind === "policy-observation")?.content ??
          "",
        '"effectivePolicy":{"softLimit":144000,"hardLimit":180000}',
      );
    }).pipe(Effect.provide(layer)),
  );
});

it.effect("keeps episode captures and evaluations within managed external ownership", () =>
  Effect.gen(function* () {
    const service = yield* Experiments.ExperimentService;
    yield* service.create(externalDefinition());
    yield* service.transition({ experimentId: "external-delegation", status: "running" });
    yield* addThread("external-evidence");
    yield* addRunTurn("external-evidence", "601", undefined);
    const owner = externalOwner();
    const foreign = { ...owner, clientSessionId: "client:foreign" };
    const assignment = (yield* assignExternalAttempt(service, "external-evidence", owner))[0]!;
    const capture = {
      id: "owned-capture",
      assignmentId: assignment.id,
      episodeId: "owned-episode",
      recipeRevision: "v1",
      runId: RunId.make("run:601"),
      phase: "after" as const,
      source: "agent" as const,
      artifacts: [],
      missing: ["explicitly-unavailable"],
    };
    assert.equal(
      (yield* service.recordEvidence(capture, foreign).pipe(Effect.flip)).reason,
      "not-found",
    );
    yield* service.recordEvidence(capture, owner);
    const evaluation = {
      id: "owned-evaluation",
      assignmentId: assignment.id,
      episodeId: "owned-episode",
      rubricRevision: "v1",
      evaluator: "owner",
      source: "self-report" as const,
      evidenceIds: [capture.id],
      findings: [
        {
          criterion: "quality",
          result: "unknown" as const,
          evidenceIds: [],
          note: "Missing evidence",
        },
      ],
      usage: null,
      supersedesId: null,
    };
    assert.equal(
      (yield* service.recordEvaluation(evaluation, foreign).pipe(Effect.flip)).reason,
      "not-found",
    );
    yield* service.recordEvaluation(evaluation, owner);
    assert.equal(
      (yield* service
        .readEvidence({ assignmentId: assignment.id, episodeId: "owned-episode" }, foreign)
        .pipe(Effect.flip)).reason,
      "not-found",
    );
    const bundle = yield* service.readEvidence(
      { assignmentId: assignment.id, episodeId: "owned-episode" },
      owner,
    );
    assert.lengthOf(bundle.captures, 1);
    assert.lengthOf(bundle.evaluations, 1);
  }).pipe(Effect.provide(layer)),
);
