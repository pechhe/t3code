import {
  Experiment,
  ExperimentAssignment,
  ExperimentOutcome,
  ExperimentObservation,
  ExperimentEvidence,
  ExperimentEvaluation,
  ExperimentEvidenceInput,
  ExperimentEvaluationInput,
  type ExperimentEpisodeReport,
  type ExperimentEvidenceReadInput,
  type ExperimentEvidenceBundle,
  ExperimentError,
  ExperimentDefinition,
  type AgentReviewScope,
  ExperimentWorkUnit,
  ExperimentWorkAllocation,
  ExperimentWorkEvidence,
  type ExperimentWorkOwner,
  type ExperimentWorkEnrollInput,
  type ExperimentWorkAllocationInput,
  type ExperimentWorkEvidenceInput,
  type ExperimentWorkReport,
  AgentTaskBinding,
  type ModelSelection,
  type ExperimentTransitionInput,
  type ExperimentAssignmentsInput,
  type ExperimentAssignInput,
  type ExperimentOutcomeInput,
  type ExperimentObservationInput,
  type ExperimentHistoricalInput,
  type ExperimentReportInput,
  type ExperimentReport,
  type ExperimentAssignmentReport,
  type ExperimentTurnEvidence,
  ThreadId,
  type OrchestrationV2Run,
  isConsultingRole,
  isReviewerRole,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Option from "effect/Option";
import * as PolicyStore from "../agents/AgentPolicyStore.ts";
import * as ManagedAgent from "../agents/ManagedAgentService.ts";

type WorkReader = {
  readonly environmentId: string;
  readonly clientSessionId?: string | undefined;
  readonly threadId?: string | undefined;
};
const visibleWork = (assignment: ExperimentAssignment, reader: WorkReader | undefined) => {
  if (assignment.work !== undefined) return visibleUnit(assignment.work, reader);
  const owner = assignment.agentTask?.externalOwner;
  return (
    reader === undefined ||
    owner === undefined ||
    assignment.threadId === reader.threadId ||
    (owner.clientSessionId === reader.clientSessionId &&
      owner.environmentId === reader.environmentId)
  );
};
const visibleUnit = (unit: ExperimentWorkUnit, reader: WorkReader | undefined) =>
  reader === undefined ||
  (unit.owner.environmentId === reader.environmentId &&
    (unit.owner.parentThreadId === reader.threadId ||
      (unit.owner.clientSessionId !== null &&
        unit.owner.clientSessionId === reader.clientSessionId)));

export class ExperimentService extends Context.Service<
  ExperimentService,
  {
    readonly enrollWork: (input: {
      readonly request: ExperimentWorkEnrollInput;
      readonly owner: ExperimentWorkOwner;
      readonly orchestratorSelection: ModelSelection;
      readonly modelSource: "run-selection" | "self-report";
      readonly policyHash: string;
      readonly policyRevision: string | null;
      readonly alreadyStarted: boolean;
    }) => Effect.Effect<ExperimentWorkUnit, ExperimentError>;
    readonly allocateWork: (
      input: ExperimentWorkAllocationInput,
      reader: WorkReader,
    ) => Effect.Effect<ExperimentWorkAllocation, ExperimentError>;
    readonly recordWorkEvidence: (
      input: ExperimentWorkEvidenceInput,
      reader: WorkReader,
    ) => Effect.Effect<ExperimentWorkEvidence, ExperimentError>;
    readonly readWork: (
      input: { readonly workUnitId: string },
      reader?: WorkReader,
    ) => Effect.Effect<ExperimentWorkReport, ExperimentError>;
    readonly workDispatchPolicy: (input: {
      readonly workUnitId: string;
      readonly owner: ExperimentWorkOwner;
      readonly role?: AgentTaskBinding["role"];
      /** Continues an earlier task's conversation rather than starting one. */
      readonly followup?: boolean;
    }) => Effect.Effect<ExperimentWorkUnit, ExperimentError>;
    readonly recordWorkTaskLaunch: (input: {
      readonly taskId: string;
      readonly state: "accepted" | "refused" | "launch-unknown";
    }) => Effect.Effect<void, ExperimentError>;
    readonly recordWorkOutcome: (
      input: ExperimentOutcomeInput,
      reader: WorkReader,
    ) => Effect.Effect<ExperimentOutcome, ExperimentError>;
    readonly registerWorkTask: (input: {
      readonly workUnitId: string;
      readonly owner: ExperimentWorkOwner;
      readonly binding: AgentTaskBinding;
      readonly taskId: string;
      readonly threadId: ThreadId;
    }) => Effect.Effect<void, ExperimentError>;
    readonly create: (input: ExperimentDefinition) => Effect.Effect<Experiment, ExperimentError>;
    readonly transition: (
      input: ExperimentTransitionInput,
    ) => Effect.Effect<Experiment, ExperimentError>;
    readonly list: () => Effect.Effect<ReadonlyArray<Experiment>, ExperimentError>;
    readonly assignments: (
      input: ExperimentAssignmentsInput,
      reader?: WorkReader,
    ) => Effect.Effect<ReadonlyArray<ExperimentAssignment>, ExperimentError>;
    readonly assign: (
      input: ExperimentAssignInput,
    ) => Effect.Effect<ReadonlyArray<ExperimentAssignment>, ExperimentError>;
    readonly assignForThread: (
      input: Omit<ExperimentAssignInput, "unitKind" | "unitId" | "taskLever" | "taskCategory">,
    ) => Effect.Effect<ReadonlyArray<ExperimentAssignment>, ExperimentError>;
    readonly assignForTask: (
      input: Omit<ExperimentAssignInput, "unitKind"> & {
        readonly taskLever: "reviewer" | "delegation";
      },
    ) => Effect.Effect<ReadonlyArray<ExperimentAssignment>, ExperimentError>;
    readonly recordOutcome: (
      input: ExperimentOutcomeInput,
      reader?: WorkReader,
    ) => Effect.Effect<ExperimentOutcome, ExperimentError>;
    readonly recordObservation: (
      input: ExperimentObservationInput,
    ) => Effect.Effect<ExperimentObservation, ExperimentError>;
    readonly readEvidence: (
      input: ExperimentEvidenceReadInput,
      reader?: WorkReader,
    ) => Effect.Effect<ExperimentEvidenceBundle, ExperimentError>;
    readonly recordEvidence: (
      input: ExperimentEvidenceInput,
      reader?: WorkReader,
    ) => Effect.Effect<ExperimentEvidence, ExperimentError>;
    readonly recordEvaluation: (
      input: ExperimentEvaluationInput,
      reader?: WorkReader,
    ) => Effect.Effect<ExperimentEvaluation, ExperimentError>;
    readonly importHistorical: (
      input: ExperimentHistoricalInput,
    ) => Effect.Effect<ExperimentAssignment, ExperimentError>;
    readonly report: (
      input: ExperimentReportInput,
      reader?: WorkReader,
    ) => Effect.Effect<ExperimentReport, ExperimentError>;
  }
>()("t3/experiments/ExperimentService") {}

const isExperimentError = Schema.is(ExperimentError);
const isExperimentDefinition = Schema.is(ExperimentDefinition);
const isExperimentEvidenceInput = Schema.is(ExperimentEvidenceInput);
const isExperimentEvaluationInput = Schema.is(ExperimentEvaluationInput);
const jsonAssignment = Schema.fromJsonString(ExperimentAssignment);
const jsonOutcome = Schema.fromJsonString(ExperimentOutcome);
const jsonObservation = Schema.fromJsonString(ExperimentObservation);
const encodeAssignment = Schema.encodeSync(jsonAssignment);
const encodeOutcome = Schema.encodeSync(jsonOutcome);
const encodeObservation = Schema.encodeSync(jsonObservation);
const encodeSnapshot = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const rolloverRubric = {
  revision: "rollover-quality-v1",
  criteria: [
    "goal-and-constraint-preservation",
    "decision-preservation",
    "live-work-accuracy",
    "restart-actionability",
    "interruption-timing",
    "avoidable-rediscovery-or-rework",
  ],
  instructions:
    "Compare pre-handoff instructions and observable work state with the submitted note, confirmed delivered material and resumed actions. Cite exact capture IDs and artifact references in each finding. Missing original constraints, delivery or resumed work requires unknown for affected criteria. A hard nudge or successful turn alone proves neither a bad interruption nor correct continuation. Do not infer hidden reasoning. Separate automated judgements from human review and self-report; record evaluator usage separately. Use actual effective thresholds and analyze within provider/model before pooling.",
};
/** Recipes judged by `rolloverRubric`; episodes keep the recipe they were captured under. */
const rolloverRecipes = ["rollover-v1", "rollover-v3"];
// One capture's bounds (see ExperimentEvidenceInput); larger evidence spans parts.
const captureBytes = 128_000;
const jsonEvidence = Schema.fromJsonString(ExperimentEvidence);
const jsonEvaluation = Schema.fromJsonString(ExperimentEvaluation);
const encodeEvidence = Schema.encodeSync(jsonEvidence);
const encodeEvaluation = Schema.encodeSync(jsonEvaluation);
const decodeEvidence = Schema.decodeUnknownEffect(jsonEvidence);
const decodeEvaluation = Schema.decodeUnknownEffect(jsonEvaluation);
const jsonExperiment = Schema.fromJsonString(Experiment);
const encodeExperiment = Schema.encodeSync(jsonExperiment);
const decodeExperiment = Schema.decodeUnknownEffect(jsonExperiment);
const decodeAssignment = Schema.decodeUnknownEffect(jsonAssignment);
const decodeOutcome = Schema.decodeUnknownEffect(jsonOutcome);
const decodeObservation = Schema.decodeUnknownEffect(jsonObservation);
const workJson = Schema.fromJsonString(ExperimentWorkUnit);
const encodeWork = Schema.encodeSync(workJson);
const decodeWork = Schema.decodeUnknownEffect(workJson);
const allocationJson = Schema.fromJsonString(ExperimentWorkAllocation);
const encodeAllocation = Schema.encodeSync(allocationJson);
const decodeAllocation = Schema.decodeUnknownEffect(allocationJson);
const evidenceJson = Schema.fromJsonString(ExperimentWorkEvidence);
const encodeWorkEvidence = Schema.encodeSync(evidenceJson);
const decodeWorkEvidence = Schema.decodeUnknownEffect(evidenceJson);
const encodeOwner = Schema.encodeSync(Schema.fromJsonString(ExperimentWorkUnit.fields.owner));
const encodeModelSelection = Schema.encodeSync(
  Schema.fromJsonString(ExperimentWorkUnit.fields.orchestratorSelection),
);
const encodeSelection = (selection: ModelSelection) =>
  encodeModelSelection({
    ...selection,
    options: [...(selection.options ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
  });
const encodeBinding = Schema.encodeSync(Schema.fromJsonString(AgentTaskBinding));
const encodeKey = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.NullOr(Schema.Union([Schema.String, Schema.Number])))),
);
// Reproducible pseudorandom ranking; assignment identity uses the complete key, not a hash.
function hash(value: string): string {
  let state = 2166136261;
  for (const code of value) state = Math.imul(state ^ code.charCodeAt(0), 16777619);
  state = Math.imul(state ^ (state >>> 16), 2246822507);
  state = Math.imul(state ^ (state >>> 13), 3266489909);
  return ((state ^ (state >>> 16)) >>> 0).toString(16).padStart(8, "0");
}
const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

function overlaps(a: readonly string[], b: readonly string[]): boolean {
  return a.length === 0 || b.length === 0 || a.some((value) => b.includes(value));
}
/** Legacy reviewer definitions admit only reviews without a declared scope. */
const admittedReviewScopes = (
  experiment: ExperimentDefinition,
): ReadonlyArray<AgentReviewScope | "unscoped"> =>
  experiment.eligibility.reviewScopes ?? ["unscoped"];
function conflicts(a: Experiment, b: Experiment): boolean {
  return (
    (a.lever !== "reviewer" ||
      a.lever !== b.lever ||
      admittedReviewScopes(a).some((scope) => admittedReviewScopes(b).includes(scope))) &&
    (a.lever === b.lever ||
      ([a.lever, b.lever].includes("orchestration-policy") &&
        [a.lever, b.lever].includes("delegation"))) &&
    overlaps(a.eligibility.projectIds, b.eligibility.projectIds) &&
    (a.lever !== b.lever || overlaps(a.eligibility.models, b.eligibility.models)) &&
    (a.lever !== b.lever || overlaps(a.eligibility.taskCategories, b.eligibility.taskCategories))
  );
}
/** Levers assigned per thread rather than per delegated task. */
const isThreadLever = (lever: ExperimentDefinition["lever"]) =>
  // Legacy, read-only: "rollover" experiments are kept so their evidence stays reportable.
  lever === "rollover" || lever === "instruction";
