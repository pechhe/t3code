import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
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
  ContextHandoffId,
  TurnItemId,
  RunId,
  RuntimeRequestId,
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
import * as Statement from "effect/sql/Statement";
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
import { COMPACTION_RECIPE } from "../orchestration-v2/ContextRollover.ts";

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
const layerExperiments = Experiments.layer.pipe(Layer.provide(NodeCrypto.layer));
const dependencies = ProjectionStore.layer.pipe(Layer.provideMerge(Sqlite.layerMemory));
const layer = layerExperiments.pipe(Layer.provideMerge(dependencies));
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
const terse = {
  sourcePath: "skills/lead/SKILL.md",
  revision: "agent-config:abc123",
  text: "Keep each reply under five lines.",
  sha256: "9f2e399e91eddf0580cfa032b906deeb5cd0e1f966f6277c566fbe161f8b818c",
};
const thorough = {
  ...terse,
  text: "Explain each decision in full.",
  sha256: "3e21fa350ebd30083dc279e80403a951c2a6e3e14b404a0d255f208b81edcfa2",
};
const instructionDefinition = (id = "instructions"): ExperimentDefinition => ({
  ...definition(id),
  lever: "instruction",
  variants: [
    { id: "terse", label: "Terse", instructions: terse },
    { id: "thorough", label: "Thorough", instructions: thorough },
  ],
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
  overrides?: Partial<OrchestrationV2Run>,
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
    ...overrides,
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
  it.effect("filters assignments with indexed queries and preserves insertion order", () =>
    Effect.gen(function* () {
      const service = yield* Experiments.ExperimentService;
      const sql = yield* SqlClient.SqlClient;
      yield* service.create(definition());
      yield* service.transition({ experimentId: "rollover", status: "running" });
      const first = (yield* service.assign(assignInput("thread:1")))[0]!;
      const second = (yield* service.assign(assignInput("thread:2")))[0]!;
      const queries: Array<ReturnType<Statement.Statement<unknown>["compile"]>> = [];
      const lookups = yield* Effect.gen(function* () {
        return [
          yield* service.assignments({}),
          yield* service.assignments({ experimentId: "rollover" }),
          yield* service.assignments({ threadId: ThreadId.make("thread:2") }),
          yield* service.assignments({
            experimentId: "rollover",
            threadId: ThreadId.make("thread:1"),
          }),
          yield* service.assignments({
            experimentId: "missing",
            threadId: ThreadId.make("thread:1"),
          }),
          yield* service.assignments({ threadId: ThreadId.make("thread:missing") }),
        ];
      }).pipe(
        Effect.provideService(Statement.CurrentTransformer, (statement) => {
          queries.push(statement.compile());
          return Effect.succeed(statement);
        }),
      );
      assert.deepEqual(lookups, [[first, second], [first, second], [second], [first], [], []]);
      assert.lengthOf(queries, 6);
      for (const [query, parameters] of queries.slice(1)) {
        const plan = yield* sql.unsafe<{ detail: string }>(
          `EXPLAIN QUERY PLAN ${query}`,
          parameters,
        );
        assert.isTrue(
          plan.some((step) => step.detail.includes("SEARCH experiment_assignments USING INDEX")),
        );
        assert.isFalse(plan.some((step) => step.detail.includes("SCAN experiment_assignments")));
      }
    }).pipe(Effect.provide(layer)),
  );

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
        const resumed = yield* Experiments.ExperimentService.pipe(Effect.provide(layerExperiments));
        assert.deepStrictEqual((yield* resumed.assign(assignInput()))[0], first);
        yield* service.transition({ experimentId: "rollover", status: "stopped" });
        assert.deepStrictEqual((yield* resumed.assign(assignInput()))[0], first);
        assert.deepStrictEqual(yield* resumed.assign(assignInput("new-while-stopped")), []);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("assigns instruction variants per thread alongside a rollover experiment", () =>
    Effect.gen(function* () {
      const service = yield* Experiments.ExperimentService;
      // The hash names the text delivered, so a mismatch or another lever's variant is refused.
      for (const variants of [
        [
          { id: "terse", label: "Terse", instructions: { ...terse, sha256: thorough.sha256 } },
          { id: "thorough", label: "Thorough", instructions: thorough },
        ],
        [
          { id: "terse", label: "Terse", instructions: terse },
          { id: "model", label: "Model", modelSelection },
        ],
      ])
        assert.strictEqual(
          (yield* Effect.flip(service.create({ ...instructionDefinition("bad"), variants })))
            .reason,
          "invalid-definition",
        );
      yield* service.create(instructionDefinition());
      yield* service.create(definition());
      yield* service.transition({ experimentId: "instructions", status: "running" });
      yield* service.transition({ experimentId: "rollover", status: "running" });
      yield* service.create(instructionDefinition("overlapping"));
      assert.strictEqual(
        (yield* Effect.flip(service.transition({ experimentId: "overlapping", status: "running" })))
          .reason,
        "conflict",
      );

      const instruction = { ...assignInput(), threadLever: "instruction" as const };
      const first = yield* service.assign(instruction);
      assert.deepStrictEqual(
        first.map((a) => a.experimentId),
        ["instructions"],
      );
      const second = yield* service.assign({
        ...assignInput("thread:2"),
        threadLever: "instruction",
      });
      assert.deepStrictEqual(
        [
          first[0]?.variant.instructions?.sha256,
          second[0]?.variant.instructions?.sha256,
        ].toSorted(),
        [terse.sha256, thorough.sha256].toSorted(),
      );
      // The rollover lever enrolls the same thread in its own experiment only, and neither
      // enrollment moves the other.
      const rollover = yield* service.assign({ ...assignInput(), threadLever: "rollover" });
      assert.deepStrictEqual(
        rollover.map((a) => a.experimentId),
        ["rollover"],
      );
      assert.deepStrictEqual(yield* service.assign(instruction), first);
      assert.strictEqual(
        (yield* service.getRolloverAssignment(ThreadId.make("thread:1")))?.id,
        rollover[0]?.id,
      );
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
  const withPolicy = layerExperiments.pipe(
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
        }).pipe(Effect.provide(layerExperiments));
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
      assert.include(bundle.captures[0]?.missing ?? [], "user-instructions-unavailable");
      assert.include(
        bundle.captures[0]?.artifacts.find((item) => item.kind === "policy-observation")?.content ??
          "",
        '"effectivePolicy":{"softLimit":144000,"hardLimit":180000}',
      );
    }).pipe(Effect.provide(layer)),
  );
});

