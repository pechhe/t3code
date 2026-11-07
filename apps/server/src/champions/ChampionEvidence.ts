import {
  ChampionError,
  type ChampionActivity,
  ChampionLearningContent,
  ChampionDetail,
  ChampionExecutionAttempt,
  ChampionInvestigation,
  ChampionInvestigationBranchAttempt,
  ChampionLearningRevision,
  ChampionRecommendation,
  type ChampionInvestigationStartInput,
  type ChampionInvestigationCancelInput,
  type ChampionLearningRecordInput,
  type ChampionLearningContributor,
  type ChampionLearningQueryInput,
  type ChampionLearningQueryResult,
  type ChampionSynthesisInput,
  type ChampionRuntimeState,
  type ChampionRecommendationInput,
  AgentTaskBinding,
  type AgentTaskRequest,
  type ModelSelection,
  ThreadId,
  ProjectId,
  NodeId,
  RuntimeMode,
  ProviderInteractionMode,
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
import * as ManagedTaskControl from "../agents/ManagedTaskControl.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";

// Only the managed launch path supplies this after prepare and validate, under its lock.
interface Admission {
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
}
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const terminal = (state: string) => ["completed", "failed", "cancelled"].includes(state);
const isChampionError = Schema.is(ChampionError);
const failure = (cause: unknown) =>
  isChampionError(cause) ? cause : new ChampionError({ reason: "unavailable", cause });
const invalid = () => new ChampionError({ reason: "invalid" });
const invalidBecause = (detail: string) => new ChampionError({ reason: "invalid", detail });
const conflict = () => new ChampionError({ reason: "conflict" });
const refused = (detail?: string) =>
  new ChampionError({ reason: "unauthorized", ...(detail === undefined ? {} : { detail }) });
const decodeDoc = Schema.decodeUnknownEffect(Schema.fromJsonString(ChampionDetail));
const decodeInvestigation = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ChampionInvestigation),
);
const decodeAttempt = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ChampionInvestigationBranchAttempt),
);
const sameBinding = Schema.toEquivalence(AgentTaskBinding);
const sameLearningContent = Schema.toEquivalence(ChampionLearningContent);
const decodeLearning = Schema.decodeUnknownEffect(Schema.fromJsonString(ChampionLearningRevision));
const decodeRecommendation = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ChampionRecommendation),
);
const decodeExecution = Schema.decodeUnknownEffect(Schema.fromJsonString(ChampionExecutionAttempt));
const receiptSchema = Schema.Struct({
  signature: Schema.String,
  versions: Schema.Array(Schema.String),
  validUntil: Schema.String,
  admissible: Schema.optional(Schema.Boolean),
});
const decodeReceipt = Schema.decodeUnknownEffect(Schema.fromJsonString(receiptSchema));
const intentSchema = Schema.Struct({
  ownerThreadId: ThreadId,
  projectId: ProjectId,
  taskId: NodeId,
  childThreadId: ThreadId,
  requestId: Schema.String,
  requestNamespace: Schema.String,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  reason: Schema.optional(Schema.String),
});

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* Threads.ThreadManagementService;
  const control = yield* ManagedTaskControl.ManagedTaskControl;
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
  const readInvestigation = Effect.fn("ChampionEvidence.readInvestigation")(function* (id: string) {
    const [row] = yield* sql<{
      document_json: string;
    }>`SELECT document_json FROM champion_investigations WHERE id = ${id}`.pipe(
      Effect.mapError(failure),
    );
    if (!row) return yield* new ChampionError({ reason: "not-found" });
    const investigation = yield* decodeInvestigation(row.document_json).pipe(
      Effect.mapError(failure),
    );
    const attempts = yield* sql<{
      document_json: string;
    }>`SELECT document_json FROM champion_branch_attempts WHERE investigation_id = ${id} ORDER BY at, id LIMIT 6`.pipe(
      Effect.mapError(failure),
    );
    return {
      ...investigation,
      attempts: yield* Effect.forEach(attempts, (row) =>
        decodeAttempt(row.document_json).pipe(Effect.mapError(failure)),
      ),
    };
  });
  const saveInvestigation = Effect.fn("ChampionEvidence.saveInvestigation")(function* (
    value: ChampionInvestigation,
  ) {
    yield* sql`UPDATE champion_investigations SET status = ${value.status}, document_json = ${json({ ...value, attempts: [] })} WHERE id = ${value.investigationId}`;
  }, Effect.mapError(failure));
  const saveAttempt = Effect.fn("ChampionEvidence.saveAttempt")(function* (
    value: ChampionInvestigationBranchAttempt,
  ) {
    yield* sql`UPDATE champion_branch_attempts SET state = CASE WHEN state IN ('completed','failed','cancelled') THEN state ELSE ${value.state} END, document_json = json_set(${json(value)}, '$.state', CASE WHEN state IN ('completed','failed','cancelled') THEN state ELSE ${value.state} END) WHERE id = ${value.id}`;
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
  const startInvestigation = Effect.fn("ChampionEvidence.startInvestigation")(function* (
    input: ChampionInvestigationStartInput,
  ) {
    return yield* atomic(
      Effect.gen(function* () {
        const doc = yield* read(input.id);
        const existing = yield* sql<{
          document_json: string;
        }>`SELECT document_json FROM champion_investigations WHERE id = ${input.investigationId}`;
        if (existing[0]) {
          const prior = yield* readInvestigation(input.investigationId);
          if (
            prior.id !== input.id ||
            prior.findingId !== input.findingId ||
            prior.question !== input.question ||
            prior.topic !== input.topic ||
            prior.retrievalReceiptId !== input.retrievalReceiptId ||
            json(prior.alternatives) !== json(input.alternatives)
          )
            return yield* conflict();
          return prior;
        }
        const finding = doc.findings.find((f) => f.id === input.findingId);
        if (
          doc.champion.lifecycle !== "active" ||
          !finding ||
          ["dismissed", "verified"].includes(finding.status)
        )
          return yield* refused();
        if (
          new Set(input.alternatives.map((a) => a.id)).size !== input.alternatives.length ||
          new Set(input.alternatives.map((a) => a.hypothesis.trim().toLowerCase())).size !==
            input.alternatives.length
        )
          return yield* invalid();
        const open =
          yield* sql`SELECT id FROM champion_investigations WHERE champion_id = ${input.id} AND finding_id = ${input.findingId} AND status IN ('open','cancel_requested')`;
        if (open.length > 0) return yield* conflict();
        const [receiptRow] = yield* sql<{
          document_json: string;
        }>`SELECT document_json FROM champion_learning_receipts WHERE id = ${input.retrievalReceiptId} AND champion_id = ${input.id} AND topic = ${input.topic}`;
        if (!receiptRow) return yield* conflict();
        const receipt = yield* decodeReceipt(receiptRow.document_json).pipe(
          Effect.mapError(failure),
        );
        if (
          receipt.admissible !== true ||
          receipt.validUntil <= (yield* now) ||
          receipt.signature !== (yield* signature(input.id, input.topic))
        )
          return yield* conflict();
        const value: ChampionInvestigation = {
          ...input,
          findingAttemptId: finding.attemptId,
          consideredLearningIds: receipt.versions,
          createdAt: yield* now,
          status: "open",
          attention: null,
          attempts: [],
          branches: input.alternatives.map((alternative) => ({
            ...alternative,
            workId: `champion-investigation:${input.investigationId}:${alternative.id}`,
            attemptId: `${input.investigationId}:${alternative.id}:1`,
          })),
        };
        yield* sql`INSERT INTO champion_investigations (id,champion_id,finding_id,finding_attempt_id,status,at,document_json) VALUES (${input.investigationId},${input.id},${input.findingId},${finding.attemptId},'open',${value.createdAt},${json(value)})`;
        return value;
      }),
    );
  });
  const branchForRequest = Effect.fn("ChampionEvidence.branchForRequest")(function* (
    ownerThreadId: ThreadId,
    request: AgentTaskRequest | undefined,
  ) {
    if (!request) return undefined;
    const docs = yield* sql<{
      document_json: string;
    }>`SELECT i.document_json FROM champion_investigations i JOIN champions c ON c.id = i.champion_id WHERE json_extract(c.document_json, '$.champion.ownerThreadId') = ${ownerThreadId} AND EXISTS (SELECT 1 FROM json_each(i.document_json, '$.branches') b WHERE json_extract(b.value, '$.workId') = ${request.workId}) LIMIT 1`;
    if (!docs[0]) return undefined;
    const investigation = yield* decodeInvestigation(docs[0].document_json);
    const branch = investigation.branches.find((b) => b.workId === request.workId);
    return branch === undefined ? undefined : { investigation, branch };
  }, Effect.mapError(failure));
  const guard = Effect.fn("ChampionEvidence.guard")(function* (
    ownerThreadId: ThreadId,
    request: AgentTaskRequest | undefined,
    clientRequestId: string | undefined,
    remote: boolean | undefined,
  ) {
    const match = yield* branchForRequest(ownerThreadId, request);
    if (!match || !request) return false;
    if (remote) return yield* refused();
    if (clientRequestId !== undefined) {
      const [prior] = yield* sql<{
        document_json: string;
      }>`SELECT document_json FROM champion_branch_attempts WHERE investigation_id = ${match.investigation.investigationId} AND request_id = ${clientRequestId}`.pipe(
        Effect.mapError(failure),
      );
      if (prior) {
        const attempt = yield* decodeAttempt(prior.document_json).pipe(Effect.mapError(failure));
        if (
          attempt.role !== request.role ||
          attempt.workId !== request.workId ||
          attempt.attemptId !== request.attemptId
        )
          return yield* conflict();
        return true;
      }
    }
    const doc = yield* read(match.investigation.id);
    if (doc.champion.lifecycle !== "active")
      return yield* new ChampionError({
        reason: "unauthorized",
        detail: "This champion is paused, so its investigation cannot start branches.",
      });
    if (
      match.investigation.status !== "open" ||
      request.role !== match.branch.role ||
      request.attemptId !== match.branch.attemptId ||
      request.readOnly !== true ||
      (request.projectId !== undefined && request.projectId !== doc.champion.projectId)
    )
      return yield* refused();
    return true;
  });
  const admit = Effect.fn("ChampionEvidence.admit")(function* (proof: Admission) {
    const match = yield* branchForRequest(proof.ownerThreadId, proof.binding);
    if (!match) return;
    const doc = yield* read(match.investigation.id);
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
    const priorInvestigation = yield* readInvestigation(match.investigation.investigationId);
    const settled: ChampionInvestigationBranchAttempt[] = [];
    if (proof.followup)
      for (const prior of priorInvestigation.attempts.filter(
        (attempt) => attempt.branchId === match.branch.id && !terminal(attempt.state),
      )) {
        const parent = yield* threads
          .getThreadRecords(proof.ownerThreadId, ["subagents"], { subagentIds: [prior.taskId] })
          .pipe(Effect.mapError(failure));
        const task = parent.subagents.find(
          (task) =>
            task.id === prior.taskId &&
            task.origin === "app_owned" &&
            task.childThreadId === prior.childThreadId,
        );
        const child = yield* threads
          .getThreadRecords(prior.childThreadId, ["runs"])
          .pipe(Effect.mapError(failure));
        const shell = yield* threads
          .getThreadShell(prior.childThreadId)
          .pipe(Effect.mapError(failure));
        if (
          task &&
          ["completed", "failed", "cancelled", "interrupted"].includes(task.status) &&
          shell &&
          shell.activeRunId === null &&
          shell.projectId === proof.projectId &&
          shell.agentTask?.workId === prior.workId &&
          shell.agentTask.attemptId === prior.attemptId &&
          shell.agentTask.role === prior.role &&
          shell.agentTask.workspacePath === prior.workspacePath &&
          shell.agentTask.executionBoundary === "read-only" &&
          !child.runs.some((run) => !Threads.isTerminalRunStatus(run.status))
        ) {
          settled.push({
            ...prior,
            state:
              task.status === "completed"
                ? "completed"
                : task.status === "cancelled"
                  ? "cancelled"
                  : "failed",
            result: task.result?.slice(0, 8000) ?? prior.result,
          });
        }
      }
    return yield* atomic(
      Effect.gen(function* () {
        const [previous] = yield* sql<{
          document_json: string;
        }>`SELECT document_json FROM champion_branch_attempts WHERE champion_id = ${doc.champion.id} AND request_id = ${proof.clientRequestId}`;
        if (previous) {
          const attempt = yield* decodeAttempt(previous.document_json).pipe(
            Effect.mapError(failure),
          );
          if (
            attempt.commandId !== proof.commandId ||
            attempt.taskId !== proof.taskId ||
            attempt.childThreadId !== proof.childThreadId ||
            attempt.messageId !== proof.messageId ||
            attempt.workId !== proof.binding.workId ||
            attempt.attemptId !== proof.binding.attemptId ||
            attempt.followup !== proof.followup
          )
            return yield* conflict();
          return;
        }
        for (const prior of settled) yield* saveAttempt(prior);
        const current = yield* readInvestigation(match.investigation.investigationId);
        const freshDoc = yield* read(doc.champion.id);
        const finding = freshDoc.findings.find((f) => f.id === current.findingId);
        if (
          freshDoc.champion.lifecycle !== "active" ||
          current.status !== "open" ||
          finding?.attemptId !== current.findingAttemptId ||
          ["dismissed", "verified"].includes(finding.status) ||
          proof.binding.role !== match.branch.role ||
          proof.binding.attemptId !== match.branch.attemptId
        )
          return yield* refused();
        if (
          proof.followup &&
          !current.attempts.some(
            (a) =>
              a.branchId === match.branch.id &&
              a.childThreadId === proof.childThreadId &&
              terminal(a.state),
          )
        )
          return yield* conflict();
        if (current.attempts.some((a) => a.branchId === match.branch.id && !terminal(a.state)))
          return yield* conflict();
        const since = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { days: 1 }));
        const [counts] = yield* sql<{
          active: number;
          recent: number;
        }>`SELECT SUM(CASE WHEN state IN ('admitted','unknown','accepted') THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN at > ${since} THEN 1 ELSE 0 END) AS recent FROM champion_branch_attempts WHERE champion_id = ${doc.champion.id}`;
        if (
          current.attempts.length >= 6 ||
          (counts?.active ?? 0) >= 2 ||
          (counts?.recent ?? 0) >= 6
        )
          return yield* conflict();
        const attempt: ChampionInvestigationBranchAttempt = {
          id: yield* uuid,
          branchId: match.branch.id,
          clientRequestId: proof.clientRequestId,
          commandId: proof.commandId,
          taskId: proof.taskId,
          childThreadId: proof.childThreadId,
          messageId: proof.messageId,
          role: match.branch.role,
          workId: proof.binding.workId,
          attemptId: proof.binding.attemptId,
          workspacePath: proof.workspacePath,
          policyHash: proof.binding.policyHash,
          policyRevision: proof.binding.policyRevision,
          binding: { ...proof.binding, effective: proof.selection },
          resolvedSelection: proof.selection,
          actualSelection: null,
          admittedAt: yield* now,
          state: "admitted",
          followup: proof.followup,
          result: null,
        };
        yield* sql`INSERT INTO champion_branch_attempts (id,investigation_id,champion_id,branch_id,request_id,at,state,document_json) VALUES (${attempt.id},${current.investigationId},${doc.champion.id},${attempt.branchId},${proof.clientRequestId},${attempt.admittedAt},${attempt.state},${json(attempt)})`;
      }),
    );
  });
  const recordedBinding = Effect.fn("ChampionEvidence.recordedBinding")(function* (
    ownerThreadId: ThreadId,
    clientRequestId: string | undefined,
  ) {
    if (clientRequestId === undefined) return undefined;
    const [row] = yield* sql<{
      document_json: string;
    }>`SELECT a.document_json FROM champion_branch_attempts a JOIN champions c ON c.id = a.champion_id WHERE a.request_id = ${clientRequestId} AND json_extract(c.document_json, '$.champion.ownerThreadId') = ${ownerThreadId}`;
    if (!row) return undefined;
    return (yield* decodeAttempt(row.document_json)).binding;
  }, Effect.mapError(failure));
  const followupBinding = Effect.fn("ChampionEvidence.followupBinding")(function* (
    ownerThreadId: ThreadId,
    request: AgentTaskRequest,
    childThreadId: ThreadId,
  ) {
    const match = yield* branchForRequest(ownerThreadId, request);
    if (!match)
      return yield* refused(
        "That agentTask names no open investigation branch of this champion. Copy workId and attemptId from the branch.",
      );
    const investigation = yield* readInvestigation(match.investigation.investigationId);
    const attempt = investigation.attempts.find(
      (a) =>
        a.branchId === match.branch.id &&
        a.childThreadId === childThreadId &&
        a.workId === request.workId &&
        a.attemptId === request.attemptId &&
        a.role === request.role,
    );
    if (!attempt)
      return yield* refused(
        "That child thread is not a task this branch started with the same workId, attemptId and role. Follow up the branch's own task.",
      );
    const doc = yield* read(investigation.id);
    const shell = yield* threads.getThreadShell(childThreadId).pipe(Effect.mapError(failure));
    const parent = yield* threads
      .getThreadRecords(ownerThreadId, ["subagents"], {
        subagentIds: [attempt.taskId],
      })
      .pipe(Effect.mapError(failure));
    if (
      !shell ||
      shell.deletedAt !== null ||
      shell.projectId !== doc.champion.projectId ||
      shell.agentTask?.workId !== attempt.workId ||
      shell.agentTask.attemptId !== attempt.attemptId ||
      shell.agentTask.role !== attempt.role ||
      shell.agentTask.workspacePath !== attempt.workspacePath ||
      !sameBinding(shell.agentTask, attempt.binding) ||
      !parent.subagents.some(
        (t) =>
          t.id === attempt.taskId && t.origin === "app_owned" && t.childThreadId === childThreadId,
      )
    )
      return yield* refused(
        "That branch's child thread no longer matches its recorded binding (it was deleted, moved or rebound), so it cannot be followed up. Start a new branch attempt instead.",
      );
    return attempt.binding;
  });
  const outcome = Effect.fn("ChampionEvidence.outcome")(function* (
    ownerThreadId: ThreadId,
    request: AgentTaskRequest | undefined,
    clientRequestId: string | undefined,
    state: "started" | "finished" | "failed",
  ) {
    const match = yield* branchForRequest(ownerThreadId, request);
    if (!match) return false;
    if (!clientRequestId) return true;
    yield* atomic(
      Effect.gen(function* () {
        const [row] = yield* sql<{
          document_json: string;
        }>`SELECT document_json FROM champion_branch_attempts WHERE investigation_id = ${match.investigation.investigationId} AND request_id = ${clientRequestId}`;
        if (!row) return;
        const attempt = yield* decodeAttempt(row.document_json).pipe(Effect.mapError(failure));
        if (!terminal(attempt.state))
          yield* saveAttempt({ ...attempt, state: state === "finished" ? "accepted" : "unknown" });
      }),
    );
    return true;
  });
  const hasLive = Effect.fn("ChampionEvidence.hasLive")(function* (id: string, findingId: string) {
    const rows =
      yield* sql`SELECT a.id FROM champion_branch_attempts a JOIN champion_investigations i ON i.id = a.investigation_id WHERE i.champion_id = ${id} AND i.finding_id = ${findingId} AND a.state IN ('admitted','unknown','accepted') LIMIT 1`.pipe(
        Effect.mapError(failure),
      );
    return rows.length > 0;
  });
  const synthesis = Effect.fn("ChampionEvidence.synthesis")(function* (
    input: ChampionSynthesisInput,
  ) {
    return yield* atomic(
      Effect.gen(function* () {
        const investigation = yield* readInvestigation(input.investigationId);
        const doc = yield* read(input.id);
        const finding = doc.findings.find((f) => f.id === investigation.findingId);
        if (
          investigation.id !== input.id ||
          finding?.attemptId !== investigation.findingAttemptId ||
          ["dismissed", "verified"].includes(finding.status) ||
          investigation.status === "cancel_requested" ||
          investigation.status === "cancelled" ||
          investigation.attempts.length === 0 ||
          investigation.attempts.some((a) => !terminal(a.state))
        )
          return yield* conflict();
        const [saved] = yield* sql<{
          document_json: string;
        }>`SELECT document_json FROM champion_recommendations WHERE id = ${input.recommendationId}`;
        if (saved) {
          const priorValue = yield* decodeRecommendation(saved.document_json).pipe(
            Effect.mapError(failure),
          );
          if (
            Object.keys(input).some(
              (key) => Reflect.get(input, key) !== Reflect.get(priorValue, key),
            )
          )
            return yield* conflict();
          return priorValue;
        }
        const [prior] = yield* sql<{
          id: string;
        }>`SELECT id FROM champion_recommendations WHERE champion_id = ${input.id} AND json_extract(document_json, '$.findingId') = ${investigation.findingId} AND json_extract(document_json, '$.findingAttemptId') = ${investigation.findingAttemptId} ORDER BY rowid DESC LIMIT 1`;
        if ((prior?.id ?? null) !== input.expectedCurrentId) return yield* conflict();
        const recommendation: ChampionRecommendation = {
          ...input,
          findingId: investigation.findingId,
          findingAttemptId: investigation.findingAttemptId,
          recordedAt: yield* now,
        };
        if (new TextEncoder().encode(json(recommendation)).length > 24_000) return yield* invalid();
        yield* sql`INSERT INTO champion_recommendations (id,champion_id,investigation_id,at,document_json) VALUES (${input.recommendationId},${input.id},${input.investigationId},${recommendation.recordedAt},${json(recommendation)})`;
        yield* saveInvestigation({ ...investigation, status: "synthesized" });
        return recommendation;
      }),
    );
  });
  const getRecommendation = Effect.fn("ChampionEvidence.getRecommendation")(function* (id: string) {
    const [row] = yield* sql<{
      document_json: string;
    }>`SELECT document_json FROM champion_recommendations WHERE id = ${id}`.pipe(
      Effect.mapError(failure),
    );
    if (!row) return yield* conflict();
    const value = yield* decodeRecommendation(row.document_json).pipe(Effect.mapError(failure));
    const [latest] = yield* sql<{
      id: string;
    }>`SELECT id FROM champion_recommendations WHERE champion_id = ${value.id} AND json_extract(document_json, '$.findingId') = ${value.findingId} AND json_extract(document_json, '$.findingAttemptId') = ${value.findingAttemptId} ORDER BY rowid DESC LIMIT 1`.pipe(
      Effect.mapError(failure),
    );
    if (latest?.id !== id) return yield* conflict();
    return value;
  });
  const recommendation = Effect.fn("ChampionEvidence.recommendation")(function* (
    input: ChampionRecommendationInput,
  ) {
    yield* read(input.id);
    const [row] = yield* sql<{
      document_json: string;
    }>`SELECT document_json FROM champion_recommendations WHERE id = ${input.recommendationId} AND champion_id = ${input.id} AND json_extract(document_json, '$.findingId') = ${input.findingId} AND json_extract(document_json, '$.findingAttemptId') = ${input.findingAttemptId} LIMIT 1`.pipe(
      Effect.mapError(failure),
    );
    if (!row) return yield* new ChampionError({ reason: "not-found" });
    if (new TextEncoder().encode(row.document_json).length > 24_000) return yield* invalid();
    return yield* decodeRecommendation(row.document_json).pipe(Effect.mapError(failure));
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
    const investigations = yield* sql<{
      id: string;
    }>`SELECT id FROM champion_investigations WHERE champion_id = ${id} ORDER BY CASE WHEN status IN ('open','cancel_requested') THEN 0 ELSE 1 END, at DESC, id DESC LIMIT 20`.pipe(
      Effect.mapError(failure),
    );
    const recommendations = yield* sql<{
      document_json: string;
    }>`SELECT document_json FROM champion_recommendations WHERE champion_id = ${id} ORDER BY at DESC, id DESC LIMIT 20`.pipe(
      Effect.mapError(failure),
    );
    return {
      attempts: yield* Effect.forEach(attempts, (r) =>
        decodeExecution(r.document_json).pipe(Effect.mapError(failure)),
      ),
      investigations: yield* Effect.forEach(investigations, (r) => readInvestigation(r.id)),
      recommendations: yield* Effect.forEach(recommendations, (r) =>
        decodeRecommendation(r.document_json).pipe(Effect.mapError(failure)),
      ),
    };
  });
  const cancelInvestigation = Effect.fn("ChampionEvidence.cancelInvestigation")(function* (
    input: ChampionInvestigationCancelInput,
  ) {
    const doc = yield* read(input.id);
    const owner = yield* threads
      .getThreadShell(doc.champion.ownerThreadId)
      .pipe(Effect.mapError(failure));
    if (!owner || owner.deletedAt !== null || owner.projectId !== doc.champion.projectId)
      return yield* refused();
    return yield* atomic(
      Effect.gen(function* () {
        const value = yield* readInvestigation(input.investigationId);
        if (value.id !== input.id) return yield* refused();
        if (value.status === "cancelled") return value;
        for (const attempt of value.attempts.filter((a) => !terminal(a.state))) {
          const principal: ManagedTaskControl.CancellationIntent = {
            ownerThreadId: owner.id,
            projectId: owner.projectId,
            taskId: attempt.taskId,
            childThreadId: attempt.childThreadId,
            requestId: `${input.requestId}:${attempt.id}`,
            requestNamespace: "champion-investigation-cancel",
            runtimeMode: owner.runtimeMode,
            interactionMode: owner.interactionMode,
            reason: input.reason,
          };
          yield* sql`INSERT INTO champion_cancel_intents (id,investigation_id,attempt_id,document_json) VALUES (${principal.requestId},${value.investigationId},${attempt.id},${json(principal)}) ON CONFLICT(id) DO NOTHING`;
        }
        const next = { ...value, status: "cancel_requested" as const };
        yield* saveInvestigation(next);
        return next;
      }),
    );
  });
  const reconcile = Effect.fn("ChampionEvidence.reconcile")(function* (id: string) {
    let changed = false;
    const attentionItems: string[] = [];
    const doc = yield* read(id);
    const rows = yield* sql<{
      id: string;
    }>`SELECT id FROM champion_investigations WHERE champion_id = ${id} ORDER BY CASE WHEN status IN ('open','cancel_requested') THEN 0 ELSE 1 END, at DESC LIMIT 100`.pipe(
      Effect.mapError(failure),
    );
    for (const row of rows) {
      const investigation = yield* readInvestigation(row.id);
      let attention: string | null = null;
      for (const attempt of investigation.attempts) {
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
        let next = attempt;
        if (valid && task && shell) {
          const child = yield* threads
            .getThreadRecords(attempt.childThreadId, ["runs"])
            .pipe(Effect.mapError(failure));
          const run = child.runs.find((run) => run.userMessageId === attempt.messageId);
          const live =
            shell.activeRunId !== null ||
            child.runs.some(
              (run) =>
                (run.userMessageId === attempt.messageId ||
                  run.delegatedTaskId === attempt.taskId) &&
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
          };
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
          };
          if (next.state === "unknown")
            attention = "Branch ownership or launch is unconfirmed; capacity remains held.";
        }
        if (json(next) !== json(attempt)) {
          yield* atomic(saveAttempt(next));
          changed = true;
        }
        const intents = yield* sql<{
          id: string;
          document_json: string;
        }>`SELECT id,document_json FROM champion_cancel_intents WHERE attempt_id = ${attempt.id} AND done = 0 ORDER BY rowid DESC LIMIT 1`.pipe(
          Effect.mapError(failure),
        );
        const intent = intents[0];
        if (intent && terminal(next.state)) {
          yield* sql`UPDATE champion_cancel_intents SET done = 1 WHERE id = ${intent.id}`.pipe(
            Effect.mapError(failure),
          );
        } else if (intent) {
          const principal = yield* Schema.decodeEffect(Schema.fromJsonString(intentSchema))(
            intent.document_json,
          ).pipe(Effect.mapError(failure));
          if (!valid)
            attention =
              "Cancellation pending: exact child ownership is unconfirmed; capacity remains held.";
          else {
            const stopped = yield* control
              .cancel(principal, { status: "running", workState: "working", childRunId: null })
              .pipe(Effect.option);
            if (Option.isNone(stopped))
              attention =
                "Cancellation pending: current ownership or permission ceilings prevent stopping this child; capacity remains held.";
          }
        }
      }
      yield* atomic(
        Effect.gen(function* () {
          const current = yield* readInvestigation(row.id);
          const status =
            current.status === "cancel_requested" &&
            current.attempts.every((attempt) => terminal(attempt.state))
              ? ("cancelled" as const)
              : current.status;
          if (attention !== current.attention || status !== current.status) {
            yield* saveInvestigation({ ...current, attention, status });
            changed = true;
          }
          if (attention !== null && status !== "cancelled")
            attentionItems.push(`Investigation: ${attention}`);
        }),
      );
    }
    return { changed, attention: [...new Set(attentionItems)] };
  });
  return {
    startInvestigation,
    recordedBinding,
    followupBinding,
    recommendation,
    recordLearning,
    learningQuery,
    guard,
    admit,
    outcome,
    hasLive,
    synthesis,
    getRecommendation,
    runtimeState,
    cancelInvestigation,
    reconcile,
  };
});