function validDefinition(input: ExperimentDefinition, now: string): boolean {
  // Context rollover is gone, so no new experiment can vary it.
  if (input.lever === "rollover") return false;
  // A new reviewer experiment says which review units it compares; other levers have none.
  if ((input.lever === "reviewer") !== (input.eligibility.reviewScopes !== undefined)) return false;
  if (input.lever === "orchestration-policy")
    return (
      input.orchestrationControls !== undefined &&
      input.variants.length === 2 &&
      new Set(input.variants.map((v) => v.id)).size === 2 &&
      new Set(input.variants.map((v) => v.allocationPolicy)).size === 2 &&
      input.variants.every(
        (v) =>
          v.allocationPolicy !== undefined &&
          v.modelSelection === undefined &&
          v.rollover === undefined,
      ) &&
      Number.isFinite(Date.parse(input.endsAt)) &&
      Date.parse(input.endsAt) > Date.parse(now)
    );
  if (
    input.orchestrationControls !== undefined ||
    input.variants.some((v) => v.allocationPolicy !== undefined)
  )
    return false;
  return (
    input.variants.length >= 2 &&
    new Set(input.variants.map((v) => v.id)).size === input.variants.length &&
    Number.isFinite(Date.parse(input.endsAt)) &&
    Date.parse(input.endsAt) > Date.parse(now) &&
    input.variants.every((v) =>
      input.lever === "instruction"
        ? v.instructions !== undefined && v.modelSelection === undefined && v.rollover === undefined
        : v.modelSelection !== undefined && v.rollover === undefined && v.instructions === undefined,
    ) &&
    (!isThreadLever(input.lever) || input.eligibility.taskCategories.length === 0)
  );
}