const addUserMessage = Effect.fn(function* (thread: string, run: string, id: string, text: string) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  yield* store.apply({
    id: EventId.make(`event:${id}:message`),
    type: "message.updated",
    threadId: ThreadId.make(thread),
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: MessageId.make(id),
      threadId: ThreadId.make(thread),
      runId: RunId.make(run),
      nodeId: null,
      role: "user",
      text,
      attachments: [],
      streaming: false,
      createdAt: now,
      updatedAt: now,
    },
  });
});
const addItem = Effect.fn(function* (
  thread: string,
  run: string,
  ordinal: number,
  item:
    | { type: "command_execution"; input: string; output: string }
    | { type: "assistant_message"; text: string }
    | { type: "reasoning"; text: string }
    | { type: "dynamic_tool"; toolName: string; input: unknown; output: unknown }
    | {
        type: "user_input_request";
        requestId: RuntimeRequestId;
        questions: ReadonlyArray<{
          id: string;
          header: string;
          question: string;
          options: ReadonlyArray<{ label: string; description: string; value?: string }>;
        }>;
      },
  title: string | null = null,
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const id = TurnItemId.make(`item:${run}:${ordinal}`);
  const base = {
    id,
    threadId: ThreadId.make(thread),
    runId: RunId.make(run),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  };
  yield* store.apply({
    id: EventId.make(`event:${id}`),
    type: "turn-item.updated",
    threadId: ThreadId.make(thread),
    occurredAt: now,
    payload:
      item.type === "command_execution"
        ? { ...base, ...item, exitCode: 0 }
        : item.type === "assistant_message"
          ? {
              ...base,
              ...item,
              messageId: MessageId.make(`assistant:${ordinal}`),
              streaming: false,
            }
          : item.type === "reasoning"
            ? { ...base, ...item, streaming: false }
            : { ...base, ...item },
  });
});

