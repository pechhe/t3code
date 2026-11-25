import {
  ChampionError,
  type ChampionActivity,
  ChampionLearningContent,
  ChampionDetail,
  ChampionExecutionAttempt,
  ChampionLearningRevision,
  ChampionMeasurement,
  type ChampionMeasurementAdmission,
  type ChampionMeasurementStartInput,
  type ChampionLearningRecordInput,
  type ChampionLearningContributor,
  type ChampionLearningQueryInput,
  type ChampionLearningQueryResult,
  type ChampionRuntimeState,
  AgentTaskBinding,
  type AgentTaskRequest,
  type ModelSelection,
  ThreadId,
  NodeId,
  type RunId,
  type CommandId,
  type MessageId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Semaphore from "effect/Semaphore";
import * as DateTime from "effect/DateTime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Option from "effect/Option";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";

// Only the managed launch path supplies this after prepare and validate, under its lock.
export interface Admission {
  readonly ownerThreadId: ThreadId;
  readonly parentRunId: RunId;
  readonly binding: AgentTaskBinding;
  readonly projectId: ChampionDetail["champion"]["projectId"];
  readonly workspacePath: string;
  readonly selection: ModelSelection;
  readonly commandId: CommandId;
  readonly taskId: NodeId;
  readonly childThreadId: ThreadId;
  readonly messageId: MessageId;
  readonly clientRequestId: string;
  readonly followup: boolean;
  /** The messages of the owner's active run's restart ancestry: a measurement's check must be among them. */
  readonly runMessageIds?: ReadonlyArray<string>;
}
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const terminal = (state: string) => ["completed", "failed", "cancelled"].includes(state);
/** Read-only measurements a champion may have running, and may be admitted in a rolling day. */
const MAX_ACTIVE_ATTEMPTS = 2;
const MAX_ADMITTED_ATTEMPTS_PER_DAY = 6;
const MEASUREMENT_WORK_PREFIX = "champion-measurement:";
export const isMeasurementWorkId = (workId: string | undefined) =>
  workId?.startsWith(MEASUREMENT_WORK_PREFIX) === true;
const measurementIdOf = (workId: string) => workId.slice(MEASUREMENT_WORK_PREFIX.length);
/** Two models count as one when only a provider prefix tells them apart. */
export const modelIdentity = (model: string) =>
  model.slice(model.lastIndexOf("/") + 1).toLowerCase();
const isChampionError = Schema.is(ChampionError);
const failure = (cause: unknown) =>
  isChampionError(cause) ? cause : new ChampionError({ reason: "unavailable", cause });
const invalidBecause = (detail: string) => new ChampionError({ reason: "invalid", detail });
const conflict = () => new ChampionError({ reason: "conflict" });
const conflictBecause = (detail: string) => new ChampionError({ reason: "conflict", detail });
const refused = (detail?: string) =>
  new ChampionError({ reason: "unauthorized", ...(detail === undefined ? {} : { detail }) });
const decodeDoc = Schema.decodeUnknownEffect(Schema.fromJsonString(ChampionDetail));
const decodeMeasurement = Schema.decodeUnknownEffect(Schema.fromJsonString(ChampionMeasurement));
const checkRowSchema = Schema.Struct({
  kind: Schema.Literals(["setup", "check"]),
  metrics: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      version: Schema.Int,
      collect: Schema.optional(Schema.Unknown),
    }),
  ),
});
const decodeCheckRow = Schema.decodeUnknownEffect(Schema.fromJsonString(checkRowSchema));
const sameLearningContent = Schema.toEquivalence(ChampionLearningContent);
const decodeLearning = Schema.decodeUnknownEffect(Schema.fromJsonString(ChampionLearningRevision));
const decodeExecution = Schema.decodeUnknownEffect(Schema.fromJsonString(ChampionExecutionAttempt));

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* Threads.ThreadManagementService;
  const random = yield* SecureRandom.SecureRandom;
  const lock = yield* Semaphore.make(1);
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const uuid = random.uuidV4().pipe(Effect.mapError(failure));
  const atomic = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    lock.withPermits(1)(sql.withTransaction(effect)).pipe(Effect.mapError(failure));
  const read = Effect.fn("ChampionEvidence.read")(function* (id: string) {
    const [row] = yield* sql<{
      document_json: string;
    }>`SELECT document_json FROM champions WHERE id = ${id}`.pipe(Effect.mapError(failure));
    if (!row) return yield* new ChampionError({ reason: "not-found" });
    return yield* decodeDoc(row.document_json).pipe(Effect.mapError(failure));
  });
  const readMeasurement = Effect.fn("ChampionEvidence.readMeasurement")(function* (id: string) {
    const [row] = yield* sql<{
      document_json: string;
    }>`SELECT document_json FROM champion_measurements WHERE id = ${id}`.pipe(
      Effect.mapError(failure),
    );
    if (!row) return yield* new ChampionError({ reason: "not-found" });
    return yield* decodeMeasurement(row.document_json).pipe(Effect.mapError(failure));
  });
  const saveMeasurement = Effect.fn("ChampionEvidence.saveMeasurement")(function* (
    value: ChampionMeasurement,
  ) {
    yield* sql`UPDATE champion_measurements SET state = CASE WHEN state IN ('completed','failed','cancelled') THEN state ELSE ${value.state} END, document_json = json_set(${json(value)}, '$.state', CASE WHEN state IN ('completed','failed','cancelled') THEN state ELSE ${value.state} END) WHERE id = ${value.measurementId}`;
  }, Effect.mapError(failure));
  /** One count for every read-only measurement a champion starts. */
  const capacityFull = Effect.fn("ChampionEvidence.capacityFull")(function* (championId: string) {
    const since = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { days: 1 }));
    const [counts] = yield* sql<{
      active: number | null;
      recent: number | null;
    }>`SELECT SUM(CASE WHEN state IN ('admitted','unknown','accepted') THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN at > ${since} THEN 1 ELSE 0 END) AS recent FROM (SELECT state, admitted_at AS at FROM champion_measurements WHERE champion_id = ${championId} AND admitted_at IS NOT NULL)`;
    return (
      (counts?.active ?? 0) >= MAX_ACTIVE_ATTEMPTS ||
      (counts?.recent ?? 0) >= MAX_ADMITTED_ATTEMPTS_PER_DAY
    );
  }, Effect.mapError(failure));
  /** The check must still be this owner's unreported, uncancelled, current check, entered through its own run. */
  const liveCheck = Effect.fn("ChampionEvidence.liveCheck")(function* (
    doc: ChampionDetail,
    checkId: string,
    ownerThreadId: ThreadId,
    runMessageIds: ReadonlyArray<string>,
  ) {
    const [row] = yield* sql<{
      champion_id: string;
      thread_id: string;
      message_id: string;
      status: string;
      document_json: string;
    }>`SELECT champion_id, thread_id, message_id, status, document_json FROM champion_checks WHERE id = ${checkId}`.pipe(
      Effect.mapError(failure),
    );
    if (
      !row ||
      row.champion_id !== doc.champion.id ||
      row.thread_id !== ownerThreadId ||
      row.status !== "pending" ||
      doc.champion.outstandingCheckId !== checkId ||
      !runMessageIds.includes(row.message_id)
    )
      return yield* refused(
        "A measurement belongs to this owner's current check: unreported, uncancelled and entered through the run that is making this request.",
      );
    const check = yield* decodeCheckRow(row.document_json).pipe(Effect.mapError(failure));
    if (check.kind !== "check")
      return yield* refused("A measurement belongs to a check, not to setup.");
    return check;
  });
  const measurementForRequest = Effect.fn("ChampionEvidence.measurementForRequest")(function* (
    ownerThreadId: ThreadId,
    request: AgentTaskRequest | undefined,
  ) {
    if (!request || !isMeasurementWorkId(request.workId)) return undefined;
    const [row] = yield* sql<{
      document_json: string;
    }>`SELECT m.document_json FROM champion_measurements m JOIN champions c ON c.id = m.champion_id WHERE m.id = ${measurementIdOf(request.workId)} AND json_extract(c.document_json, '$.champion.ownerThreadId') = ${ownerThreadId}`;
    return row === undefined ? undefined : yield* decodeMeasurement(row.document_json);
  }, Effect.mapError(failure));
  const signature = Effect.fn("ChampionEvidence.learningSignature")(function* (
    id: string,
    topic: string,
  ) {
    const [row] = yield* sql<{
      count: number;
      high: number | null;
    }>`SELECT COUNT(*) AS count, MAX(r.rowid) AS high FROM champion_learning_heads h JOIN champion_learning_revisions r ON r.id = h.revision_id WHERE h.champion_id = ${id} AND r.topic = ${topic}`;
    return `${row?.count ?? 0}:${row?.high ?? 0}`;
  }, Effect.mapError(failure));
  const uncertain = (
    revision: ChampionLearningRevision,
    at: string,
    observations: ChampionLearningQueryInput["observations"],
  ) =>
    (revision.reviewAt !== null && revision.reviewAt <= at) ||
    revision.versionConditions.some((condition) =>
      observations.some(
        (observed) =>
          observed.component === condition.component &&
          observed.version !== null &&
          observed.observedAt > revision.recordedAt &&
          observed.observedAt <= at &&
          observed.version !== condition.version,
      ),
    );
  const learningQuery = Effect.fn("ChampionEvidence.learningQuery")(function* (
    input: ChampionLearningQueryInput,
  ): Effect.fn.Return<ChampionLearningQueryResult, ChampionError> {
    yield* read(input.id);
    return yield* atomic(
      Effect.gen(function* () {
        const at = yield* now;
        const limit = input.limit ?? 10;
        const rows = yield* sql<{
          document_json: string;
          is_current: number;
        }>`SELECT r.document_json, CASE WHEN h.revision_id = r.id THEN 1 ELSE 0 END AS is_current FROM champion_learning_revisions r LEFT JOIN champion_learning_heads h ON h.champion_id = r.champion_id AND h.learning_id = r.learning_id WHERE r.champion_id = ${input.id} AND r.topic = ${input.topic} AND r.id > ${input.cursor ?? ""} AND (${input.revisionId ?? null} IS NULL OR r.id = ${input.revisionId ?? null}) AND (${input.revisionId !== undefined || input.includeSuperseded === true ? 1 : 0} = 1 OR h.revision_id = r.id) ORDER BY r.id LIMIT ${limit + 1}`;
        const revisions: ChampionLearningRevision[] = [];
        let size = 0;
        let cursor: string | null = null;
        let consumed = 0;
        for (const row of rows.slice(0, limit)) {
          const value = yield* decodeLearning(row.document_json).pipe(Effect.mapError(failure));
          const isUncertain = row.is_current !== 1 || uncertain(value, at, input.observations);
          const revision = {
            ...value,
            isCurrent: row.is_current === 1,
            applicabilityState: isUncertain ? ("uncertain" as const) : ("current" as const),
          };
          const bytes = new TextEncoder().encode(json(revision)).length;
          if ((!input.due || isUncertain) && size + bytes > 60_000) break;
          consumed += 1;
          cursor = value.id;
          if (!input.due || isUncertain) {
            revisions.push(revision);
            size += bytes;
          }
        }
        const receiptId = yield* uuid;
        const nextCursor = rows.length > consumed ? cursor : null;
        const expires = DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes: 15 }));
        const validUntil = revisions.reduce(
          (expiry, revision) =>
            revision.reviewAt !== null && revision.reviewAt > at && revision.reviewAt < expiry
              ? revision.reviewAt
              : expiry,
          expires,
        );
        const admissible =
          input.revisionId === undefined && input.due !== true && input.includeSuperseded !== true;
        const receipt = {
          admissible,
          signature: yield* signature(input.id, input.topic),
          versions: revisions.map((revision) => revision.id),
          validUntil,
        };
        yield* sql`INSERT INTO champion_learning_receipts (id,champion_id,topic,at,document_json) VALUES (${receiptId},${input.id},${input.topic},${at},${json(receipt)})`;
        return {
          revisions,
          nextCursor,
          receiptId,
          retrievedAt: at,
          admissibleForInvestigation: admissible,
        };
      }),
    );
  });
  const recordLearning = Effect.fn("ChampionEvidence.recordLearning")(function* (
    input: ChampionLearningRecordInput,
    contribution?: ChampionLearningContributor,
  ) {
    if (new TextEncoder().encode(json(input)).length > 24_000)
      return yield* invalidBecause("The learning is over 24 000 bytes; shorten it.");
    if (
      input.reviewAt === null &&
      input.reviewConditions.length === 0 &&
      input.versionConditions.length === 0
    )
      return yield* invalidBecause(
        "Give a review condition: reviewAt, reviewConditions or versionConditions.",
      );
    if (input.plainSummary === undefined)
      return yield* invalidBecause(
        "Give plainSummary: one sentence someone outside engineering understands, saying what was learned.",
      );
    const recordedAt = yield* now;
    if (
      input.components.some((component) => component.observedAt > recordedAt) ||
      input.versionConditions.some(
        (condition) =>
          !input.components.some(
            (component) =>
              component.component === condition.component &&
              component.version === condition.version,
          ),
      )
    )
      return yield* invalidBecause(
        "Each version condition needs a matching observed component, observed no later than now.",
      );
    return yield* atomic(
      Effect.gen(function* () {
        const doc = yield* read(input.id);
        const [head] = yield* sql<{
          revision_id: string;
        }>`SELECT revision_id FROM champion_learning_heads WHERE champion_id = ${input.id} AND learning_id = ${input.learningId}`;
        if ((head?.revision_id ?? null) !== input.expectedCurrentId) {
          const [saved] = yield* sql<{
            document_json: string;
          }>`SELECT document_json FROM champion_learning_revisions WHERE champion_id = ${input.id} AND learning_id = ${input.learningId} AND json_extract(document_json, '$.supersedes') IS ${input.expectedCurrentId} ORDER BY rowid DESC LIMIT 1`;
          if (saved !== undefined) {
            const prior = yield* decodeLearning(saved.document_json).pipe(Effect.mapError(failure));
            if (
              prior.learningId === input.learningId &&
              prior.reason === input.reason &&
              sameLearningContent(prior, input)
            ) {
              const isCurrent = head?.revision_id === prior.id;
              return {
                ...prior,
                isCurrent,
                applicabilityState:
                  !isCurrent || uncertain(prior, recordedAt, [])
                    ? ("uncertain" as const)
                    : ("current" as const),
              };
            }
          }
          return yield* conflict();
        }
        const revision: ChampionLearningRevision = {
          ...input,
          id: yield* uuid,
          championId: input.id,
          projectId: doc.champion.projectId,
          recordedAt: yield* now,
          supersedes: input.expectedCurrentId,
          applicabilityState: "current",
          isCurrent: true,
          ...(contribution === undefined ? {} : { contribution }),
        };
        yield* sql`INSERT INTO champion_learning_revisions (id,champion_id,learning_id,topic,at,review_at,document_json) VALUES (${revision.id},${input.id},${input.learningId},${input.topic},${revision.recordedAt},${input.reviewAt},${json(revision)})`;
        yield* sql`INSERT INTO champion_learning_heads (champion_id,learning_id,revision_id) VALUES (${input.id},${input.learningId},${revision.id}) ON CONFLICT(champion_id,learning_id) DO UPDATE SET revision_id = excluded.revision_id`;
        const event: ChampionActivity = {
          id: `${revision.recordedAt}:learning:${revision.id}`,
          championId: input.id,
          at: revision.recordedAt,
          kind: "learning-recorded",
          text: revision.plainSummary ?? revision.conclusion,
          learningRef: {
            learningId: revision.learningId,
            revisionId: revision.id,
            topic: revision.topic,
          },
          findingId: null,
          threadId: contribution === undefined ? doc.champion.ownerThreadId : null,
          revision: null,
          specUrl: null,
        };
        yield* sql`INSERT INTO champion_activity (id,champion_id,document_json) VALUES (${event.id},${input.id},${json(event)})`;
        return revision;
      }),
    );
  });
  /** Only a read-only task of the owner's own project, launched in the owner's active run, is evidence. */
  const verifyReadOnlyProof = Effect.fn("ChampionEvidence.verifyReadOnlyProof")(function* (
    proof: Admission,
    doc: ChampionDetail,
  ) {
    if (
      proof.projectId !== doc.champion.projectId ||
      (proof.binding.projectId !== undefined && proof.binding.projectId !== proof.projectId) ||
      proof.workspacePath !== proof.binding.workspacePath ||
      proof.binding.sourceAccess !== "read-only" ||
      proof.binding.executionBoundary !== "read-only" ||
      proof.binding.readOnly !== true ||
      proof.binding.externalOwner !== undefined
    )
      return yield* refused();
    const owner = yield* threads.getThreadShell(proof.ownerThreadId).pipe(Effect.mapError(failure));
    if (
      !owner ||
      owner.projectId !== proof.projectId ||
      owner.activeRunId !== proof.parentRunId ||
      owner.deletedAt !== null
    )
      return yield* refused();
  });
  const recordedBinding = Effect.fn("ChampionEvidence.recordedBinding")(function* (
    ownerThreadId: ThreadId,
    clientRequestId: string | undefined,
  ) {
    if (clientRequestId === undefined) return undefined;
    const [measured] = yield* sql<{
      document_json: string;
    }>`SELECT m.document_json FROM champion_measurements m JOIN champions c ON c.id = m.champion_id WHERE m.request_id = ${clientRequestId} AND json_extract(c.document_json, '$.champion.ownerThreadId') = ${ownerThreadId}`;
    return measured === undefined
      ? undefined
      : (yield* decodeMeasurement(measured.document_json)).admission?.binding;
  }, Effect.mapError(failure));
  const outcome = Effect.fn("ChampionEvidence.outcome")(function* (
    ownerThreadId: ThreadId,
    request: AgentTaskRequest | undefined,
    clientRequestId: string | undefined,
    state: "started" | "finished" | "failed",
  ) {
    const measured = yield* measurementForRequest(ownerThreadId, request);
    if (measured !== undefined) {
      if (clientRequestId === undefined) return true;
      yield* atomic(
        Effect.gen(function* () {
          const current = yield* readMeasurement(measured.measurementId);
          if (current.admission?.clientRequestId === clientRequestId && !terminal(current.state))
            yield* saveMeasurement({
              ...current,
              state: state === "finished" ? "accepted" : "unknown",
            });
        }),
      );
      return true;
    }
    return false;
  });
  const runtimeState = Effect.fn("ChampionEvidence.runtimeState")(function* ({
    id,
  }: {
    id: string;
  }): Effect.fn.Return<ChampionRuntimeState, ChampionError> {
    yield* read(id);
    const attempts = yield* sql<{
      document_json: string;
    }>`SELECT document_json FROM champion_execution_attempts WHERE champion_id = ${id} ORDER BY at DESC, id DESC LIMIT 50`.pipe(
      Effect.mapError(failure),
    );
    const measurements = yield* sql<{
      document_json: string;
    }>`SELECT document_json FROM champion_measurements WHERE champion_id = ${id} ORDER BY at DESC, id DESC LIMIT 20`.pipe(
      Effect.mapError(failure),
    );
    return {
      attempts: yield* Effect.forEach(attempts, (r) =>
        decodeExecution(r.document_json).pipe(Effect.mapError(failure)),
      ),
      measurements: yield* Effect.forEach(measurements, (r) =>
        decodeMeasurement(r.document_json).pipe(Effect.mapError(failure)),
      ),
    };
  });
  interface Observable {
    readonly taskId: NodeId;
    readonly childThreadId: ThreadId;
    readonly messageId: MessageId;
    readonly commandId: CommandId;
    readonly workId: string;
    readonly attemptId: string;
    readonly role: string;
    readonly workspacePath: string;
    readonly state: string;
    readonly actualSelection: ModelSelection | null;
    readonly result: string | null;
  }
  /** What the owner's task record and the child's runs say now about one admitted read-only attempt. */
  const observe = Effect.fn("ChampionEvidence.observe")(function* <A extends Observable>(
    doc: ChampionDetail,
    attempt: A,
  ) {
    const records = yield* threads
      .getThreadRecords(doc.champion.ownerThreadId, ["subagents"], {
        subagentIds: [attempt.taskId],
      })
      .pipe(Effect.mapError(failure));
    const task = records.subagents.find(
      (task) =>
        task.id === attempt.taskId &&
        task.origin === "app_owned" &&
        task.childThreadId === attempt.childThreadId,
    );
    const shell = yield* threads
      .getThreadShell(attempt.childThreadId)
      .pipe(Effect.mapError(failure));
    const valid =
      task !== undefined &&
      shell !== null &&
      shell.projectId === doc.champion.projectId &&
      shell.agentTask?.workId === attempt.workId &&
      shell.agentTask.attemptId === attempt.attemptId &&
      shell.agentTask.role === attempt.role &&
      shell.agentTask.workspacePath === attempt.workspacePath &&
      shell.agentTask.sourceAccess === "read-only" &&
      shell.agentTask.executionBoundary === "read-only";
    let next: A = attempt;
    if (valid && task && shell) {
      const child = yield* threads
        .getThreadRecords(attempt.childThreadId, ["runs"])
        .pipe(Effect.mapError(failure));
      const run = child.runs.find((run) => run.userMessageId === attempt.messageId);
      const live =
        shell.activeRunId !== null ||
        child.runs.some(
          (run) =>
            (run.userMessageId === attempt.messageId || run.delegatedTaskId === attempt.taskId) &&
            !Threads.isTerminalRunStatus(run.status),
        );
      const status =
        !live && ["completed", "failed", "cancelled", "interrupted"].includes(task.status)
          ? task.status === "completed"
            ? "completed"
            : task.status === "cancelled"
              ? "cancelled"
              : "failed"
          : "accepted";
      next = {
        ...attempt,
        state: terminal(attempt.state) ? attempt.state : status,
        actualSelection:
          run !== undefined &&
          (["running", "waiting", "completed"].includes(run.status) || run.startedAt != null)
            ? run.modelSelection
            : attempt.actualSelection,
        result: task.result?.slice(0, 8000) ?? attempt.result,
      } as A;
    } else if (!terminal(attempt.state)) {
      const receipt = yield* threads.getReceipt(attempt.commandId).pipe(Effect.option);
      next = {
        ...attempt,
        state:
          Option.isSome(receipt) &&
          Option.isSome(receipt.value) &&
          receipt.value.value.status === "rejected"
            ? "failed"
            : "unknown",
      } as A;
    }
    return { next, valid };
  });
  const observableOf = (measurement: ChampionMeasurement) => {
    const admission = measurement.admission;
    return admission === null
      ? undefined
      : {
          taskId: admission.taskId,
          childThreadId: admission.childThreadId,
          messageId: admission.messageId,
          commandId: admission.commandId,
          workId: measurement.workId,
          attemptId: measurement.attemptId,
          role: measurement.role,
          workspacePath: admission.workspacePath,
          state: measurement.state,
          actualSelection: admission.actualSelection,
          result: admission.result,
        };
  };
  /** Settles one admitted measurement from its task, as reconcile does, and returns it. */
  const refreshMeasurement = Effect.fn("ChampionEvidence.refreshMeasurement")(function* (
    id: string,
  ) {
    const measurement = yield* readMeasurement(id);
    const observable = observableOf(measurement);
    if (observable === undefined || terminal(measurement.state) || measurement.admission === null)
      return measurement;
    const { next } = yield* observe(yield* read(measurement.id), observable);
    const settled: ChampionMeasurement = {
      ...measurement,
      state: next.state as ChampionMeasurement["state"],
      admission: {
        ...measurement.admission,
        actualSelection: next.actualSelection,
        result: next.result,
      },
    };
    if (json(settled) === json(measurement)) return measurement;
    yield* atomic(saveMeasurement(settled));
    return settled;
  });
  const sameSelection = (measurement: ChampionMeasurement) =>
    measurement.admission === null
      ? []
      : [measurement.admission.resolvedSelection, measurement.admission.actualSelection]
          .filter((selection) => selection !== null)
          .map((selection) => modelIdentity(selection.model));
  /** A reviewer confirms a completed browser audit of the same check and the same full source. */
  const confirmedBrowser = Effect.fn("ChampionEvidence.confirmedBrowser")(function* (
    championId: string,
    checkId: string,
    sourceRevision: string,
    browserMeasurementId: string | undefined,
  ) {
    if (browserMeasurementId === undefined)
      return yield* invalidBecause(
        "A reviewer measurement names the completed browser audit it confirms.",
      );
    const browser = yield* readMeasurement(browserMeasurementId).pipe(
      Effect.mapError(() => invalidBecause("That browser measurement does not exist.")),
    );
    if (
      browser.id !== championId ||
      browser.checkId !== checkId ||
      browser.role !== "browser" ||
      browser.sourceRevision !== sourceRevision
    )
      return yield* refused(
        "A reviewer confirms a browser measurement of the same check pinned to exactly the same full source revision.",
      );
    if (browser.state !== "completed")
      return yield* conflictBecause("The browser measurement has not completed yet.");
    return browser;
  });
  const startMeasurement = Effect.fn("ChampionEvidence.startMeasurement")(function* (input: {
    readonly ownerThreadId: ThreadId;
    readonly runMessageIds: ReadonlyArray<string>;
    readonly measurement: ChampionMeasurementStartInput;
  }) {
    const request = input.measurement;
    if (request.role === "reviewer" && request.browserMeasurementId !== undefined)
      yield* refreshMeasurement(request.browserMeasurementId).pipe(Effect.ignore);
    return yield* atomic(
      Effect.gen(function* () {
        const doc = yield* read(request.id);
        if (doc.champion.ownerThreadId !== input.ownerThreadId) return yield* refused();
        const comparable = (value: ChampionMeasurementStartInput) =>
          json({
            id: value.id,
            checkId: value.checkId,
            role: value.role,
            sourceRevision: value.sourceRevision,
            metrics: value.metrics,
            browserMeasurementId: value.browserMeasurementId ?? null,
            observedRuntime: value.observedRuntime ?? null,
          });
        const [existing] = yield* sql<{
          document_json: string;
        }>`SELECT document_json FROM champion_measurements WHERE id = ${request.measurementId}`;
        if (existing) {
          const prior = yield* decodeMeasurement(existing.document_json).pipe(
            Effect.mapError(failure),
          );
          if (comparable(prior) !== comparable(request))
            return yield* conflictBecause(
              "That measurementId already names a different measurement. Use a new measurementId.",
            );
          return prior;
        }
        if (doc.champion.lifecycle !== "active")
          return yield* refused(
            "This champion is paused, so it measures only inline. Report what you measured and raise attention for anything else.",
          );
        if (doc.champion.journeys !== undefined)
          return yield* refused("A journey champion's only delegation is a replay.");
        const check = yield* liveCheck(
          doc,
          request.checkId,
          input.ownerThreadId,
          input.runMessageIds,
        );
        const seen = new Set<string>();
        for (const ref of request.metrics) {
          const frozen = check.metrics.find(
            (metric) => metric.id === ref.metricId && metric.version === ref.version,
          );
          if (frozen === undefined || seen.has(ref.metricId))
            return yield* invalidBecause(
              `Metric ${ref.metricId} version ${ref.version} is not a distinct frozen metric of this check.`,
            );
          if (frozen.collect !== undefined)
            return yield* invalidBecause(
              `Metric ${ref.metricId} is read by the server by command, so a measurement cannot gather it.`,
            );
          seen.add(ref.metricId);
        }
        if (request.role === "browser" && request.browserMeasurementId !== undefined)
          return yield* invalidBecause("Only a reviewer measurement names a browser measurement.");
        if (request.role === "reviewer")
          yield* confirmedBrowser(
            request.id,
            request.checkId,
            request.sourceRevision,
            request.browserMeasurementId,
          );
        const [planned] = yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM champion_measurements WHERE check_id = ${request.checkId}`;
        if ((planned?.count ?? 0) >= MAX_ADMITTED_ATTEMPTS_PER_DAY)
          return yield* conflictBecause(
            "This check already holds the most measurements a champion may be admitted in a day.",
          );
        const created: ChampionMeasurement = {
          ...request,
          workId: `${MEASUREMENT_WORK_PREFIX}${request.measurementId}`,
          attemptId: `${request.measurementId}:1`,
          createdAt: yield* now,
          state: "planned",
          admission: null,
        };
        yield* sql`INSERT INTO champion_measurements (id,champion_id,check_id,role,request_id,at,admitted_at,state,document_json) VALUES (${request.measurementId},${request.id},${request.checkId},${request.role},NULL,${created.createdAt},NULL,'planned',${json(created)})`;
        return created;
      }),
    );
  });
  /** The pre-launch decision; the launch itself is admitted again, atomically, by admitMeasurement. */
  const guardMeasurement = Effect.fn("ChampionEvidence.guardMeasurement")(function* (input: {
    readonly ownerThreadId: ThreadId;
    readonly request: AgentTaskRequest;
    readonly clientRequestId: string | undefined;
    readonly followup: boolean;
    readonly remote: boolean | undefined;
    readonly runMessageIds: ReadonlyArray<string>;
  }) {
    const { request } = input;
    const found = yield* measurementForRequest(input.ownerThreadId, request);
    if (found === undefined)
      return yield* refused(
        "That agentTask names no measurement of this champion. Start one with t3_champions_measurement and copy its workId and attemptId.",
      );
    if (input.remote) return yield* refused();
    if (input.followup)
      return yield* refused("A measurement takes no follow-up. Start a new measurement.");
    if (input.clientRequestId === undefined)
      return yield* refused("A measurement delegation needs a clientRequestId.");
    const measurement = yield* readMeasurement(found.measurementId);
    if (request.role !== measurement.role || request.attemptId !== measurement.attemptId)
      return yield* conflictBecause(
        `That measurement is a ${measurement.role} task with attemptId ${measurement.attemptId}.`,
      );
    if (measurement.admission !== null) {
      if (measurement.admission.clientRequestId !== input.clientRequestId)
        return yield* conflictBecause(
          `That measurement was already admitted as clientRequestId ${measurement.admission.clientRequestId}. Repeat that request, or start a new measurement.`,
        );
      return { measurement, replay: true as const, avoid: [] as ReadonlyArray<string> };
    }
    const doc = yield* read(measurement.id);
    if (
      doc.champion.lifecycle !== "active" ||
      doc.champion.journeys !== undefined ||
      request.readOnly !== true ||
      request.sourceRevision !== measurement.sourceRevision ||
      (request.projectId !== undefined && request.projectId !== doc.champion.projectId)
    )
      return yield* refused(
        "A measurement is read-only, pinned to the source revision it was started with, and runs only for an active champion in its own project.",
      );
    yield* liveCheck(doc, measurement.checkId, input.ownerThreadId, input.runMessageIds);
    if (measurement.role === "browser")
      return { measurement, replay: false as const, avoid: [] as ReadonlyArray<string> };
    yield* refreshMeasurement(measurement.browserMeasurementId ?? "").pipe(Effect.ignore);
    const browser = yield* confirmedBrowser(
      measurement.id,
      measurement.checkId,
      measurement.sourceRevision,
      measurement.browserMeasurementId,
    );
    return { measurement, replay: false as const, avoid: sameSelection(browser) };
  });
  const admitMeasurement = Effect.fn("ChampionEvidence.admitMeasurement")(function* (
    proof: Admission & { readonly runMessageIds: ReadonlyArray<string> },
  ) {
    const found = yield* measurementForRequest(proof.ownerThreadId, proof.binding);
    if (found === undefined) return yield* refused();
    const doc = yield* read(found.id);
    yield* verifyReadOnlyProof(proof, doc);
    if (proof.followup) return yield* refused("A measurement takes no follow-up.");
    if (found.browserMeasurementId !== undefined)
      yield* refreshMeasurement(found.browserMeasurementId).pipe(Effect.ignore);
    return yield* atomic(
      Effect.gen(function* () {
        const measurement = yield* readMeasurement(found.measurementId);
        const prior = measurement.admission;
        if (prior !== null) {
          if (
            prior.clientRequestId !== proof.clientRequestId ||
            prior.commandId !== proof.commandId ||
            prior.taskId !== proof.taskId ||
            prior.childThreadId !== proof.childThreadId ||
            prior.messageId !== proof.messageId
          )
            return yield* conflictBecause(
              "That measurement was already admitted by another request.",
            );
          return;
        }
        const fresh = yield* read(measurement.id);
        if (fresh.champion.lifecycle !== "active" || fresh.champion.journeys !== undefined)
          return yield* refused();
        yield* liveCheck(fresh, measurement.checkId, proof.ownerThreadId, proof.runMessageIds);
        if (
          proof.binding.role !== measurement.role ||
          proof.binding.workId !== measurement.workId ||
          proof.binding.attemptId !== measurement.attemptId ||
          proof.binding.sourceRevision !== measurement.sourceRevision
        )
          return yield* refused(
            "The task does not match the measurement it names: role, workId, attemptId and full source revision must all be the ones it was started with.",
          );
        if (measurement.role === "reviewer") {
          const browser = yield* confirmedBrowser(
            measurement.id,
            measurement.checkId,
            measurement.sourceRevision,
            measurement.browserMeasurementId,
          );
          if (sameSelection(browser).includes(modelIdentity(proof.selection.model)))
            return yield* new ChampionError({
              reason: "unavailable",
              detail:
                "The reviewer's resolved model is the browser measurement's model, so it is not an independent confirmation.",
            });
        }
        if (yield* capacityFull(measurement.id))
          return yield* conflictBecause(
            "This champion already has its read-only attempts running or its daily admissions used.",
          );
        const at = yield* now;
        const admission: ChampionMeasurementAdmission = {
          clientRequestId: proof.clientRequestId,
          commandId: proof.commandId,
          taskId: proof.taskId,
          childThreadId: proof.childThreadId,
          messageId: proof.messageId,
          workspacePath: proof.workspacePath,
          policyHash: proof.binding.policyHash,
          policyRevision: proof.binding.policyRevision,
          binding: { ...proof.binding, effective: proof.selection },
          resolvedSelection: proof.selection,
          actualSelection: null,
          admittedAt: at,
          result: null,
        };
        const admitted: ChampionMeasurement = { ...measurement, state: "admitted", admission };
        yield* sql`UPDATE champion_measurements SET state = 'admitted', request_id = ${proof.clientRequestId}, admitted_at = ${at}, document_json = ${json(admitted)} WHERE id = ${measurement.measurementId} AND state = 'planned'`;
      }),
    );
  });
  const reconcile = Effect.fn("ChampionEvidence.reconcile")(function* (id: string) {
    let changed = false;
    const attentionItems: string[] = [];
    const measurements = yield* sql<{
      id: string;
    }>`SELECT id FROM champion_measurements WHERE champion_id = ${id} AND state IN ('admitted','unknown','accepted') ORDER BY at DESC LIMIT 100`.pipe(
      Effect.mapError(failure),
    );
    for (const row of measurements) {
      const before = yield* readMeasurement(row.id);
      const after = yield* refreshMeasurement(row.id);
      if (json(before) !== json(after)) changed = true;
      if (after.state === "unknown")
        attentionItems.push(
          "Measurement: ownership or launch is unconfirmed; capacity remains held.",
        );
    }
    return { changed, attention: [...new Set(attentionItems)] };
  });
  return {
    recordedBinding,
    recordLearning,
    learningQuery,
    startMeasurement,
    guardMeasurement,
    admitMeasurement,
    outcome,
    runtimeState,
    reconcile,
  };
});