/** A missing turn count cannot become a zero or a complete aggregate. */
function aggregateUsage(
  turns: readonly Pick<ExperimentTurnEvidence, "usage">[],
): ExperimentAssignmentReport["usage"] {
  const missingTurns = turns.filter(
    (t) => !t.usage || t.usage.usageStatus === "unavailable",
  ).length;
  const partialTurns = turns.filter((t) => t.usage?.usageStatus === "partial").length;
  const total = (
    key:
      | "inputTokens"
      | "outputTokens"
      | "cachedInputTokens"
      | "cacheCreationTokens"
      | "reasoningTokens",
  ) => {
    if (turns.length === 0 || turns.some((t) => t.usage?.[key] === undefined)) return null;
    return turns.reduce((sum, t) => sum + (t.usage?.[key] ?? 0), 0);
  };
  return {
    status:
      turns.length === 0 || missingTurns === turns.length
        ? "unavailable"
        : missingTurns > 0 || partialTurns > 0
          ? "partial"
          : "complete",
    inputTokens: total("inputTokens"),
    outputTokens: total("outputTokens"),
    cachedInputTokens: total("cachedInputTokens"),
    cacheCreationTokens: total("cacheCreationTokens"),
    reasoningTokens: total("reasoningTokens"),
    missingTurns,
    partialTurns,
    hasUnattributedSubagentUsage: turns.some((t) => t.usage?.hasSubagents === true),
  };
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const policyStore = yield* PolicyStore.AgentPolicyStore;
  const managed = yield* Effect.serviceOption(ManagedAgent.ManagedAgentService);
  const crypto = yield* Crypto.Crypto;
  const persist = <A, E>(operation: string, entityId: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.mapError((cause) =>
        isExperimentError(cause)
          ? cause
          : new ExperimentError({ operation, entityId, reason: "persistence", cause }),
      ),
    );
  const fail = (
    operation: string,
    entityId: string,
    reason: ExperimentError["reason"],
    detail?: string,
  ) =>
    Effect.fail(
      new ExperimentError({
        operation,
        entityId,
        reason,
        ...(detail === undefined ? {} : { detail }),
      }),
    );

  const list = Effect.fn("ExperimentService.list")(function* () {
    const rows = yield* persist(
      "list",
      "",
      sql<{
        definition_json: string;
        status: Experiment["status"];
        started_at: string | null;
        updated_at: string;
      }>`SELECT definition_json, status, started_at, updated_at FROM experiments ORDER BY created_at, id`,
    );
    return yield* Effect.forEach(rows, (row) =>
      persist("list", "", decodeExperiment(row.definition_json)).pipe(
        Effect.map((value) => ({
          ...value,
          status: row.status,
          startedAt: row.started_at,
          updatedAt: row.updated_at,
        })),
      ),
    );
  });
  const get = Effect.fn("ExperimentService.get")(function* (id: string) {
    const experiments = yield* list();
    const value = experiments.find((e) => e.id === id);
    return value ?? (yield* fail("read", id, "not-found"));
  });
  const assignments = Effect.fn("ExperimentService.assignments")(function* (
    input: ExperimentAssignmentsInput,
    reader?: WorkReader,
  ) {
    const rows = yield* persist(
      "assignments",
      input.experimentId ?? input.threadId ?? "",
      input.experimentId !== undefined && input.threadId !== undefined
        ? sql<{
            payload_json: string;
          }>`SELECT payload_json FROM experiment_assignments WHERE experiment_id = ${input.experimentId} AND thread_id = ${input.threadId} ORDER BY rowid`
        : input.experimentId !== undefined
          ? sql<{
              payload_json: string;
            }>`SELECT payload_json FROM experiment_assignments WHERE experiment_id = ${input.experimentId} ORDER BY rowid`
          : input.threadId !== undefined
            ? sql<{
                payload_json: string;
              }>`SELECT payload_json FROM experiment_assignments WHERE thread_id = ${input.threadId} ORDER BY rowid`
            : sql<{
                payload_json: string;
              }>`SELECT payload_json FROM experiment_assignments ORDER BY rowid`,
    );
    const decoded = yield* Effect.forEach(rows, (row) =>
      persist("assignments", "", decodeAssignment(row.payload_json)),
    );
    return decoded.filter((assignment) => visibleWork(assignment, reader));
  });
  const getAssignment = Effect.fn("ExperimentService.getAssignment")(function* (id: string) {
    const rows = yield* persist(
      "assignment",
      id,
      sql<{
        payload_json: string;
      }>`SELECT payload_json FROM experiment_assignments WHERE id = ${id}`,
    );
    if (!rows[0]) return yield* fail("assignment", id, "not-found");
    return yield* persist("assignment", id, decodeAssignment(rows[0].payload_json));
  });
  // With a managed policy, a trial cannot use a model no pool allows: every unit assigned that
  // arm would be refused at dispatch and counted against it. Checked at create and at start,
  // because the policy can change between the two.
  const armModelsAllowed = Effect.fn("ExperimentService.armModelsAllowed")(function* (
    input: ExperimentDefinition,
  ) {
    if (Option.isNone(managed) || !input.variants.some((v) => v.modelSelection !== undefined))
      return true;
    const snapshot = yield* Effect.option(managed.value.snapshot());
    if (Option.isNone(snapshot)) return true;
    const { models, lists } = snapshot.value.manifest;
    const allowed = new Set(
      Object.values(lists).flatMap((list) => list.map((entry) => models[entry.model]?.model)),
    );
    return input.variants.every((v) => !v.modelSelection || allowed.has(v.modelSelection.model));
  });
  // A variant's hash is what run setup records name, so it must be the hash of the text sent.
  const instructionHashesMatch = (input: ExperimentDefinition) =>
    Effect.forEach(input.variants, (variant) =>
      variant.instructions === undefined
        ? Effect.succeed(true)
        : crypto.digest("SHA-256", new TextEncoder().encode(variant.instructions.text)).pipe(
            Effect.map(
              (digest) => Buffer.from(digest).toString("hex") === variant.instructions?.sha256,
            ),
            Effect.orElseSucceed(() => false),
          ),
    ).pipe(Effect.map((matches) => matches.every(Boolean)));
  const create = Effect.fn("ExperimentService.create")(function* (input: ExperimentDefinition) {
    const now = yield* nowIso;
    if ((yield* list()).length >= 1000)
      return yield* fail("create", input.id, "invalid-definition");
    if (!isExperimentDefinition(input) || !validDefinition(input, now))
      return yield* fail("create", input.id, "invalid-definition");
    if (!(yield* armModelsAllowed(input)))
      return yield* fail("create", input.id, "invalid-definition");
    if (!(yield* instructionHashesMatch(input)))
      return yield* fail("create", input.id, "invalid-definition");
    const value: Experiment = {
      ...input,
      revision: 1,
      status: "draft",
      createdAt: now,
      startedAt: null,
      updatedAt: now,
    };
    yield* persist(
      "create",
      input.id,
      sql`INSERT INTO experiments(id, definition_json, status, created_at, updated_at) VALUES (${value.id}, ${encodeExperiment(value)}, ${value.status}, ${now}, ${now})`,
    );
    return value;
  });
  const transition = Effect.fn("ExperimentService.transition")((input: ExperimentTransitionInput) =>
    persist(
      "transition",
      input.experimentId,
      sql.withTransaction(
        Effect.gen(function* () {
          const experiment = yield* get(input.experimentId);
          if (input.status === experiment.status) return experiment;
          if (
            experiment.status === "stopped" ||
            input.status === "draft" ||
            (experiment.status === "draft" && input.status === "paused")
          )
            return yield* fail("transition", experiment.id, "invalid-transition");
          const now = yield* nowIso;
          if (input.status === "running") {
            if (!(yield* armModelsAllowed(experiment)))
              return yield* fail("transition", experiment.id, "invalid-transition");
            const samples = yield* assignments({ experimentId: experiment.id });
            if (
              Date.parse(experiment.endsAt) <= Date.parse(now) ||
              samples.filter((s) => s.assignmentMethod === "randomized").length >=
                experiment.maxAssignments
            )
              return yield* fail("transition", experiment.id, "invalid-transition");
            if (
              (yield* list()).some(
                (other) =>
                  other.id !== experiment.id &&
                  other.status === "running" &&
                  Date.parse(other.endsAt) > Date.parse(now) &&
                  conflicts(experiment, other),
              )
            )
              return yield* fail("transition", experiment.id, "conflict");
          }
          yield* sql`UPDATE experiments SET status = ${input.status}, started_at = ${experiment.startedAt ?? (input.status === "running" ? now : null)}, updated_at = ${now} WHERE id = ${experiment.id}`;
          return {
            ...experiment,
            status: input.status,
            startedAt: experiment.startedAt ?? (input.status === "running" ? now : null),
            updatedAt: now,
          };
        }),
      ),
    ),
  );

  const saveAssignment = Effect.fn("ExperimentService.saveAssignment")(function* (
    assignment: ExperimentAssignment,
    stratum: string,
  ) {
    yield* persist(
      "assign",
      assignment.id,
      sql`INSERT INTO experiment_assignments(id, experiment_id, unit_kind, unit_id, thread_id, stratum, variant_id, assignment_method, payload_json) VALUES (${assignment.id}, ${assignment.experimentId}, ${assignment.unitKind}, ${assignment.unitId}, ${assignment.threadId ?? ""}, ${stratum}, ${assignment.variant.id}, ${assignment.assignmentMethod}, ${encodeAssignment(assignment)})`,
    );
    return assignment;
  });
  // The legacy indexed column is NOT NULL. Empty means no thread; the authoritative
  // payload uses null and no synthetic parent or child is created.
  const assign = Effect.fn("ExperimentService.assign")((input: ExperimentAssignInput) =>
    persist(
      "assign",
      input.unitId,
      sql.withTransaction(
        Effect.gen(function* () {
          if (input.unitKind === "thread" && input.unitId !== input.threadId)
            return yield* fail("assign", input.unitId, "invalid-definition");
          if (input.enrollment === "existing-boundary" && input.boundaryRunId === undefined)
            return yield* fail("assign", input.unitId, "invalid-definition");
          if (input.unitKind === "task" && input.taskLever === undefined)
            return yield* fail("assign", input.unitId, "invalid-definition");
          if (input.agentTask?.workUnitId !== undefined && input.taskLever === "delegation") {
            const unit = yield* getWork(input.agentTask.workUnitId);
            if (unit.assignmentIds.length > 0) return [];
          }
          const now = yield* nowIso;
          const result = (yield* assignments(
            input.agentTask?.externalOwner === undefined ? { threadId: input.threadId } : {},
          )).filter(
            (a) =>
              a.unitKind === input.unitKind &&
              a.unitId === input.unitId &&
              a.assignmentMethod === "randomized" &&
              (input.threadLever === undefined || a.lever === input.threadLever),
          );
          const experiments = yield* list();
          const reviewScope = input.agentTask?.review?.scope;
          // Scoped reviews balance arms within their scope; unscoped keys stay as recorded.
          const stratum = encodeKey([
            input.projectId,
            input.modelSelection.instanceId,
            input.modelSelection.model,
            input.taskCategory ?? null,
            ...(reviewScope === undefined ? [] : [reviewScope]),
          ]);
          for (const experiment of experiments) {
            if (
              result.some((a) => a.experimentId === experiment.id) ||
              experiment.status !== "running" ||
              // A running rollover experiment keeps its evidence but assigns no new threads.
              experiment.lever === "rollover" ||
              Date.parse(experiment.endsAt) <= Date.parse(now)
            )
              continue;
            if (
              isThreadLever(experiment.lever) !== (input.unitKind === "thread") ||
              (input.threadLever !== undefined && experiment.lever !== input.threadLever) ||
              (input.unitKind === "task" && experiment.lever !== input.taskLever)
            )
              continue;
            if (
              input.enrollment === "new" &&
              (input.unitCreatedAt === undefined ||
                !Number.isFinite(Date.parse(input.unitCreatedAt)) ||
                Date.parse(input.unitCreatedAt) < Date.parse(experiment.startedAt ?? now))
            )
              continue;
            const { projectIds, models, taskCategories } = experiment.eligibility;
            if (
              (experiment.lever === "reviewer" &&
                !admittedReviewScopes(experiment).includes(reviewScope ?? "unscoped")) ||
              (projectIds.length > 0 && !projectIds.includes(input.projectId)) ||
              (models.length > 0 && !models.includes(input.modelSelection.model)) ||
              (taskCategories.length > 0 && !taskCategories.includes(input.taskCategory ?? ""))
            )
              continue;
            // A paused or stopped treatment remains in force for previously assigned work.
            if (result.some((a) => a.lever === experiment.lever)) continue;
            const previous = yield* assignments({ experimentId: experiment.id });
            if (
              previous.filter((a) => a.assignmentMethod === "randomized").length >=
              experiment.maxAssignments
            )
              continue;
            const counts = yield* sql<{
              variant_id: string;
              count: number;
            }>`SELECT variant_id, COUNT(*) AS count FROM experiment_assignments WHERE experiment_id = ${experiment.id} AND assignment_method = 'randomized' AND stratum = ${stratum} GROUP BY variant_id`;
            const ordered = [...experiment.variants].sort(
              (a, b) =>
                (counts.find((c) => c.variant_id === a.id)?.count ?? 0) -
                  (counts.find((c) => c.variant_id === b.id)?.count ?? 0) ||
                hash(
                  encodeKey([experiment.id, experiment.revision, input.unitId, a.id]),
                ).localeCompare(
                  hash(encodeKey([experiment.id, experiment.revision, input.unitId, b.id])),
                ),
            );
            const variant = ordered[0]!;
            const assignment: ExperimentAssignment = {
              id: `assignment:${encodeKey([experiment.id, input.unitKind, input.unitId])}`,
              experimentId: experiment.id,
              revision: experiment.revision,
              lever: experiment.lever,
              ...(input.agentTask === undefined ? {} : { agentTask: input.agentTask }),
              unitKind: input.unitKind,
              unitId: input.unitId,
              threadId: input.threadId,
              projectId: input.projectId,
              taskCategory: input.taskCategory ?? null,
              boundaryRunId: input.boundaryRunId ?? null,
              variant,
              assignedModelSelection: variant.modelSelection ?? input.modelSelection,
              enrollment: input.enrollment,
              assignmentMethod: "randomized",
              assignedAt: now,
              codeRevision: experiment.codeRevision,
              briefRevision: experiment.briefRevision,
              provenance: null,
            };
            result.push(yield* saveAssignment(assignment, stratum));
          }
          return result;
        }),
      ),
    ),
  );
  const ownerKey = encodeOwner;
  const getWork = Effect.fn("ExperimentService.getWork")(function* (
    id: string,
    reader?: WorkReader,
  ) {
    const rows = yield* persist(
      "work",
      id,
      sql<{
        payload_json: string;
      }>`SELECT payload_json FROM experiment_work_units WHERE id = ${id}`,
    );
    if (!rows[0]) return yield* fail("work", id, "not-found");
    const unit = yield* persist("work", id, decodeWork(rows[0].payload_json));
    if (!visibleUnit(unit, reader)) return yield* fail("work", id, "not-found");
    return unit;
  });
  const enrollWork = Effect.fn("ExperimentService.enrollWork")(
    (input: Parameters<ExperimentService["Service"]["enrollWork"]>[0]) =>
      persist(
        "enroll",
        input.request.workId,
        sql.withTransaction(
          Effect.gen(function* () {
            const key = ownerKey(input.owner);
            const fingerprint = encodeKey([
              input.request.workId,
              input.request.description,
              input.request.taskCategory,
              input.request.sourceRevision ?? null,
            ]);
            const rows = yield* sql<{
              payload_json: string;
              fingerprint: string;
            }>`SELECT payload_json, fingerprint FROM experiment_work_units WHERE owner_key = ${key} AND work_id = ${input.request.workId}`;
            if (rows[0]) {
              if (rows[0].fingerprint !== fingerprint)
                return yield* fail("enroll", input.request.workId, "conflict");
              return yield* decodeWork(rows[0].payload_json);
            }
            if (
              (input.owner.parentThreadId === null) !==
              (input.owner.externalSessionKey !== null && input.owner.clientSessionId !== null)
            )
              return yield* fail("enroll", input.request.workId, "invalid-definition");
            yield* persist("enroll", input.policyHash, policyStore.get(input.policyHash));
            const now = yield* nowIso;
            const unit: ExperimentWorkUnit = {
              id: `work:${encodeKey([key, input.request.workId])}`,
              workId: input.request.workId,
              description: input.request.description,
              taskCategory: input.request.taskCategory,
              taskClass: "non-ui",
              sourceRevision: input.request.sourceRevision ?? null,
              owner: input.owner,
              orchestratorSelection: input.orchestratorSelection,
              modelSource: input.modelSource,
              policyHash: input.policyHash,
              policyRevision: input.policyRevision,
              createdAt: now,
              assignmentIds: [],
              assignedPolicies: [],
              exclusions: [],
            };
            const ids: string[] = [];
            const policies: ExperimentWorkUnit["assignedPolicies"][number][] = [];
            const exclusions: { experimentId: string; reason: string }[] = [];
            const all = yield* list();
            for (const experiment of all.filter(
              (e) =>
                e.lever === "orchestration-policy" &&
                e.status === "running" &&
                Date.parse(e.endsAt) > Date.parse(now),
            )) {
              const eligible = experiment.eligibility;
              if (
                (eligible.projectIds.length &&
                  !eligible.projectIds.includes(input.owner.projectId)) ||
                (eligible.models.length &&
                  !eligible.models.includes(input.orchestratorSelection.model)) ||
                (eligible.taskCategories.length &&
                  !eligible.taskCategories.includes(unit.taskCategory))
              )
                continue;
              const controls = experiment.orchestrationControls!;
              const prior = yield* assignments({ experimentId: experiment.id });
              const reason = input.alreadyStarted
                ? "work-already-started"
                : controls.policyHash !== unit.policyHash ||
                    encodeSelection(controls.orchestratorSelection) !==
                      encodeSelection(unit.orchestratorSelection)
                  ? "controls-mismatch"
                  : prior.filter((a) => a.assignmentMethod === "randomized").length >=
                      experiment.maxAssignments
                    ? "assignment-cap"
                    : null;
              if (reason) {
                exclusions.push({ experimentId: experiment.id, reason });
                continue;
              }
              const stratum = encodeKey([
                unit.owner.projectId,
                unit.orchestratorSelection.instanceId,
                unit.orchestratorSelection.model,
                unit.taskCategory,
              ]);
              const counts = yield* sql<{
                variant_id: string;
                count: number;
              }>`SELECT variant_id, COUNT(*) AS count FROM experiment_assignments WHERE experiment_id = ${experiment.id} AND stratum = ${stratum} AND assignment_method = 'randomized' GROUP BY variant_id`;
              const variant = [...experiment.variants].sort(
                (a, b) =>
                  (counts.find((c) => c.variant_id === a.id)?.count ?? 0) -
                    (counts.find((c) => c.variant_id === b.id)?.count ?? 0) ||
                  hash(encodeKey([experiment.id, unit.id, a.id])).localeCompare(
                    hash(encodeKey([experiment.id, unit.id, b.id])),
                  ),
              )[0]!;
              ids.push(`assignment:${encodeKey([experiment.id, "work", unit.id])}`);
              policies.push({
                experimentId: experiment.id,
                allocationPolicy: variant.allocationPolicy!,
                controls,
              });
              yield* saveAssignment(
                {
                  id: ids.at(-1)!,
                  experimentId: experiment.id,
                  revision: experiment.revision,
                  lever: experiment.lever,
                  work: { ...unit, assignmentIds: [...ids], assignedPolicies: [...policies] },
                  unitKind: "work",
                  unitId: unit.id,
                  threadId: unit.owner.parentThreadId,
                  projectId: unit.owner.projectId,
                  taskCategory: unit.taskCategory,
                  boundaryRunId: null,
                  variant,
                  assignedModelSelection: unit.orchestratorSelection,
                  enrollment: "new",
                  assignmentMethod: "randomized",
                  assignedAt: now,
                  codeRevision: experiment.codeRevision,
                  briefRevision: experiment.briefRevision,
                  provenance: null,
                },
                stratum,
              );
            }
            const value = { ...unit, assignmentIds: ids, assignedPolicies: policies, exclusions };
            yield* sql`INSERT INTO experiment_work_units(id,owner_key,work_id,fingerprint,payload_json) VALUES (${unit.id},${key},${unit.workId},${fingerprint},${encodeWork(value)})`;
            return value;
          }),
        ),
      ),
  );
  const allocateWork = Effect.fn("ExperimentService.allocateWork")(
    (input: ExperimentWorkAllocationInput, reader: WorkReader) =>
      persist(
        "allocate",
        input.id,
        sql.withTransaction(
          Effect.gen(function* () {
            const unit = yield* getWork(input.workUnitId, reader);
            const rows = yield* sql<{
              payload_json: string;
            }>`SELECT payload_json FROM experiment_work_allocations WHERE id = ${input.id}`;
            if (rows[0]) {
              const value = yield* decodeAllocation(rows[0].payload_json);
              if (
                encodeAllocation(value) !==
                encodeAllocation({ ...input, recordedAt: value.recordedAt, source: "self-report" })
              )
                return yield* fail("allocate", input.id, "conflict");
              return value;
            }
            const previous = yield* sql<{
              payload_json: string;
            }>`SELECT payload_json FROM experiment_work_allocations WHERE unit_id = ${unit.id} ORDER BY rowid`;
            if (previous.length && input.deviationReason === null)
              return yield* fail("allocate", input.id, "invalid-evidence");
            for (const id of unit.assignmentIds) {
              const assignment = yield* getAssignment(id);
              if (
                (assignment.variant.allocationPolicy === "inline-first"
                  ? "inline"
                  : "delegated") !== input.allocation &&
                input.deviationReason === null
              )
                return yield* fail("allocate", input.id, "invalid-evidence");
            }
            const value: ExperimentWorkAllocation = {
              ...input,
              recordedAt: yield* nowIso,
              source: "self-report",
            };
            yield* sql`INSERT INTO experiment_work_allocations(id,unit_id,payload_json) VALUES (${input.id},${unit.id},${encodeAllocation(value)})`;
            return value;
          }),
        ),
      ),
  );
  const workDispatchPolicy = Effect.fn("ExperimentService.workDispatchPolicy")(function* (input: {
    workUnitId: string;
    owner: ExperimentWorkOwner;
    role?: AgentTaskBinding["role"];
    followup?: boolean;
  }) {
    const unit = yield* getWork(input.workUnitId);
    if (ownerKey(unit.owner) !== ownerKey(input.owner))
      return yield* fail("dispatch", unit.id, "not-found");
    // Verified completion and cancellation close work; failures may still need correction.
    if ((input.role !== undefined && isConsultingRole(input.role)) || input.followup === true) {
      for (const assignmentId of unit.assignmentIds) {
        const rows = yield* persist(
          "dispatch",
          unit.id,
          sql<{
            payload_json: string;
          }>`SELECT payload_json FROM experiment_outcomes WHERE assignment_id = ${assignmentId}`,
        );
        for (const row of rows) {
          const outcome = yield* persist("dispatch", unit.id, decodeOutcome(row.payload_json));
          if (outcome.kind === "verified-completion" || outcome.kind === "cancellation")
            return yield* fail("dispatch", unit.id, "invalid-evidence");
        }
      }
    }

    const rows = yield* persist(
      "dispatch",
      unit.id,
      sql<{
        payload_json: string;
      }>`SELECT payload_json FROM experiment_work_allocations WHERE unit_id = ${unit.id} ORDER BY rowid DESC LIMIT 1`,
    );
    const allocation =
      rows[0] === undefined
        ? null
        : yield* persist("dispatch", unit.id, decodeAllocation(rows[0].payload_json));
    if (
      !(input.role !== undefined && isConsultingRole(input.role)) &&
      (allocation === null ||
        (!(input.role !== undefined && isReviewerRole(input.role)) &&
          allocation.allocation !== "delegated"))
    )
      return yield* fail("dispatch", unit.id, "invalid-evidence");
    return unit;
  });
  const registerWorkTask = Effect.fn("ExperimentService.registerWorkTask")(
    (input: {
      workUnitId: string;
      owner: ExperimentWorkOwner;
      binding: AgentTaskBinding;
      taskId: string;
      threadId: ThreadId;
    }) =>
      persist(
        "dispatch",
        input.taskId,
        sql.withTransaction(
          Effect.gen(function* () {
            const unit = yield* workDispatchPolicy({ ...input, role: input.binding.role });
            if (
              input.binding.policyHash !== unit.policyHash ||
              input.binding.taskClass !== "non-ui" ||
              input.binding.workspacePath !== unit.owner.workspacePath ||
              input.binding.workUnitId !== unit.id ||
              (unit.sourceRevision !== null && input.binding.sourceRevision !== unit.sourceRevision)
            )
              return yield* fail("dispatch", unit.id, "invalid-evidence");
            const rows = yield* sql<{
              unit_id: string;
              thread_id: string;
              binding_json: string;
              launch_state: string;
            }>`SELECT unit_id,thread_id,binding_json,launch_state FROM experiment_work_tasks WHERE task_id = ${input.taskId} OR thread_id = ${input.threadId}`;
            const wire = encodeBinding(input.binding);
            if (rows[0]) {
              if (
                rows[0].unit_id !== unit.id ||
                rows[0].thread_id !== input.threadId ||
                rows[0].binding_json !== wire
              )
                return yield* fail("dispatch", unit.id, "conflict");
              if (rows[0].launch_state !== "refused") return;
            }
            const concurrency =
              unit.assignedPolicies.length === 0
                ? null
                : Math.min(...unit.assignedPolicies.map((p) => p.controls.concurrency));
            if (concurrency !== null) {
              const tasks = yield* sql<{
                thread_id: string;
                state: string | null;
              }>`SELECT t.thread_id, COALESCE(e.state,t.launch_state) AS state FROM experiment_work_tasks t JOIN experiment_work_units u ON u.id = t.unit_id LEFT JOIN external_agent_work e ON e.thread_id = t.thread_id WHERE u.owner_key = ${ownerKey(unit.owner)}`;
              let pending = 0;
              for (const task of tasks) {
                if (task.state === "cancelled" || task.state === "refused") continue;
                const records = yield* projections
                  .getThreadRecords(ThreadId.make(task.thread_id), ["runs"])
                  .pipe(
                    Effect.catchTags({
                      ProjectionStoreThreadNotFoundError: () => Effect.succeed(null),
                    }),
                  );
                if (
                  records === null ||
                  records.runs.length === 0 ||
                  records.runs.some(
                    (r) =>
                      !["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(
                        r.status,
                      ),
                  )
                )
                  pending++;
              }
              if (pending >= concurrency) return yield* fail("dispatch", unit.id, "conflict");
            }
            if (rows[0])
              yield* sql`UPDATE experiment_work_tasks SET launch_state='prepared' WHERE task_id=${input.taskId}`;
            else
              yield* sql`INSERT INTO experiment_work_tasks(task_id,unit_id,thread_id,binding_json) VALUES (${input.taskId},${unit.id},${input.threadId},${wire})`;
          }),
        ),
      ),
  );
  const recordWorkTaskLaunch = Effect.fn("ExperimentService.recordWorkTaskLaunch")(
    (input: { taskId: string; state: "accepted" | "refused" | "launch-unknown" }) =>
      persist(
        "launch-ack",
        input.taskId,
        sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<{
              launch_state: string;
            }>`SELECT launch_state FROM experiment_work_tasks WHERE task_id=${input.taskId}`;
            if (!rows[0]) return yield* fail("launch-ack", input.taskId, "not-found");
            // Receipt acceptance cannot be undone by a later lost response.
            if (rows[0].launch_state === "accepted" && input.state !== "accepted")
              return yield* fail("launch-ack", input.taskId, "conflict");
            yield* sql`UPDATE experiment_work_tasks SET launch_state=${input.state} WHERE task_id=${input.taskId}`;
          }),
        ),
      ),
  );
  const recordWorkEvidence = Effect.fn("ExperimentService.recordWorkEvidence")(
    (input: ExperimentWorkEvidenceInput, reader: WorkReader) =>
      persist(
        "work-evidence",
        input.id,
        sql.withTransaction(
          Effect.gen(function* () {
            const unit = yield* getWork(input.workUnitId, reader);
            const old = yield* sql<{
              payload_json: string;
            }>`SELECT payload_json FROM experiment_work_evidence WHERE id = ${input.id}`;
            if (old[0]) {
              const value = yield* decodeWorkEvidence(old[0].payload_json);
              const normalized = {
                ...input,
                usage: value.source === "provider-telemetry" ? value.usage : input.usage,
                startedAt:
                  value.source === "provider-telemetry" ? value.startedAt : input.startedAt,
                completedAt:
                  value.source === "provider-telemetry" ? value.completedAt : input.completedAt,
                recordedAt: value.recordedAt,
                source: value.source,
                attributionSource: "self-report" as const,
              };
              if (encodeWorkEvidence(value) !== encodeWorkEvidence(normalized))
                return yield* fail("work-evidence", input.id, "conflict");
              return value;
            }
            if (input.actor !== "parent")
              return yield* fail("work-evidence", input.id, "invalid-evidence"); // Child counters come from owned task records.
            let value: ExperimentWorkEvidence = {
              ...input,
              recordedAt: yield* nowIso,
              source: "self-report",
              attributionSource: "self-report",
            };
            let attributionKey: string | null = null;
            if (input.threadId !== null || input.providerTurnId !== null) {
              if (
                input.threadId !== unit.owner.parentThreadId ||
                input.threadId === null ||
                input.providerTurnId === null ||
                input.externalSegmentId !== null
              )
                return yield* fail("work-evidence", input.id, "invalid-evidence");
              const records = yield* projections.getThreadRecords(input.threadId, [
                "providerTurns",
              ]);
              const turn = records.providerTurns.find((t) => t.id === input.providerTurnId);
              if (!turn) return yield* fail("work-evidence", input.id, "invalid-evidence");
              if (input.attribution === "whole-turn") {
                value = {
                  ...value,
                  source: "provider-telemetry",
                  usage: turn.turnTokenUsage ?? null,
                  startedAt: turn.startedAt ? DateTime.formatIso(turn.startedAt) : null,
                  completedAt: turn.completedAt ? DateTime.formatIso(turn.completedAt) : null,
                };
              } else if (input.attribution !== "unavailable" && input.attribution !== "partial")
                return yield* fail("work-evidence", input.id, "invalid-evidence");
              // Claim the whole turn even for partial attribution: do not charge one parent turn to many Tickets.
              attributionKey = encodeKey([
                unit.owner.environmentId,
                input.threadId,
                input.providerTurnId,
              ]);
            } else if (unit.owner.parentThreadId !== null && input.attribution !== "unavailable")
              return yield* fail("work-evidence", input.id, "invalid-evidence");
            else if (input.externalSegmentId !== null)
              attributionKey = encodeKey([
                unit.owner.environmentId,
                unit.owner.clientSessionId,
                unit.owner.externalSessionKey,
                input.externalSegmentId,
              ]);
            else if (input.attribution !== "unavailable")
              return yield* fail("work-evidence", input.id, "invalid-evidence");
            if (
              (value.startedAt !== null && !Number.isFinite(Date.parse(value.startedAt))) ||
              (value.completedAt !== null &&
                (!Number.isFinite(Date.parse(value.completedAt)) ||
                  value.startedAt === null ||
                  Date.parse(value.completedAt) < Date.parse(value.startedAt)))
            )
              return yield* fail("work-evidence", input.id, "invalid-evidence");
            if (
              attributionKey !== null &&
              (yield* sql`SELECT id FROM experiment_work_evidence WHERE attribution_key = ${attributionKey}`)
                .length
            )
              return yield* fail("work-evidence", input.id, "conflict");
            yield* sql`INSERT INTO experiment_work_evidence(id,unit_id,attribution_key,payload_json) VALUES (${input.id},${unit.id},${attributionKey},${encodeWorkEvidence(value)})`;
            return value;
          }),
        ),
      ),
  );
  const unionDuration = (spans: readonly { start: number; end: number }[]) => {
    let end = -Infinity;
    let total = 0;
    for (const span of [...spans].sort((a, b) => a.start - b.start)) {
      total += Math.max(0, span.end - Math.max(end, span.start));
      end = Math.max(end, span.end);
    }
    return total;
  };
  const readWork = Effect.fn("ExperimentService.readWork")(function* (
    input: { workUnitId: string },
    reader?: WorkReader,
  ) {
    const unit = yield* getWork(input.workUnitId, reader);
    const allocationRows = yield* persist(
      "work-report",
      unit.id,
      sql<{
        payload_json: string;
      }>`SELECT payload_json FROM experiment_work_allocations WHERE unit_id = ${unit.id} ORDER BY rowid`,
    );
    const allocations = yield* Effect.forEach(allocationRows, (r) =>
      persist("work-report", unit.id, decodeAllocation(r.payload_json)),
    );
    const evidenceRows = yield* persist(
      "work-report",
      unit.id,
      sql<{
        payload_json: string;
      }>`SELECT payload_json FROM experiment_work_evidence WHERE unit_id = ${unit.id} ORDER BY rowid`,
    );
    const evidence = yield* Effect.forEach(evidenceRows, (r) =>
      persist("work-report", unit.id, decodeWorkEvidence(r.payload_json)),
    );
    const tasks = yield* persist(
      "work-report",
      unit.id,
      sql<{
        task_id: string;
        launch_state: string | null;
        thread_id: string;
        binding_json: string;
      }>`SELECT t.task_id,t.thread_id,t.binding_json,COALESCE(e.state,t.launch_state) AS launch_state FROM experiment_work_tasks t LEFT JOIN external_agent_work e ON e.thread_id=t.thread_id WHERE t.unit_id = ${unit.id} ORDER BY t.rowid`,
    );
    const childIntervals: { start: number; end: number }[] = [];
    const supportingIntervals: {
      phase: "execution" | "verification" | "advice";
      start: number;
      end: number;
    }[] = [];
    const parentTurns: ExperimentTurnEvidence[] = [];
    const childTurns: ExperimentTurnEvidence[] = [];
    const runs: ExperimentAssignmentReport["runs"][number][] = [];
    let missingChildren = false;
    const decodeBinding = Schema.decodeUnknownEffect(Schema.fromJsonString(AgentTaskBinding));
    const taskBindings = yield* Effect.forEach(tasks, (r) =>
      persist("work-report", unit.id, decodeBinding(r.binding_json)),
    );
    const recordsFor = (threadId: ThreadId) =>
      projections
        .getThreadRecords(threadId, ["providerTurns", "runs", "attempts", "nodes", "subagents"])
        .pipe(
          Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }),
          (effect) => persist("work-report", unit.id, effect),
        );
    for (let index = 0; index < evidence.length; index++) {
      const item = evidence[index]!;
      if (item.source === "provider-telemetry" && item.threadId !== null) {
        const records = yield* recordsFor(item.threadId);
        const turn = records?.providerTurns.find((t) => t.id === item.providerTurnId);
        if (turn)
          evidence[index] = {
            ...item,
            usage: turn.turnTokenUsage ?? null,
            startedAt: turn.startedAt ? DateTime.formatIso(turn.startedAt) : null,
            completedAt: turn.completedAt ? DateTime.formatIso(turn.completedAt) : null,
          };
        const parentRun = records?.runs.find(
          (r) =>
            r.id ===
            (records.attempts.find((a) => a.id === turn?.runAttemptId)?.runId ??
              records.nodes.find((n) => n.id === turn?.nodeId)?.runId),
        );
        parentTurns.push({
          threadId: item.threadId,
          runId: null,
          providerTurnId: item.providerTurnId!,
          providerInstanceId: unit.orchestratorSelection.instanceId,
          modelSelection: parentRun?.modelSelection ?? null,
          modelSource: parentRun === undefined ? "unknown" : "run-selection",
          status: turn?.status ?? "missing",
          usage: turn?.turnTokenUsage ?? null,
          activeMs:
            turn?.startedAt && turn.completedAt
              ? DateTime.toEpochMillis(turn.completedAt) - DateTime.toEpochMillis(turn.startedAt)
              : null,
        });
      }
    }
    for (const task of tasks) {
      const threadId = ThreadId.make(task.thread_id);
      const records = yield* recordsFor(threadId);
      if (!records) {
        missingChildren = true;
        continue;
      }
      const binding = taskBindings[tasks.indexOf(task)]!;
      for (const run of records.runs.slice(0, 500))
        runs.push({
          threadId,
          runId: run.id,
          status: run.status,
          modelSelection: run.modelSelection,
          requestedAt: DateTime.formatIso(run.requestedAt),
          startedAt: run.startedAt ? DateTime.formatIso(run.startedAt) : null,
          completedAt: run.completedAt ? DateTime.formatIso(run.completedAt) : null,
        });
      if (
        records.runs.length > 500 ||
        records.subagents.length > 0 ||
        records.runs.some(
          (r) =>
            r.startedAt !== null &&
            !records.providerTurns.some(
              (t) => records.attempts.find((a) => a.id === t.runAttemptId)?.runId === r.id,
            ),
        )
      )
        missingChildren = true;
      for (const turn of records.providerTurns.slice(0, 500)) {
        const attempt = records.attempts.find((a) => a.id === turn.runAttemptId);
        const node = records.nodes.find((n) => n.id === turn.nodeId);
        const run = records.runs.find((r) => r.id === (attempt?.runId ?? node?.runId));
        if (!run || (attempt === undefined && node?.id !== run.rootNodeId)) continue;
        if (turn.startedAt && turn.completedAt) {
          const interval = {
            start: DateTime.toEpochMillis(turn.startedAt),
            end: DateTime.toEpochMillis(turn.completedAt),
          };
          childIntervals.push(interval);
          supportingIntervals.push({
            ...interval,
            phase: isConsultingRole(binding.role)
              ? "advice"
              : isReviewerRole(binding.role)
                ? "verification"
                : "execution",
          });
        }
        childTurns.push({
          threadId,
          runId: run.id,
          providerTurnId: turn.id,
          providerInstanceId: run.providerInstanceId,
          modelSelection: run.modelSelection,
          modelSource: "run-selection",
          status: turn.status,
          usage: turn.turnTokenUsage ?? null,
          activeMs:
            turn.startedAt && turn.completedAt
              ? DateTime.toEpochMillis(turn.completedAt) - DateTime.toEpochMillis(turn.startedAt)
              : null,
        });
      }
      if (records.providerTurns.length > 500) missingChildren = true;
    }
    // External counters stay explicitly self-reported; a complete claim is not complete provider coverage.
    const externalTurns = evidence
      .filter((e) => e.source === "self-report" && e.usage !== null)
      .map((e) => ({ usage: e.usage }));
    const outcomes: ExperimentOutcome[] = [];
    for (const id of unit.assignmentIds) {
      const rows = yield* persist(
        "work-report",
        unit.id,
        sql<{
          payload_json: string;
        }>`SELECT payload_json FROM experiment_outcomes WHERE assignment_id = ${id} ORDER BY rowid`,
      );
      outcomes.push(
        ...(yield* Effect.forEach(rows, (r) =>
          persist("work-report", unit.id, decodeOutcome(r.payload_json)),
        )),
      );
    }
    const accepted = outcomes.find(
      (o) =>
        o.kind === "verified-completion" &&
        (o.source === "human-review" || o.source === "independent-evidence") &&
        o.evidence.length > 0,
    );
    const reportTime = yield* nowIso;
    let missingParentTurns = false;
    if (unit.owner.parentThreadId !== null) {
      const parent = yield* recordsFor(unit.owner.parentThreadId);
      const relevant =
        parent?.providerTurns.filter(
          (t) =>
            (t.startedAt === null ||
              DateTime.toEpochMillis(t.startedAt) <=
                Date.parse(accepted?.recordedAt ?? reportTime)) &&
            (t.completedAt === null ||
              DateTime.toEpochMillis(t.completedAt) >= Date.parse(unit.createdAt)),
        ) ?? [];
      missingParentTurns =
        parent === null ||
        relevant.some((t) => !parentTurns.some((p) => p.providerTurnId === t.id));
    }
    const parentUsage = aggregateUsage([...parentTurns, ...externalTurns]);
    const childUsage = aggregateUsage(childTurns);
    const implementationTasks = tasks.filter(
      (task, index) =>
        !(
          isConsultingRole(taskBindings[index]!.role) || isReviewerRole(taskBindings[index]!.role)
        ) && task.launch_state !== "refused",
    );
    const actualAllocation =
      implementationTasks.length > 0
        ? ("delegated" as const)
        : (allocations.at(-1)?.allocation ?? null);
    const parentCoverage: ExperimentWorkReport["parentCoverage"] =
      !missingParentTurns &&
      parentTurns.length > 0 &&
      evidence.every((e) => e.source === "provider-telemetry" && e.attribution === "whole-turn") &&
      parentUsage.status === "complete" &&
      !parentUsage.hasUnattributedSubagentUsage &&
      parentTurns.every((t) => t.activeMs !== null)
        ? "complete"
        : evidence.some((e) => e.usage !== null)
          ? "partial"
          : "unavailable";
    const childCoverage: ExperimentWorkReport["childCoverage"] =
      actualAllocation === "inline" && tasks.length === 0
        ? "not-applicable"
        : childTurns.length === 0
          ? "unavailable"
          : missingChildren ||
              childUsage.status !== "complete" ||
              childUsage.hasUnattributedSubagentUsage ||
              childTurns.some((t) => t.activeMs === null)
            ? "partial"
            : "complete";
    const observedUsage = aggregateUsage([...parentTurns, ...externalTurns, ...childTurns]);
    const complete =
      parentCoverage === "complete" &&
      (childCoverage === "complete" || childCoverage === "not-applicable");
    const usage = complete
      ? observedUsage
      : {
          ...observedUsage,
          status:
            observedUsage.status === "unavailable"
              ? ("unavailable" as const)
              : ("partial" as const),
          inputTokens: null,
          outputTokens: null,
          cachedInputTokens: null,
          cacheCreationTokens: null,
          reasoningTokens: null,
          missingTurns:
            observedUsage.missingTurns +
            (parentCoverage !== "complete" ? 1 : 0) +
            (childCoverage !== "complete" && childCoverage !== "not-applicable" ? 1 : 0),
        };
    const reportedPhaseMs = Object.fromEntries(
      [
        "briefing",
        "startup",
        "wait",
        "execution",
        "inspection",
        "rework",
        "verification",
        "advice",
      ].map((phase) => {
        const items = evidence.filter((e) => e.phase === phase);
        return [
          phase,
          items.length && items.every((e) => e.startedAt !== null && e.completedAt !== null)
            ? unionDuration(
                items.map((e) => ({
                  start: Date.parse(e.startedAt!),
                  end: Date.parse(e.completedAt!),
                })),
              )
            : null,
        ];
      }),
    ) as ExperimentWorkReport["phaseMs"];
    const observedRolePhase = (phase: "advice" | "verification") =>
      unionDuration([
        ...supportingIntervals.filter((i) => i.phase === phase),
        ...evidence
          .filter((e) => e.phase === phase && e.startedAt !== null && e.completedAt !== null)
          .map((e) => ({ start: Date.parse(e.startedAt!), end: Date.parse(e.completedAt!) })),
      ]);
    const childTimingComplete =
      childTurns.length > 0 && childTurns.every((t) => t.activeMs !== null) && !missingChildren;
    const phaseMs =
      tasks.length === 0
        ? reportedPhaseMs
        : {
            ...reportedPhaseMs,
            execution:
              implementationTasks.length === 0
                ? reportedPhaseMs.execution
                : childTimingComplete
                  ? unionDuration(supportingIntervals.filter((i) => i.phase === "execution"))
                  : null,
            advice:
              taskBindings.some((b) => isConsultingRole(b.role)) && childTimingComplete
                ? observedRolePhase("advice")
                : reportedPhaseMs.advice,
            verification:
              taskBindings.some((b) => isReviewerRole(b.role)) && childTimingComplete
                ? observedRolePhase("verification")
                : reportedPhaseMs.verification,
            startup:
              runs.length > 0 && runs.every((r) => r.startedAt !== null)
                ? unionDuration(
                    runs.map((r) => ({
                      start: Date.parse(r.requestedAt),
                      end: Date.parse(r.startedAt!),
                    })),
                  )
                : null,
          };
    const parentIntervals = evidence
      .filter(
        (e) => e.source === "provider-telemetry" && e.startedAt !== null && e.completedAt !== null,
      )
      .map((e) => ({ start: Date.parse(e.startedAt!), end: Date.parse(e.completedAt!) }));
    const overlapMs = complete
      ? unionDuration(
          parentIntervals.flatMap((p) =>
            childIntervals.flatMap((c) =>
              Math.min(p.end, c.end) > Math.max(p.start, c.start)
                ? [{ start: Math.max(p.start, c.start), end: Math.min(p.end, c.end) }]
                : [],
            ),
          ),
        )
      : null;
    const coExposureIds = (yield* assignments({}))
      .filter(
        (a) =>
          a.unitKind !== "work" &&
          ((a.threadId !== null && tasks.some((t) => t.thread_id === a.threadId)) ||
            (a.threadId === unit.owner.parentThreadId &&
              Date.parse(a.assignedAt) <= Date.parse(unit.createdAt))),
      )
      .map((a) => a.id);
    return {
      overlapMs,
      tasks: tasks.map((task, index) => ({
        taskId: task.task_id,
        threadId: ThreadId.make(task.thread_id),
        binding: taskBindings[index]!,
        launchState: task.launch_state,
      })),
      unit,
      allocations,
      evidence,
      assignmentIds: unit.assignmentIds,
      actualAllocation,
      deviations: [
        ...allocations.flatMap((a) => (a.deviationReason === null ? [] : [a.deviationReason])),
        ...parentTurns
          .filter(
            (t) =>
              t.modelSelection !== null &&
              encodeSelection(t.modelSelection) !== encodeSelection(unit.orchestratorSelection),
          )
          .map(() => "observed-parent-selection-changed"),
        ...taskBindings
          .filter((b) => encodeSelection(b.effective) !== encodeSelection(b.requested))
          .map(() => "observed-child-selection-changed"),
      ],
      parentCoverage,
      childCoverage,
      parentUsage,
      childUsage,
      usage,
      observedUsage,
      elapsedToAcceptedMs: accepted
        ? Math.max(0, Date.parse(accepted.recordedAt) - Date.parse(unit.createdAt))
        : null,
      phaseMs,
      independentlySupportedAcceptance: accepted !== undefined,
      outcomes,
      coExposureIds,
      turns: [...parentTurns, ...childTurns],
      runs,
      wallClockMs: accepted
        ? Math.max(0, Date.parse(accepted.recordedAt) - Date.parse(unit.createdAt))
        : null,
      activeMs: complete
        ? unionDuration([
            ...childIntervals,
            ...evidence
              .filter((e) => e.startedAt !== null && e.completedAt !== null)
              .map((e) => ({ start: Date.parse(e.startedAt!), end: Date.parse(e.completedAt!) })),
          ])
        : null,
    } satisfies ExperimentWorkReport;
  });
  const recordOutcome = Effect.fn("ExperimentService.recordOutcome")(
    (input: ExperimentOutcomeInput, reader?: WorkReader) =>
      persist(
        "outcome",
        input.id,
        sql.withTransaction(
          Effect.gen(function* () {
            const assignment = yield* getAssignment(input.assignmentId);
            if (!visibleWork(assignment, reader))
              return yield* fail("outcome", input.id, "not-found");
            if (
              assignment.work !== undefined &&
              reader !== undefined &&
              input.source !== "self-report"
            )
              return yield* fail("outcome", input.id, "invalid-evidence");
            if (assignment.agentTask?.externalOwner !== undefined && reader !== undefined) {
              if (input.source !== "self-report")
                return yield* fail("outcome", input.id, "invalid-evidence");
              if (input.runId !== null) {
                const owner = assignment.agentTask.externalOwner;
                const attempts = yield* sql<{
                  thread_id: string;
                }>`SELECT thread_id FROM external_agent_work WHERE session_key = ${owner.externalSessionKey} AND work_id = ${assignment.agentTask.workId}`;
                const runs = yield* Effect.forEach(attempts, (attempt) =>
                  projections.getThreadRecords(ThreadId.make(attempt.thread_id), ["runs"]),
                );
                if (!runs.some((records) => records.runs.some((run) => run.id === input.runId)))
                  return yield* fail("outcome", input.id, "invalid-evidence");
              }
            }
            if (input.evidence.length === 0 && input.source !== "self-report")
              return yield* fail("outcome", input.id, "invalid-evidence");
            const previous = yield* sql<{
              payload_json: string;
            }>`SELECT payload_json FROM experiment_outcomes WHERE id = ${input.id}`;
            if (previous[0]) {
              const value = yield* decodeOutcome(previous[0].payload_json);
              const { recordedAt: _recordedAt, ...original } = value;
              if (
                encodeOutcome({ ...original, recordedAt: value.recordedAt }) !==
                encodeOutcome({ ...input, recordedAt: value.recordedAt })
              )
                return yield* fail("outcome", input.id, "conflict");
              return value;
            }
            const value: ExperimentOutcome = { ...input, recordedAt: yield* nowIso };
            yield* sql`INSERT INTO experiment_outcomes(id, assignment_id, payload_json) VALUES (${input.id}, ${input.assignmentId}, ${encodeOutcome(value)})`;
            return value;
          }),
        ),
      ),
  );
  const recordWorkOutcome = Effect.fn("ExperimentService.recordWorkOutcome")(
    (input: ExperimentOutcomeInput, reader: WorkReader) =>
      persist(
        "work-outcome",
        input.id,
        Effect.gen(function* () {
          const assignment = yield* getAssignment(input.assignmentId);
          if (
            assignment.unitKind !== "work" ||
            assignment.work === undefined ||
            !visibleWork(assignment, reader)
          )
            return yield* fail("work-outcome", input.id, "not-found");
          return yield* recordOutcome({ ...input, source: "self-report" }, reader);
        }),
      ),
  );
  const readEvidence = Effect.fn("ExperimentService.readEvidence")(function* (
    input: ExperimentEvidenceReadInput,
    reader?: WorkReader,
  ) {
    return yield* persist(
      "evidence",
      input.assignmentId,
      Effect.gen(function* () {
        const assignment = yield* getAssignment(input.assignmentId);
        if (!visibleWork(assignment, reader))
          return yield* fail("evidence", input.assignmentId, "not-found");
        const offset = input.offset ?? 0;
        const limit = Math.min(5, input.limit ?? 1);
        const rows = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM experiment_evidence WHERE assignment_id = ${input.assignmentId} AND episode_id = ${input.episodeId} ORDER BY rowid LIMIT ${limit + 1} OFFSET ${offset}`;
        const evaluationRows = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM experiment_evaluations WHERE assignment_id = ${input.assignmentId} AND episode_id = ${input.episodeId} ORDER BY rowid DESC LIMIT 11`;
        const rollover = yield* sql<{
          id: string;
        }>`SELECT id FROM experiment_evidence WHERE assignment_id = ${input.assignmentId} AND episode_id = ${input.episodeId} AND json_extract(payload_json, '$.recipeRevision') IN (SELECT value FROM json_each(${encodeSnapshot(rolloverRecipes)})) LIMIT 1`;
        const hasMoreCaptures = rows.length > limit;
        const captures = yield* Effect.forEach(rows.slice(0, limit), (row) =>
          decodeEvidence(row.payload_json),
        );
        return {
          rubric: rollover.length > 0 ? rolloverRubric : null,
          captures,
          evaluations: yield* Effect.forEach(evaluationRows.slice(0, 10), (row) =>
            decodeEvaluation(row.payload_json),
          ),
          hasMoreCaptures,
          evaluationsTruncated: evaluationRows.length > 10,
          nextOffset: hasMoreCaptures ? offset + limit : null,
        };
      }),
    );
  });
  const recordEvidence = Effect.fn("ExperimentService.recordEvidence")(
    (input: ExperimentEvidenceInput, reader?: WorkReader) =>
      persist(
        "evidence",
        input.id,
        sql.withTransaction(
          Effect.gen(function* () {
            const assignment = yield* getAssignment(input.assignmentId);
            if (!visibleWork(assignment, reader))
              return yield* fail("evidence", input.id, "not-found");
            if (assignment.threadId === null)
              return yield* fail(
                "evidence",
                input.id,
                "invalid-evidence",
                "the assignment has no thread to hold evidence",
              );
            const id = input.id;
            if (!isExperimentEvidenceInput(input))
              return yield* fail(
                "evidence",
                id,
                "invalid-evidence",
                "the capture does not match the evidence schema",
              );
            const bytes = input.artifacts.reduce(
              (size, a) => size + Buffer.byteLength(a.content ?? "", "utf8"),
              0,
            );
            if (bytes > captureBytes)
              return yield* fail(
                "evidence",
                input.id,
                "invalid-evidence",
                `artifact content is ${bytes} UTF-8 bytes; split it across captures of at most ${captureBytes}`,
              );
            if (input.artifacts.length === 0 && input.missing.length === 0)
              return yield* fail(
                "evidence",
                input.id,
                "invalid-evidence",
                "supply at least one artifact or missing-evidence marker",
              );
            const { runs } = yield* projections.getThreadRecords(assignment.threadId, ["runs"]);
            if (!runs.some((run) => run.id === input.runId))
              return yield* fail(
                "evidence",
                input.id,
                "invalid-evidence",
                `run ${input.runId} is not a run of the assignment's thread`,
              );
            const previousRows = yield* sql<{
              payload_json: string;
            }>`SELECT payload_json FROM experiment_evidence WHERE id = ${input.id}`;
            if (previousRows[0]) {
              const previous = yield* decodeEvidence(previousRows[0].payload_json);
              if (
                encodeEvidence(previous) !==
                encodeEvidence({ ...input, capturedAt: previous.capturedAt })
              )
                return yield* fail(
                  "evidence",
                  input.id,
                  "conflict",
                  "a different capture already has this id; captures are immutable, so append under a new id",
                );
              return previous;
            }
            // Each capture names its own recipe and source, so later evidence (a
            // retrospective agent recovery, or a newer runtime recipe) joins the episode.
            const value: ExperimentEvidence = { ...input, capturedAt: yield* nowIso };
            yield* sql`INSERT INTO experiment_evidence(id, assignment_id, episode_id, payload_json) VALUES (${value.id}, ${value.assignmentId}, ${value.episodeId}, ${encodeEvidence(value)})`;
            return value;
          }),
        ),
      ),
  );
  const recordEvaluation = Effect.fn("ExperimentService.recordEvaluation")(
    (input: ExperimentEvaluationInput, reader?: WorkReader) =>
      persist(
        "evaluation",
        input.id,
        sql.withTransaction(
          Effect.gen(function* () {
            const assignment = yield* getAssignment(input.assignmentId);
            if (!visibleWork(assignment, reader))
              return yield* fail("evaluation", input.id, "not-found");
            if (
              !isExperimentEvaluationInput(input) ||
              input.evidenceIds.length === 0 ||
              input.findings.length === 0 ||
              input.findings.reduce((size, finding) => size + finding.note.length, 0) > 32_000 ||
              input.findings.some(
                (finding) => finding.result !== "unknown" && finding.evidenceIds.length === 0,
              )
            )
              return yield* fail("evaluation", input.id, "invalid-evidence");
            const captures = yield* sql<{
              id: string;
            }>`SELECT id FROM experiment_evidence WHERE assignment_id = ${input.assignmentId} AND episode_id = ${input.episodeId}`;
            const available = new Set(captures.map((row) => row.id));
            if (
              input.evidenceIds.some((id) => !available.has(id)) ||
              input.findings.some((finding) =>
                finding.evidenceIds.some((id) => !input.evidenceIds.includes(id)),
              )
            )
              return yield* fail("evaluation", input.id, "invalid-evidence");
            if (input.supersedesId !== null) {
              const superseded = yield* sql<{
                assignment_id: string;
                episode_id: string;
              }>`SELECT assignment_id, episode_id FROM experiment_evaluations WHERE id = ${input.supersedesId}`;
              if (
                !superseded[0] ||
                superseded[0].assignment_id !== input.assignmentId ||
                superseded[0].episode_id !== input.episodeId ||
                input.supersedesId === input.id
              )
                return yield* fail("evaluation", input.id, "invalid-evidence");
            }
            const previous = yield* sql<{
              payload_json: string;
            }>`SELECT payload_json FROM experiment_evaluations WHERE id = ${input.id}`;
            if (previous[0]) {
              const value = yield* decodeEvaluation(previous[0].payload_json);
              if (
                encodeEvaluation(value) !==
                encodeEvaluation({ ...input, recordedAt: value.recordedAt })
              )
                return yield* fail("evaluation", input.id, "conflict");
              return value;
            }
            const value: ExperimentEvaluation = { ...input, recordedAt: yield* nowIso };
            yield* sql`INSERT INTO experiment_evaluations(id, assignment_id, episode_id, payload_json) VALUES (${value.id}, ${value.assignmentId}, ${value.episodeId}, ${encodeEvaluation(value)})`;
            return value;
          }),
        ),
      ),
  );

  const recordObservation = Effect.fn("ExperimentService.recordObservation")(
    (input: ExperimentObservationInput) =>
      persist(
        "observation",
        input.id,
        sql.withTransaction(
          Effect.gen(function* () {
            yield* getAssignment(input.assignmentId);
            if (input.kind === "native-compaction" && input.evidence.length === 0)
              return yield* fail("observation", input.id, "invalid-evidence");
            const previous = yield* sql<{
              payload_json: string;
            }>`SELECT payload_json FROM experiment_observations WHERE id = ${input.id}`;
            if (previous[0]) {
              const value = yield* decodeObservation(previous[0].payload_json);
              const { recordedAt: _recordedAt, ...original } = value;
              if (
                encodeObservation({ ...original, recordedAt: value.recordedAt }) !==
                encodeObservation({ ...input, recordedAt: value.recordedAt })
              )
                return yield* fail("observation", input.id, "conflict");
              return value;
            }
            const value: ExperimentObservation = { ...input, recordedAt: yield* nowIso };
            yield* sql`INSERT INTO experiment_observations(id, assignment_id, payload_json) VALUES (${input.id}, ${input.assignmentId}, ${encodeObservation(value)})`;
            return value;
          }),
        ),
      ),
  );
  const importHistorical = Effect.fn("ExperimentService.importHistorical")(
    (input: ExperimentHistoricalInput) =>
      persist(
        "import",
        input.unitId,
        sql.withTransaction(
          Effect.gen(function* () {
            const experiment = yield* get(input.experimentId);
            if (experiment.lever === "orchestration-policy")
              return yield* fail("import", input.unitId, "invalid-evidence");
            const variant = experiment.variants.find((v) => v.id === input.variantId);
            if (!variant || !Number.isFinite(Date.parse(input.assignedAt)))
              return yield* fail("import", input.unitId, "invalid-evidence");
            if ((yield* assignments({ experimentId: experiment.id })).length >= 1000)
              return yield* fail("import", input.unitId, "invalid-evidence");
            const unitKind = isThreadLever(experiment.lever) ? "thread" : "task";
            const existing = (yield* assignments({ experimentId: input.experimentId })).find(
              (a) => a.unitKind === unitKind && a.unitId === input.unitId,
            );
            if (existing) return yield* fail("import", input.unitId, "conflict");
            return yield* saveAssignment(
              {
                id: `historical:${encodeKey([experiment.id, unitKind, input.unitId])}`,
                experimentId: experiment.id,
                revision: experiment.revision,
                lever: experiment.lever,
                unitKind,
                unitId: input.unitId,
                threadId: input.threadId,
                projectId: input.projectId,
                taskCategory: input.taskCategory,
                boundaryRunId: null,
                variant,
                assignedModelSelection: input.assignedModelSelection,
                enrollment: "historical",
                assignmentMethod: "observational",
                assignedAt: input.assignedAt,
                codeRevision: input.codeRevision,
                briefRevision: input.briefRevision,
                provenance: input.provenance,
              },
              "historical",
            );
          }),
        ),
      ),
  );

  const report = Effect.fn("ExperimentService.report")(function* (
    input: ExperimentReportInput,
    reader?: WorkReader,
  ) {
    const experiment = yield* get(input.experimentId);
    const samples = yield* assignments({ experimentId: input.experimentId }, reader);
    const offset = input.offset ?? 0;
    const page = samples.slice(offset, offset + Math.min(100, input.limit ?? 100));
    const entries = yield* Effect.forEach(page, (assignment) =>
      Effect.gen(function* () {
        if (assignment.unitKind === "work") {
          const work = yield* readWork({ workUnitId: assignment.unitId }, reader);
          return {
            assignment,
            coExposureIds: work.coExposureIds,
            turns: work.turns,
            runs: work.runs,
            outcomes: work.outcomes,
            observations: [],
            projectionAvailable:
              work.parentCoverage !== "unavailable" || work.childCoverage === "complete",
            descendantCoverage:
              work.childCoverage === "complete" || work.childCoverage === "not-applicable"
                ? ("complete" as const)
                : ("partial" as const),
            telemetryTruncated: false,
            missingThreadIds: [],
            wallClockMs: work.wallClockMs,
            activeMs: work.activeMs,
            waitMs: work.phaseMs.wait,
            usage: work.usage,
          } satisfies ExperimentAssignmentReport;
        }
        if (assignment.threadId === null)
          return yield* fail("report", assignment.id, "invalid-evidence");
        const outcomeRows = yield* persist(
          "report",
          assignment.id,
          sql<{
            payload_json: string;
          }>`SELECT payload_json FROM experiment_outcomes WHERE assignment_id = ${assignment.id} ORDER BY rowid`,
        );
        const observationRows = yield* persist(
          "report",
          assignment.id,
          sql<{
            payload_json: string;
          }>`SELECT payload_json FROM experiment_observations WHERE assignment_id = ${assignment.id} ORDER BY rowid`,
        );
        const outcomes = yield* Effect.forEach(outcomeRows, (r) =>
          persist("report", assignment.id, decodeOutcome(r.payload_json)),
        );
        const observations = yield* Effect.forEach(observationRows, (r) =>
          persist("report", assignment.id, decodeObservation(r.payload_json)),
        );
        const evidenceRows = yield* persist(
          "report",
          assignment.id,
          sql<{
            id: string;
            episode_id: string;
            recipe_revision: string;
            run_id: string;
          }>`SELECT id, episode_id, json_extract(payload_json, '$.recipeRevision') AS recipe_revision, json_extract(payload_json, '$.runId') AS run_id FROM experiment_evidence WHERE assignment_id = ${assignment.id} ORDER BY rowid DESC LIMIT 101`,
        );
        const captures = evidenceRows.slice(0, 100);
        const evaluationRows = yield* persist(
          "report",
          assignment.id,
          sql<{
            id: string;
            episode_id: string;
          }>`SELECT id, episode_id FROM experiment_evaluations WHERE assignment_id = ${assignment.id} ORDER BY rowid DESC LIMIT 101`,
        );
        const episodes: ExperimentEpisodeReport[] = [
          ...new Set(captures.map((capture) => capture.episode_id)),
        ]
          .slice(0, 20)
          .map((id) => ({
            id,
            recipeRevision: captures.findLast((capture) => capture.episode_id === id)!
              .recipe_revision,
            captureIds: captures
              .filter((capture) => capture.episode_id === id)
              .map((capture) => capture.id),
            evaluationIds: evaluationRows
              .slice(0, 100)
              .filter((evaluation) => evaluation.episode_id === id)
              .map((evaluation) => evaluation.id),
          }));
        const episodeSummariesTruncated =
          evidenceRows.length > 100 ||
          evaluationRows.length > 100 ||
          new Set(captures.map((capture) => capture.episode_id)).size > 20;
        const reportNow = Date.parse(yield* nowIso);
        type Records = ProjectionStore.ProjectionRecords<
          "runs" | "attempts" | "nodes" | "subagents" | "providerTurns" | "providerThreads"
        >;
        const recordCache = new Map<ThreadId, Records | null>();
        const readRecords = Effect.fn(function* (threadId: ThreadId) {
          if (recordCache.has(threadId)) return recordCache.get(threadId) ?? null;
          const records = yield* projections
            .getThreadRecords(threadId, [
              "runs",
              "attempts",
              "nodes",
              "subagents",
              "providerTurns",
              "providerThreads",
            ])
            .pipe(
              Effect.catchTags({
                ProjectionStoreThreadNotFoundError: () => Effect.succeed(null),
              }),
              (effect) => persist("report", assignment.id, effect),
            );
          recordCache.set(threadId, records);
          return records;
        });
        const exposureScopes = new Map<ThreadId, Map<string, OrchestrationV2Run>>();
        const turns: ExperimentTurnEvidence[] = [];
        let telemetryTruncated = false;
        const runs: ExperimentAssignmentReport["runs"][number][] = [];
        const missingThreadIds: ThreadId[] = [];
        const queue: {
          threadId: ThreadId;
          taskId: string | null;
          root: boolean;
        }[] = [
          {
            threadId: assignment.threadId,
            taskId: assignment.unitKind === "task" ? assignment.unitId : null,
            root: true,
          },
        ];
        const owner = assignment.agentTask?.externalOwner;
        if (owner !== undefined) {
          // External logical work can have several attempt threads. They have no
          // artificial parent/subagent run; follow the durable ownership records.
          const attempts = yield* persist(
            "report",
            assignment.id,
            sql<{
              thread_id: string;
            }>`SELECT thread_id FROM external_agent_work WHERE session_key = ${owner.externalSessionKey} AND work_id = ${assignment.agentTask!.workId} ORDER BY rowid`,
          );
          queue.splice(
            0,
            queue.length,
            ...attempts.map((attempt) => ({
              threadId: ThreadId.make(attempt.thread_id),
              taskId: null,
              root: true,
            })),
          );
        }
        const visited = new Set<string>();
        const seenTurns = new Set<string>();
        const intervals: { start: number; end: number }[] = [];
        let projectionAvailable = false;
        let hasNativeDescendants = false;
        // Bound a corrupt/cyclic roster without silently calling a truncated report complete.
        while (queue.length > 0 && visited.size < 100) {
          const target = queue.shift()!;
          const visitKey = encodeKey([target.threadId, target.taskId]);
          if (visited.has(visitKey)) continue;
          visited.add(visitKey);
          const records = yield* readRecords(target.threadId);
          if (!records) {
            missingThreadIds.push(target.threadId);
            continue;
          }
          if (target.root) projectionAvailable = true;
          const boundary = target.root
            ? records.runs.find((r) => r.id === assignment.boundaryRunId)
            : undefined;
          const matchingRuns = records.runs.filter((run) => {
            if (target.taskId && run.delegatedTaskId !== target.taskId) return false;
            if (boundary) return run.ordinal >= boundary.ordinal;
            return (
              !target.root ||
              assignment.enrollment === "new" ||
              DateTime.toEpochMillis(run.requestedAt) >= Date.parse(assignment.assignedAt)
            );
          });
          if (matchingRuns.length > 500) telemetryTruncated = true;
          const includedRuns = matchingRuns.slice(0, 500);
          const scope =
            exposureScopes.get(target.threadId) ?? new Map<string, OrchestrationV2Run>();
          for (const run of includedRuns) scope.set(run.id, run);
          exposureScopes.set(target.threadId, scope);
          const runIds = new Set(includedRuns.map((r) => r.id));
          runs.push(
            ...includedRuns.map((r) => ({
              threadId: target.threadId,
              runId: r.id,
              status: r.status,
              modelSelection: r.modelSelection,
              requestedAt: DateTime.formatIso(r.requestedAt),
              startedAt: r.startedAt ? DateTime.formatIso(r.startedAt) : null,
              completedAt: r.completedAt ? DateTime.formatIso(r.completedAt) : null,
            })),
          );
          for (const child of records.subagents.filter(
            (s) => s.runId !== null && runIds.has(s.runId),
          )) {
            if (child.origin === "app_owned" && child.childThreadId)
              queue.push({ threadId: child.childThreadId, taskId: child.id, root: false });
            else hasNativeDescendants = true;
          }
          const attempts = records.attempts.filter((a) => runIds.has(a.runId));
          for (const turn of records.providerTurns) {
            const attempt = attempts.find((a) => a.id === turn.runAttemptId);
            const node = records.nodes.find((n) => n.id === turn.nodeId);
            const run = attempt
              ? includedRuns.find((r) => r.id === attempt.runId)
              : includedRuns.find((r) => r.id === node?.runId);
            if (!run || seenTurns.has(turn.id)) continue;
            // A native child's usage is not a second billable root turn.
            if (node?.kind !== "root_turn" && node?.id !== run.rootNodeId && attempt === undefined)
              continue;
            if (turns.length >= 500) {
              telemetryTruncated = true;
              continue;
            }
            seenTurns.add(turn.id);
            const provider = records.providerThreads.find((p) => p.id === turn.providerThreadId);
            // Provider-thread metadata is mutable: it cannot prove a historical turn's actual model.
            const actual = outcomes.findLast(
              (o) => o.runId === run.id && o.actualModelSelection !== null,
            )?.actualModelSelection;
            const start = turn.startedAt ? DateTime.toEpochMillis(turn.startedAt) : null;
            const end = turn.completedAt ? DateTime.toEpochMillis(turn.completedAt) : null;
            if (start !== null && end !== null) intervals.push({ start, end });
            turns.push({
              threadId: target.threadId,
              runId: run.id,
              providerTurnId: turn.id,
              providerInstanceId:
                actual?.instanceId ??
                attempt?.providerInstanceId ??
                provider?.providerInstanceId ??
                run.providerInstanceId,
              modelSelection: actual ?? run.modelSelection,
              modelSource: actual ? "recorded-treatment" : "run-selection",
              status: turn.status,
              usage: turn.turnTokenUsage ?? null,
              activeMs: start !== null && end !== null ? Math.max(0, end - start) : null,
            });
          }
        }
        // A child's result was also exposed to the policy/model that launched its task.
        // Follow exact app-owned task links, rather than every treatment on an ancestor thread.
        const ancestorQueue = [...exposureScopes.entries()].map(([threadId, scope]) => ({
          threadId,
          scope,
        }));
        const visitedAncestors = new Set<string>();
        while (ancestorQueue.length > 0 && visitedAncestors.size < 100) {
          const target = ancestorQueue.shift()!;
          const key = encodeKey([target.threadId, ...target.scope.keys()]);
          if (visitedAncestors.has(key)) continue;
          visitedAncestors.add(key);
          const records = yield* readRecords(target.threadId);
          const parentId = records?.thread.lineage.parentThreadId;
          if (!parentId) continue;
          const parent = yield* readRecords(parentId);
          if (!parent) {
            telemetryTruncated = true;
            continue;
          }
          const parentRunIds = new Set(
            parent.subagents
              .filter(
                (child) =>
                  child.origin === "app_owned" &&
                  child.childThreadId === target.threadId &&
                  [...target.scope.values()].some((run) => run.delegatedTaskId === child.id),
              )
              .flatMap((child) => (child.runId ? [child.runId] : [])),
          );
          const parentRuns = parent.runs.filter((run) => parentRunIds.has(run.id));
          if (parentRuns.length === 0) continue;
          const scope = exposureScopes.get(parentId) ?? new Map<string, OrchestrationV2Run>();
          for (const run of parentRuns) scope.set(run.id, run);
          exposureScopes.set(parentId, scope);
          ancestorQueue.push({
            threadId: parentId,
            scope: new Map(parentRuns.map((run) => [run.id, run])),
          });
        }
        if (ancestorQueue.length > 0) telemetryTruncated = true;
        const coExposureIds: string[] = [];
        for (const [threadId, scope] of exposureScopes) {
          const records = yield* readRecords(threadId);
          if (!records) continue;
          const candidates = yield* assignments({ threadId });
          for (const candidate of candidates) {
            if (
              candidate.id === assignment.id ||
              candidate.assignmentMethod !== assignment.assignmentMethod
            )
              continue;
            const boundary = records.runs.find((run) => run.id === candidate.boundaryRunId);
            if (candidate.boundaryRunId !== null && !boundary) {
              telemetryTruncated = true;
              continue;
            }
            const applies = [...scope.values()].some((run) => {
              if (candidate.unitKind === "task" && candidate.unitId !== run.delegatedTaskId)
                return false;
              if (boundary && run.ordinal < boundary.ordinal) return false;
              // An immutable future enrollment is not exposure to already completed work.
              const latestApplicableTime = run.completedAt
                ? DateTime.toEpochMillis(run.completedAt)
                : reportNow;
              return Date.parse(candidate.assignedAt) <= latestApplicableTime;
            });
            if (applies) coExposureIds.push(candidate.id);
          }
        }
        missingThreadIds.push(...queue.map((q) => q.threadId));
        const missingStartedRuns = runs.filter(
          (run) =>
            run.startedAt !== null &&
            !turns.some((turn) => turn.threadId === run.threadId && turn.runId === run.runId),
        );
        const completeDurations =
          missingStartedRuns.length === 0 &&
          runs.length > 0 &&
          runs.every((r) => r.completedAt !== null) &&
          turns.every((t) => t.activeMs !== null);
        // Union parallel children with their parent so elapsed execution is not double-counted.
        const wallClockMs = completeDurations
          ? unionDuration(
              runs.map((r) => ({
                start: Date.parse(r.requestedAt),
                end: Date.parse(r.completedAt!),
              })),
            )
          : null;
        const activeMs = completeDurations && turns.length > 0 ? unionDuration(intervals) : null;
        const observedUsage = aggregateUsage(turns);
        const incompleteDescendants =
          telemetryTruncated ||
          missingThreadIds.length > 0 ||
          hasNativeDescendants ||
          observedUsage.hasUnattributedSubagentUsage;
        const usage: ExperimentAssignmentReport["usage"] = {
          ...observedUsage,
          status:
            (incompleteDescendants || missingStartedRuns.length > 0) &&
            observedUsage.status !== "unavailable"
              ? "partial"
              : observedUsage.status,
          missingTurns: observedUsage.missingTurns + missingStartedRuns.length,
          inputTokens: missingStartedRuns.length > 0 ? null : observedUsage.inputTokens,
          outputTokens: missingStartedRuns.length > 0 ? null : observedUsage.outputTokens,
          cachedInputTokens: missingStartedRuns.length > 0 ? null : observedUsage.cachedInputTokens,
          cacheCreationTokens:
            missingStartedRuns.length > 0 ? null : observedUsage.cacheCreationTokens,
          reasoningTokens: missingStartedRuns.length > 0 ? null : observedUsage.reasoningTokens,
          hasUnattributedSubagentUsage: incompleteDescendants,
        };
        // Each setup cut point starts a new segment of its thread's runs.
        const cuts = observations.flatMap((observation) =>
          observation.kind === "setup-change"
            ? runs.filter((run) => run.runId === observation.runId)
            : [],
        );
        const setupSegment = (run: { threadId: ThreadId; requestedAt: string }) =>
          cuts.filter((cut) => cut.threadId === run.threadId && cut.requestedAt <= run.requestedAt)
            .length;
        const entry: ExperimentAssignmentReport = {
          assignment,
          coExposureIds: [...new Set(coExposureIds)],
          turns,
          runs: runs.map((run) => ({ ...run, setupSegment: setupSegment(run) })),
          outcomes,
          observations,
          // An episode whose captures fall on both sides of a cut is reported once per
          // side, each with only its own captures.
          episodes: episodes.flatMap((episode) => {
            const bySegment = new Map<number | undefined, string[]>();
            for (const captureId of episode.captureIds.toReversed()) {
              const runId = captures.find((capture) => capture.id === captureId)?.run_id;
              const run = runs.find((candidate) => candidate.runId === runId);
              const segment = run === undefined ? undefined : setupSegment(run);
              bySegment.set(segment, [...(bySegment.get(segment) ?? []), captureId]);
            }
            return [...bySegment].map(([segment, captureIds]) => ({
              ...episode,
              captureIds: captureIds.toReversed(),
              ...(segment === undefined ? {} : { setupSegment: segment }),
            }));
          }),
          episodeSummariesTruncated,
          projectionAvailable,
          descendantCoverage:
            missingThreadIds.length > 0 ||
            hasNativeDescendants ||
            usage.hasUnattributedSubagentUsage
              ? "partial"
              : "complete",
          telemetryTruncated,
          missingThreadIds: [...new Set(missingThreadIds)],
          wallClockMs,
          activeMs,
          waitMs:
            wallClockMs !== null && activeMs !== null && activeMs <= wallClockMs
              ? wallClockMs - activeMs
              : null,
          usage,
        };
        return entry;
      }),
    );
    const workCohort =
      experiment.lever === "orchestration-policy"
        ? yield* Effect.forEach(samples, (s) => readWork({ workUnitId: s.unitId }, reader))
        : [];
    const workRows =
      experiment.lever === "orchestration-policy"
        ? yield* persist(
            "report",
            experiment.id,
            sql<{
              payload_json: string;
            }>`SELECT payload_json FROM experiment_work_units ORDER BY rowid`,
          )
        : [];
    const exclusions = [] as { unit: ExperimentWorkUnit; reason: string }[];
    for (const row of workRows) {
      const unit = yield* persist("report", experiment.id, decodeWork(row.payload_json));
      if (!visibleUnit(unit, reader)) continue;
      const excluded = unit.exclusions.find((e) => e.experimentId === experiment.id);
      if (excluded) exclusions.push({ unit, reason: excluded.reason });
    }
    const policySummary = experiment.variants.map((variant) => {
      const cohort = workCohort.filter(
        (w) => samples.find((a) => a.unitId === w.unit.id)?.variant.id === variant.id,
      );
      const elapsed = cohort.flatMap((w) =>
        w.elapsedToAcceptedMs === null ? [] : [w.elapsedToAcceptedMs],
      );
      const usageReports = cohort.map((w) => w.usage);
      const sum = (
        key:
          | "inputTokens"
          | "outputTokens"
          | "cachedInputTokens"
          | "cacheCreationTokens"
          | "reasoningTokens",
      ) =>
        !usageReports.length || usageReports.some((u) => u[key] === null)
          ? null
          : usageReports.reduce((total, u) => total + u[key]!, 0);
      return {
        assignedPolicy: variant.allocationPolicy!,
        assignedCount: cohort.length,
        actualInlineCount: cohort.filter((w) => w.actualAllocation === "inline").length,
        actualDelegatedCount: cohort.filter((w) => w.actualAllocation === "delegated").length,
        allocationUnknownCount: cohort.filter((w) => w.actualAllocation === null).length,
        deviationCount: cohort.filter((w) => w.deviations.length > 0).length,
        independentlyAcceptedCount: cohort.filter((w) => w.independentlySupportedAcceptance).length,
        failureCount: cohort.filter(
          (w) =>
            w.outcomes.some((o) => o.kind === "failure") ||
            w.runs.some((r) => r.status === "failed") ||
            w.tasks.some((t) => t.launchState === "refused"),
        ).length,
        cancellationCount: cohort.filter(
          (w) =>
            w.outcomes.some((o) => o.kind === "cancellation") ||
            w.runs.some((r) => r.status === "cancelled") ||
            w.tasks.some((t) => t.launchState === "cancelled"),
        ).length,
        incompleteCount: cohort.filter((w) => !w.independentlySupportedAcceptance).length,
        missingParentCount: cohort.filter((w) => w.parentCoverage !== "complete").length,
        incompleteChildCount: cohort.filter(
          (w) => w.childCoverage !== "complete" && w.childCoverage !== "not-applicable",
        ).length,
        acceptedElapsed: {
          n: elapsed.length,
          meanMs: elapsed.length ? elapsed.reduce((a, b) => a + b, 0) / elapsed.length : null,
          minMs: elapsed.length ? Math.min(...elapsed) : null,
          maxMs: elapsed.length ? Math.max(...elapsed) : null,
        },
        usage: {
          status: usageReports.every((u) => u.status === "unavailable")
            ? ("unavailable" as const)
            : usageReports.some((u) => u.status !== "complete")
              ? ("partial" as const)
              : ("complete" as const),
          inputTokens: sum("inputTokens"),
          outputTokens: sum("outputTokens"),
          cachedInputTokens: sum("cachedInputTokens"),
          cacheCreationTokens: sum("cacheCreationTokens"),
          reasoningTokens: sum("reasoningTokens"),
          missingTurns: usageReports.reduce((n, u) => n + u.missingTurns, 0),
          partialTurns: usageReports.reduce((n, u) => n + u.partialTurns, 0),
          hasUnattributedSubagentUsage: usageReports.some((u) => u.hasUnattributedSubagentUsage),
        },
      };
    });
    const scopeCounts = new Map<
      string,
      { scope: "change" | "spec" | "unscoped"; variantId: string; count: number }
    >();
    if (experiment.lever === "reviewer")
      for (const sample of samples) {
        const scope = sample.agentTask?.review?.scope ?? "unscoped";
        const key = encodeKey([scope, sample.variant.id]);
        const entry = scopeCounts.get(key) ?? { scope, variantId: sample.variant.id, count: 0 };
        scopeCounts.set(key, { ...entry, count: entry.count + 1 });
      }
    return {
      ...(experiment.lever !== "reviewer" ? {} : { reviewScopes: [...scopeCounts.values()] }),
      ...(experiment.lever !== "orchestration-policy"
        ? {}
        : {
            work: workCohort.slice(offset, offset + page.length),
            policySummary,
            exclusions,
            uncertainty:
              "Descriptive intention-to-treat totals for all enrolled units; actual allocation and attribution are parent judgements. Missing or self-reported parent counters prevent complete total usage. Heterogeneous small samples do not establish significance or a winner. Provider selections are recorded requests, not proof of actual model or charges.",
          }),
      experiment,
      assignments: entries,
      totalAssignments: samples.length,
      offset,
      hasMore: offset + page.length < samples.length,
      randomizedCount: samples.filter((a) => a.assignmentMethod === "randomized").length,
      observationalCount: samples.filter((a) => a.assignmentMethod === "observational").length,
      readAt: yield* nowIso,
    } satisfies ExperimentReport;
  });
  return ExperimentService.of({
    enrollWork,
    allocateWork,
    recordWorkEvidence,
    readWork,
    workDispatchPolicy,
    registerWorkTask,
    recordWorkTaskLaunch,
    recordWorkOutcome,
    create,
    transition,
    list,
    assignments,
    assign,
    assignForThread: (input) => assign({ ...input, unitKind: "thread", unitId: input.threadId }),
    assignForTask: (input) => assign({ ...input, unitKind: "task" }),
    recordOutcome,
    recordObservation,
    recordEvidence,
    readEvidence,
    recordEvaluation,
    importHistorical,
    report,
  });
});

export const layer = Layer.effect(ExperimentService, make).pipe(Layer.provide(PolicyStore.layer));