describe("rollover capture", () => {
  it.effect(
    "keeps the user's instructions, full note and delivered context, and bounds tool output first",
    () =>
      Effect.gen(function* () {
        yield* start();
        yield* addThread("thread:1");
        yield* addRunTurn("thread:1", "1", undefined);
        yield* addRunTurn("thread:1", "2", undefined);
        yield* addRunTurn("thread:1", "3", undefined, undefined, undefined, {
          rolloverOfRunId: RunId.make("run:2"),
        });
        const service = yield* Experiments.ExperimentService;
        const assignment = (yield* service.assign(assignInput()))[0]!;
        const brief = "Original brief: keep the public API stable. " + "b".repeat(20_000);
        yield* addUserMessage("thread:1", "run:1", "message:brief", brief);
        yield* addUserMessage("thread:1", "run:2", "message:go", "yes build this");
        yield* addItem("thread:1", "run:2", 10, { type: "reasoning", text: "private thoughts" });
        for (let index = 0; index < 80; index++)
          yield* addItem("thread:1", "run:2", 11 + index, {
            type: "command_execution",
            input: `step ${index}`,
            output: "o".repeat(6_000),
          });
        yield* addItem("thread:1", "run:2", 100, {
          type: "assistant_message",
          text: "Handing off now.",
        });
        const episodeId = "rollover:episode";
        const soft = {
          id: "soft:run:2",
          assignmentId: assignment.id,
          episodeId,
          runId: RunId.make("run:2"),
          kind: "soft" as const,
          usedTokens: 180_000,
          maxTokens: 200_000,
          evidence: ["turn:2"],
        };
        yield* service.recordObservation(soft);
        const before = yield* service.readEvidence({
          assignmentId: assignment.id,
          episodeId,
          limit: 5,
        });
        assert.equal(before.rubric?.revision, "rollover-quality-v1");
        const artifacts = before.captures.flatMap((capture) => capture.artifacts);
        assert.equal(before.captures[0]?.recipeRevision, COMPACTION_RECIPE);
        assert.equal(
          artifacts
            .filter((artifact) => artifact.reference.startsWith("message:message:brief"))
            .map((artifact) => artifact.content)
            .join(""),
          brief,
        );
        assert.isTrue(artifacts.some((artifact) => artifact.content === "yes build this"));
        const activity = artifacts
          .filter((artifact) => artifact.kind === "activity")
          .flatMap((artifact) => JSON.parse(artifact.content!) as Array<Record<string, unknown>>);
        assert.isFalse(activity.some((item) => item.type === "reasoning"));
        assert.isTrue(activity.some((item) => item.text === "Handing off now."));
        // Tool output is cut and shed before anything else; the nearest items keep theirs.
        const missing = before.captures[0]!.missing;
        assert.isTrue(missing.some((marker) => marker.startsWith("item-text-truncated:")));
        assert.isTrue(missing.some((marker) => marker.startsWith("tool-output-omitted:")));
        assert.equal(
          activity.at(-2)?.text,
          ("Command: step 79\nExit code: 0\n" + "o".repeat(6_000)).slice(0, 4_000),
        );
        assert.isNull(activity[0]?.text);
        assert.equal(activity[0]?.textLength, "Command: step 0\nExit code: 0\n".length + 6_000);

        // A later capture of the same episode holds only what changed.
        yield* addUserMessage("thread:1", "run:2", "message:late", "Also keep the CLI flags");
        yield* service.recordObservation({ ...soft, id: "hard:run:2", kind: "hard" });
        const hard = (yield* service.readEvidence({
          assignmentId: assignment.id,
          episodeId,
          offset: before.captures.length,
          limit: 5,
        })).captures.find((capture) => capture.id === "capture:hard:run:2")!;
        assert.deepEqual(
          hard.artifacts
            .filter((artifact) => artifact.kind === "user-instruction")
            .map((artifact) => artifact.content),
          ["Also keep the CLI flags"],
        );
        assert.isTrue(
          hard.missing.some((marker) =>
            marker.startsWith("unchanged-since-earlier-episode-capture:"),
          ),
        );

        const note = "## Goal\n" + "n".repeat(30_000);
        const context = "Delivered: " + "c".repeat(40_000);
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        yield* store.apply({
          id: EventId.make("event:handoff"),
          type: "context-handoff.updated",
          threadId: ThreadId.make("thread:1"),
          occurredAt: now,
          payload: {
            id: ContextHandoffId.make("handoff:1"),
            threadId: ThreadId.make("thread:1"),
            targetRunId: RunId.make("run:3"),
            fromProviderThreadIds: [ProviderThreadId.make("provider:2")],
            toProviderThreadId: ProviderThreadId.make("provider:3"),
            coveredRunOrdinals: { from: 1, to: 2 },
            strategy: "manual_context",
            status: "ready",
            summaryMessageId: null,
            summaryText: note,
            delivery: {
              nativeThreadId: "native:3",
              status: "inline",
              contextText: context,
              summaryIncluded: true,
              itemIds: [],
            },
            createdByProviderInstanceId: null,
            createdAt: now,
            updatedAt: now,
          },
        });
        yield* service.recordObservation({
          id: "fresh:run:3",
          assignmentId: assignment.id,
          episodeId,
          runId: RunId.make("run:3"),
          kind: "fresh-context",
          usedTokens: 20_000,
          maxTokens: 200_000,
          evidence: ["turn:3"],
        });
        const all: Array<(typeof before.captures)[number]> = [];
        for (let offset: number | null = 0; offset !== null;) {
          const page: typeof before = yield* service.readEvidence({
            assignmentId: assignment.id,
            episodeId,
            offset,
            limit: 5,
          });
          all.push(...page.captures);
          offset = page.nextOffset;
        }
        const after = all.filter((capture) => capture.id.startsWith("capture:fresh:run:3"));
        const afterArtifacts = after.flatMap((capture) => capture.artifacts);
        const joined = (kind: string) =>
          afterArtifacts
            .filter((artifact) => artifact.kind === kind)
            .map((artifact) => artifact.content)
            .join("");
        assert.equal(joined("handoff-note"), note);
        assert.equal(joined("delivered-context"), context);
        assert.isTrue(after.every((capture) => capture.phase === "after"));
        assert.notInclude(after[0]!.missing.join(" "), "truncated");
      }).pipe(Effect.provide(layer)),
  );

  it.effect("captures tool content, the questions behind answers, and bounds long titles", () =>
    Effect.gen(function* () {
      yield* start();
      yield* addThread("thread:1");
      yield* addRunTurn("thread:1", "1", undefined);
      const service = yield* Experiments.ExperimentService;
      const assignment = (yield* service.assign(assignInput()))[0]!;
      yield* addUserMessage("thread:1", "run:1", "message:brief", "Ship the fix");
      const requestId = RuntimeRequestId.make("request:scope");
      yield* addItem("thread:1", "run:1", 1, {
        type: "user_input_request",
        requestId,
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "Include the CLI?",
            options: [{ label: "Yes", description: "Change the CLI flags too", value: "yes" }],
          },
        ],
      });
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      yield* store.apply({
        id: EventId.make("event:request:scope"),
        type: "runtime-request.updated",
        threadId: ThreadId.make("thread:1"),
        runId: RunId.make("run:1"),
        occurredAt: now,
        payload: {
          id: requestId,
          nodeId: NodeId.make("node:1"),
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status: "resolved",
          responseCapability: { type: "message" },
          createdAt: now,
          resolvedAt: now,
          answers: { scope: "yes" },
        },
      });
      yield* addItem("thread:1", "run:1", 2, {
        type: "dynamic_tool",
        toolName: "t3_thread_read",
        input: { threadId: "thread:other" },
        output: { status: "idle" },
      });
      yield* addItem(
        "thread:1",
        "run:1",
        3,
        { type: "command_execution", input: "ls", output: "x".repeat(40_000) },
        "t".repeat(40_000),
      );
      yield* service.recordObservation({
        id: "soft:run:1",
        assignmentId: assignment.id,
        episodeId: "episode",
        runId: RunId.make("run:1"),
        kind: "soft",
        usedTokens: 180_000,
        maxTokens: 200_000,
        evidence: ["turn:1"],
      });
      const { captures } = yield* service.readEvidence({
        assignmentId: assignment.id,
        episodeId: "episode",
      });
      const artifacts = captures.flatMap((capture) => capture.artifacts);
      const answer = JSON.parse(
        artifacts.find((artifact) => artifact.kind === "user-answer")!.content!,
      );
      assert.equal(answer.questions[0].question, "Include the CLI?");
      assert.equal(answer.questions[0].options[0].value, "yes");
      assert.deepEqual(answer.answers, { scope: "yes" });
      const activity = artifacts
        .filter((artifact) => artifact.kind === "activity")
        .flatMap((artifact) => JSON.parse(artifact.content!) as Array<Record<string, unknown>>);
      const tool = activity.find((item) => item.type === "dynamic_tool");
      assert.include(String(tool?.text), "t3_thread_read");
      assert.include(String(tool?.text), '"status":"idle"');
      const command = activity.find((item) => item.type === "command_execution");
      assert.equal(command?.titleLength, 40_000);
      assert.lengthOf(String(command?.title), 1_000);
      assert.isTrue(
        captures[0]!.missing.some((marker) => marker.startsWith("item-text-truncated:")),
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("appends retrospective agent evidence to a runtime episode under its own recipe", () =>
    Effect.gen(function* () {
      yield* start();
      yield* addThread("thread:1");
      yield* addRunTurn("thread:1", "1", undefined);
      const service = yield* Experiments.ExperimentService;
      const assignment = (yield* service.assign(assignInput()))[0]!;
      const runtime = {
        id: "capture:runtime",
        assignmentId: assignment.id,
        episodeId: "episode",
        recipeRevision: "rollover-v1",
        runId: RunId.make("run:1"),
        phase: "before" as const,
        source: "runtime" as const,
        artifacts: [],
        missing: ["history-unavailable"],
      };
      yield* service.recordEvidence(runtime);
      const recovered = yield* service.recordEvidence({
        ...runtime,
        id: "capture:recovered",
        recipeRevision: "authority-recovery-v2",
        phase: "after",
        source: "agent",
        artifacts: [{ kind: "instruction", reference: "message:brief", content: "the brief" }],
        missing: [],
      });
      const page = yield* service.readEvidence({
        assignmentId: assignment.id,
        episodeId: "episode",
        offset: 1,
      });
      assert.deepEqual(page.captures, [recovered]);
      // The rubric follows the episode, not the page.
      assert.equal(page.rubric?.revision, "rollover-quality-v1");
      const conflict = yield* Effect.flip(
        service.recordEvidence({ ...runtime, missing: ["something-else"] }),
      );
      assert.equal(conflict.reason, "conflict");
      assert.include(conflict.message, "append under a new id");
      const oversized = yield* Effect.flip(
        service.recordEvidence({
          ...runtime,
          id: "capture:oversized",
          artifacts: Array.from({ length: 5 }, (_, index) => ({
            kind: "chunk",
            reference: `chunk:${index}`,
            content: "x".repeat(30_000),
          })),
        }),
      );
      assert.include(oversized.message, "150000 UTF-8 bytes");
      const report = (yield* service.report({ experimentId: "rollover" })).assignments[0]!;
      assert.equal(report.episodes?.[0]?.recipeRevision, "rollover-v1");
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
