import {
  Experiment,
  ExperimentAssignment,
  ExperimentOutcome,
  ExperimentObservation,
  ExperimentError,
  ExperimentDefinition,
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
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

type WorkReader = {
  readonly environmentId: string;
  readonly clientSessionId?: string | undefined;
  readonly threadId?: string | undefined;
};
const visibleWork = (assignment: ExperimentAssignment, reader: WorkReader | undefined) => {
  const owner = assignment.agentTask?.externalOwner;
  return (
    reader === undefined ||
    owner === undefined ||
    assignment.threadId === reader.threadId ||
    (owner.clientSessionId === reader.clientSessionId &&
      owner.environmentId === reader.environmentId)
  );
};

export class ExperimentService extends Context.Service<
  ExperimentService,
  {
    readonly create: (input: ExperimentDefinition) => Effect.Effect<Experiment, ExperimentError>;
    readonly transition: (
      input: ExperimentTransitionInput,
    ) => Effect.Effect<Experiment, ExperimentError>;
    readonly list: () => Effect.Effect<ReadonlyArray<Experiment>, ExperimentError>;
    readonly assignments: (
      input: ExperimentAssignmentsInput,
      reader?: WorkReader,
    ) => Effect.Effect<ReadonlyArray<ExperimentAssignment>, ExperimentError>;
    readonly getRolloverAssignment: (
      threadId: ThreadId,
    ) => Effect.Effect<ExperimentAssignment | null, ExperimentError>;
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
const jsonAssignment = Schema.fromJsonString(ExperimentAssignment);
const jsonOutcome = Schema.fromJsonString(ExperimentOutcome);
const jsonObservation = Schema.fromJsonString(ExperimentObservation);
const encodeAssignment = Schema.encodeSync(jsonAssignment);
const encodeOutcome = Schema.encodeSync(jsonOutcome);
const encodeObservation = Schema.encodeSync(jsonObservation);
const jsonExperiment = Schema.fromJsonString(Experiment);
const encodeExperiment = Schema.encodeSync(jsonExperiment);
const decodeExperiment = Schema.decodeUnknownEffect(jsonExperiment);
const decodeAssignment = Schema.decodeUnknownEffect(jsonAssignment);
const decodeOutcome = Schema.decodeUnknownEffect(jsonOutcome);
const decodeObservation = Schema.decodeUnknownEffect(jsonObservation);
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
function conflicts(a: Experiment, b: Experiment): boolean {
  return (
    a.lever === b.lever &&
    overlaps(a.eligibility.projectIds, b.eligibility.projectIds) &&
    overlaps(a.eligibility.models, b.eligibility.models) &&
    overlaps(a.eligibility.taskCategories, b.eligibility.taskCategories)
  );
}
function validDefinition(input: ExperimentDefinition, now: string): boolean {
  return (
    input.variants.length >= 2 &&
    new Set(input.variants.map((v) => v.id)).size === input.variants.length &&
    Number.isFinite(Date.parse(input.endsAt)) &&
    Date.parse(input.endsAt) > Date.parse(now) &&
    input.variants.every((v) =>
      input.lever === "rollover"
        ? v.rollover !== undefined &&
          v.rollover.softLimit < v.rollover.hardLimit &&
          v.modelSelection === undefined
        : v.modelSelection !== undefined && v.rollover === undefined,
    ) &&
    (input.lever !== "rollover" || input.eligibility.taskCategories.length === 0)
  );
}

/** A missing turn count cannot become a zero or a complete aggregate. */
function aggregateUsage(
  turns: readonly ExperimentTurnEvidence[],
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
  const persist = <A, E>(operation: string, entityId: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.mapError((cause) =>
        isExperimentError(cause)
          ? cause
          : new ExperimentError({ operation, entityId, reason: "persistence", cause }),
      ),
    );
  const fail = (operation: string, entityId: string, reason: ExperimentError["reason"]) =>
    Effect.fail(new ExperimentError({ operation, entityId, reason }));

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
      sql<{
        payload_json: string;
      }>`SELECT payload_json FROM experiment_assignments WHERE (${input.experimentId ?? null} IS NULL OR experiment_id = ${input.experimentId ?? null}) AND (${input.threadId ?? null} IS NULL OR thread_id = ${input.threadId ?? null}) ORDER BY rowid`,
    );
    const decoded = yield* Effect.forEach(rows, (row) =>
      persist("assignments", "", decodeAssignment(row.payload_json)),
    );
    return decoded.filter((assignment) => visibleWork(assignment, reader));
  });
  const getRolloverAssignment = Effect.fn("ExperimentService.getRolloverAssignment")(function* (
    threadId: ThreadId,
  ) {
    const recorded = yield* assignments({ threadId });
    return (
      recorded.find(
        (assignment) =>
          assignment.assignmentMethod === "randomized" &&
          assignment.lever === "rollover" &&
          assignment.unitKind === "thread" &&
          assignment.unitId === threadId &&
          assignment.variant.rollover !== undefined,
      ) ?? null
    );
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
  const create = Effect.fn("ExperimentService.create")(function* (input: ExperimentDefinition) {
    const now = yield* nowIso;
    if ((yield* list()).length >= 1000)
      return yield* fail("create", input.id, "invalid-definition");
    if (!isExperimentDefinition(input) || !validDefinition(input, now))
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
      sql`INSERT INTO experiment_assignments(id, experiment_id, unit_kind, unit_id, thread_id, stratum, variant_id, assignment_method, payload_json) VALUES (${assignment.id}, ${assignment.experimentId}, ${assignment.unitKind}, ${assignment.unitId}, ${assignment.threadId}, ${stratum}, ${assignment.variant.id}, ${assignment.assignmentMethod}, ${encodeAssignment(assignment)})`,
    );
    return assignment;
  });
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
          const now = yield* nowIso;
          const result = (yield* assignments(
            input.agentTask?.externalOwner === undefined ? { threadId: input.threadId } : {},
          )).filter(
            (a) =>
              a.unitKind === input.unitKind &&
              a.unitId === input.unitId &&
              a.assignmentMethod === "randomized",
          );
          const experiments = yield* list();
          const stratum = encodeKey([
            input.projectId,
            input.modelSelection.instanceId,
            input.modelSelection.model,
            input.taskCategory ?? null,
          ]);
          for (const experiment of experiments) {
            if (
              result.some((a) => a.experimentId === experiment.id) ||
              experiment.status !== "running" ||
              Date.parse(experiment.endsAt) <= Date.parse(now)
            )
              continue;
            if (
              (experiment.lever === "rollover") !== (input.unitKind === "thread") ||
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
            const variant = experiment.variants.find((v) => v.id === input.variantId);
            if (!variant || !Number.isFinite(Date.parse(input.assignedAt)))
              return yield* fail("import", input.unitId, "invalid-evidence");
            if ((yield* assignments({ experimentId: experiment.id })).length >= 1000)
              return yield* fail("import", input.unitId, "invalid-evidence");
            const unitKind = experiment.lever === "rollover" ? "thread" : "task";
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
              Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }),
              (effect) => persist("report", assignment.id, effect),
            );
          recordCache.set(threadId, records);
          return records;
        });
        const exposureScopes = new Map<ThreadId, Map<string, OrchestrationV2Run>>();
        const turns: ExperimentTurnEvidence[] = [];
        let telemetryTruncated = false;
        const runs: ExperimentAssignmentReport["runs"][number][] = [];
        const missingThreadIds: ExperimentAssignment["threadId"][] = [];
        const queue: {
          threadId: ExperimentAssignment["threadId"];
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
        const unionDuration = (spans: readonly { start: number; end: number }[]) => {
          const ordered = [...spans].sort((a, b) => a.start - b.start);
          let total = 0;
          let end = -Infinity;
          for (const span of ordered) {
            total += Math.max(0, span.end - Math.max(end, span.start));
            end = Math.max(end, span.end);
          }
          return total;
        };
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
        const entry: ExperimentAssignmentReport = {
          assignment,
          coExposureIds: [...new Set(coExposureIds)],
          turns,
          runs,
          outcomes,
          observations,
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
    return {
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
    create,
    transition,
    getRolloverAssignment,
    list,
    assignments,
    assign,
    assignForThread: (input) => assign({ ...input, unitKind: "thread", unitId: input.threadId }),
    assignForTask: (input) => assign({ ...input, unitKind: "task" }),
    recordOutcome,
    recordObservation,
    importHistorical,
    report,
  });
});

export const layer = Layer.effect(ExperimentService, make);
