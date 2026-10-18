/**
 * A release approval asks the owner to approve one candidate of a repository. This service owns
 * the approval itself, in `release_approvals`: at most one is open per repository, joined by
 * every thread that asks for the same candidate, and an approval stays on record for exactly its
 * candidate. Each requesting thread shows it through a `release_approval_request` turn item,
 * which this service rewrites whenever the approval changes, and receives the owner's answer as
 * a queued message. Agents cannot answer: there is no runtime request, only the owner's RPC.
 */
import {
  CommandId,
  MessageId,
  ReleaseApprovalAnswer,
  ReleaseApprovalError,
  ReleaseApprovalId,
  ReleaseApprovalSummary,
  TurnItemId,
  type NodeId,
  type OrchestratorMcpRequestReleaseApprovalInput,
  type OrchestratorMcpRequestReleaseApprovalResult,
  type ReleaseApprovalAnswerInput,
  type ReleaseApprovalStatus,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

export interface ReleaseApprovalRequester {
  readonly threadId: ThreadId;
  /** The run asking; its root node owns this thread's card for the life of the approval. */
  readonly runId: RunId;
  readonly nodeId: NodeId;
}

export class ReleaseApprovals extends Context.Service<
  ReleaseApprovals,
  {
    readonly request: (
      requester: ReleaseApprovalRequester,
      input: OrchestratorMcpRequestReleaseApprovalInput,
    ) => Effect.Effect<OrchestratorMcpRequestReleaseApprovalResult, ReleaseApprovalError>;
    readonly answer: (
      input: ReleaseApprovalAnswerInput & { readonly answeredBy: string },
    ) => Effect.Effect<void, ReleaseApprovalError>;
  }
>()("t3/releases/ReleaseApprovals") {}

interface ApprovalRow {
  readonly approvalId: string;
  readonly repository: string;
  readonly candidate: string;
  readonly base: string;
  readonly summaryJson: string;
  readonly details: string;
  readonly status: ReleaseApprovalStatus;
  readonly answerJson: string | null;
  readonly supersededBy: string | null;
  readonly requestedAt: string;
}

interface RequesterRow {
  readonly threadId: ThreadId;
  readonly turnItemId: string;
  readonly runId: RunId;
  readonly nodeId: NodeId;
}

const SummaryJson = Schema.fromJsonString(ReleaseApprovalSummary);
const AnswerJson = Schema.fromJsonString(ReleaseApprovalAnswer);
const encodeSummary = Schema.encodeSync(SummaryJson);
const decodeSummary = Schema.decodeSync(SummaryJson);
const encodeAnswer = Schema.encodeSync(AnswerJson);
const decodeAnswer = Schema.decodeSync(AnswerJson);

const isReleaseApprovalError = Schema.is(ReleaseApprovalError);
const failed = (cause: unknown) => new ReleaseApprovalError({ reason: "failed", cause });

export const answerMessageText = (input: {
  readonly approvalId: string;
  readonly repository: string;
  readonly answer: ReleaseApprovalAnswer;
}) =>
  [
    `Release approval answered: ${input.answer.decision}.`,
    `Repository: ${input.repository}`,
    `Candidate: ${input.answer.candidate}`,
    ...(input.answer.note === null ? [] : [`Note: ${input.answer.note}`]),
    `Answered by ${input.answer.answeredBy} at ${input.answer.answeredAt}. Request: ${input.approvalId}.`,
    input.answer.decision === "approved"
      ? `This approval covers exactly ${input.answer.candidate}; release only that commit.`
      : "Do not release this candidate. Ask again with request_release_approval only if the user tells you to.",
  ].join("\n");

const supersededMessageText = (input: {
  readonly repository: string;
  readonly candidate: string;
  readonly newer: string;
}) =>
  [
    `Your release approval request for ${input.repository} at ${input.candidate} was replaced: another request opened one for the newer candidate ${input.newer}, so this one will not be answered.`,
    "If the newer candidate includes your work, wait for that card's answer. If it doesn't, tell the user instead of asking again, because a new request would replace the newer card.",
  ].join("\n");

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const lock = yield* KeyedLock.make<string>();

  const findApprovals = (where: { readonly repository: string; readonly status: string }) =>
    sql<ApprovalRow>`
      SELECT
        approval_id AS "approvalId", repository, candidate, base, summary_json AS "summaryJson",
        details, status, answer_json AS "answerJson", superseded_by AS "supersededBy",
        requested_at AS "requestedAt"
      FROM release_approvals
      WHERE repository = ${where.repository} AND status = ${where.status}
      ORDER BY requested_at DESC
    `;

  const findApproval = (approvalId: string) =>
    sql<ApprovalRow>`
      SELECT
        approval_id AS "approvalId", repository, candidate, base, summary_json AS "summaryJson",
        details, status, answer_json AS "answerJson", superseded_by AS "supersededBy",
        requested_at AS "requestedAt"
      FROM release_approvals
      WHERE approval_id = ${approvalId}
    `.pipe(Effect.map((rows) => rows[0]));

  const requestersOf = (approvalId: string) =>
    sql<RequesterRow>`
      SELECT thread_id AS "threadId", turn_item_id AS "turnItemId", run_id AS "runId",
        node_id AS "nodeId"
      FROM release_approval_requesters
      WHERE approval_id = ${approvalId}
      ORDER BY requested_at
    `;

  /** Rewrites one thread's card to the approval's current state. */
  const recordCard = (approval: ApprovalRow, requester: RequesterRow, revision: string) =>
    threadManagement
      .dispatch({
        type: "release_approval.record",
        commandId: CommandId.make(
          `release-approval:${approval.approvalId}:${requester.threadId}:${revision}`,
        ),
        threadId: requester.threadId,
        runId: requester.runId,
        nodeId: requester.nodeId,
        turnItemId: TurnItemId.make(requester.turnItemId),
        approvalId: ReleaseApprovalId.make(approval.approvalId),
        repository: approval.repository,
        candidate: approval.candidate,
        base: approval.base,
        summary: decodeSummary(approval.summaryJson),
        details: approval.details,
        approvalStatus: approval.status,
        ...(approval.answerJson === null ? {} : { answer: decodeAnswer(approval.answerJson) }),
        ...(approval.supersededBy === null ? {} : { supersededBy: approval.supersededBy }),
      })
      .pipe(Effect.asVoid);

  const sendToRequester = (requester: RequesterRow, key: string, text: string, user: boolean) =>
    Effect.gen(function* () {
      const shell = yield* threadManagement.getThreadShell(requester.threadId);
      if (shell === null || shell.archivedAt !== null) return;
      yield* threadManagement.sendToThread({
        projectId: shell.projectId,
        commandId: CommandId.make(key),
        threadId: requester.threadId,
        messageId: MessageId.make(key),
        text,
        attachments: [],
        // Never interrupts a running tool; an idle thread starts a turn at once.
        mode: "queue",
        // The answer is the owner's own; a supersede notice is T3's.
        createdBy: user ? "user" : "agent",
        creationSource: "server",
      });
    });

  /**
   * Each step for each requester stands alone: a card that fails to update (a deleted thread,
   * say) must not keep that thread from its message, nor the others from theirs. The approval
   * row is already the record, so a later pass (see `settle`) can repeat the steps. Only the
   * calling thread's own failure fails the call, after every other step has run, so an agent
   * never waits on a card the owner cannot see.
   */
  const forEachRequester = <E>(
    approvalId: string,
    steps: (requester: RequesterRow) => ReadonlyArray<Effect.Effect<void, E>>,
    caller?: ThreadId,
  ) =>
    Effect.gen(function* () {
      let callerFailure: Cause.Cause<E> | undefined;
      for (const requester of yield* requestersOf(approvalId)) {
        for (const step of steps(requester)) {
          const exit = yield* Effect.exit(step);
          if (Exit.isSuccess(exit)) continue;
          if (requester.threadId === caller) callerFailure ??= exit.cause;
          else
            yield* Effect.logWarning("Could not update a release approval requester", {
              approvalId,
              threadId: requester.threadId,
              cause: exit.cause,
            });
        }
      }
      if (callerFailure !== undefined) return yield* Effect.failCause(callerFailure);
    });

  /**
   * Tells the threads waiting on a replaced card that it will not be answered. The threads
   * already on the newer card, such as the one that replaced it, need no notice.
   */
  const notifySuperseded = (superseded: ApprovalRow) =>
    Effect.gen(function* () {
      if (superseded.supersededBy === null) return;
      const newer = yield* sql<{ readonly threadId: ThreadId }>`
        SELECT requester.thread_id AS "threadId"
        FROM release_approval_requesters requester
        JOIN release_approvals approval ON approval.approval_id = requester.approval_id
        WHERE approval.repository = ${superseded.repository}
          AND approval.candidate = ${superseded.supersededBy}
      `;
      const onNewer = new Set(newer.map((row) => row.threadId));
      const text = supersededMessageText({
        repository: superseded.repository,
        candidate: superseded.candidate,
        newer: superseded.supersededBy,
      });
      yield* forEachRequester(superseded.approvalId, (row) =>
        onNewer.has(row.threadId)
          ? []
          : [
              sendToRequester(
                row,
                `release-approval-superseded:${superseded.approvalId}:${row.threadId}`,
                text,
                false,
              ),
            ],
      );
    });

  const request: ReleaseApprovals["Service"]["request"] = (requester, input) => {
    const addRequester = (approvalId: string, now: string) => sql`
      INSERT OR IGNORE INTO release_approval_requesters
        (approval_id, thread_id, turn_item_id, run_id, node_id, requested_at)
      VALUES (${approvalId}, ${requester.threadId}, ${cardItemId(approvalId, requester.threadId)},
        ${requester.runId}, ${requester.nodeId}, ${now})
    `;
    return lock
      .withLock(
        input.repository,
        Effect.gen(function* () {
          const approved = (yield* findApprovals({
            repository: input.repository,
            status: "approved",
          })).find((row) => row.candidate === input.candidate);
          if (approved !== undefined) {
            return {
              requestId: ReleaseApprovalId.make(approved.approvalId),
              status: "approved" as const,
              candidate: input.candidate,
              joined: false,
              supersededCandidate: null,
              answer: approved.answerJson === null ? null : decodeAnswer(approved.answerJson),
            };
          }

          const now = DateTime.formatIso(yield* DateTime.now);
          const revision = yield* crypto.randomUUIDv4();
          const open = (yield* findApprovals({
            repository: input.repository,
            status: "pending",
          }))[0];

          if (open !== undefined && open.candidate === input.candidate) {
            // The latest ask carries the freshest summary, such as verification that has
            // since passed; every requester's card shows it.
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`
                  UPDATE release_approvals
                  SET base = ${input.base}, summary_json = ${encodeSummary(input.summary)},
                    details = ${input.details}, updated_at = ${now}
                  WHERE approval_id = ${open.approvalId}
                `;
                yield* addRequester(open.approvalId, now);
              }),
            );
            const updated = yield* findApproval(open.approvalId);
            if (updated !== undefined) {
              yield* forEachRequester(
                open.approvalId,
                (row) => [recordCard(updated, row, revision)],
                requester.threadId,
              );
            }
            return {
              requestId: ReleaseApprovalId.make(open.approvalId),
              status: "pending" as const,
              candidate: input.candidate,
              joined: true,
              supersededCandidate: null,
              answer: null,
            };
          }

          const approvalId = `release-approval:${yield* crypto.randomUUIDv4()}`;
          // Replacing the open card and opening the new one commit together, so a repository
          // never ends up with a superseded card and nothing in its place.
          yield* sql.withTransaction(
            Effect.gen(function* () {
              if (open !== undefined) {
                yield* sql`
                  UPDATE release_approvals
                  SET status = 'superseded', superseded_by = ${input.candidate},
                    updated_at = ${now}
                  WHERE approval_id = ${open.approvalId}
                `;
              }
              yield* sql`
                INSERT INTO release_approvals (
                  approval_id, repository, candidate, base, summary_json, details, status,
                  answer_json, superseded_by, requested_at, updated_at
                ) VALUES (
                  ${approvalId}, ${input.repository}, ${input.candidate}, ${input.base},
                  ${encodeSummary(input.summary)}, ${input.details}, 'pending', NULL, NULL,
                  ${now}, ${now}
                )
              `;
              yield* addRequester(approvalId, now);
            }),
          );

          const superseded = open === undefined ? undefined : yield* findApproval(open.approvalId);
          if (superseded !== undefined) {
            yield* forEachRequester(superseded.approvalId, (row) => [
              recordCard(superseded, row, revision),
            ]);
            yield* notifySuperseded(superseded);
          }
          const created = yield* findApproval(approvalId);
          if (created !== undefined) {
            yield* forEachRequester(
              approvalId,
              (row) => [recordCard(created, row, revision)],
              requester.threadId,
            );
          }
          return {
            requestId: ReleaseApprovalId.make(approvalId),
            status: "pending" as const,
            candidate: input.candidate,
            joined: false,
            supersededCandidate: open?.candidate ?? null,
            answer: null,
          };
        }),
      )
      .pipe(
        Effect.mapError((cause) => (isReleaseApprovalError(cause) ? cause : failed(cause))),
        Effect.withSpan("ReleaseApprovals.request"),
      );
  };

  /**
   * Brings every requester of a settled approval up to date: its card, and its answer or
   * supersede notice. Cards are rewritten under a fresh revision, since a write that failed in
   * planning leaves a rejected receipt its command id can never pass again; messages keep their
   * one id, so a thread that already has one never gets it twice.
   */
  const settle = (approval: ApprovalRow) =>
    Effect.gen(function* () {
      const revision = yield* crypto.randomUUIDv4();
      yield* forEachRequester(approval.approvalId, (row) => [recordCard(approval, row, revision)]);
      if (approval.status === "superseded") return yield* notifySuperseded(approval);
      yield* sendAnswer(approval);
    });

  const sendAnswer = (approval: ApprovalRow) => {
    if (approval.answerJson === null) return Effect.void;
    const text = answerMessageText({
      approvalId: approval.approvalId,
      repository: approval.repository,
      answer: decodeAnswer(approval.answerJson),
    });
    return forEachRequester(approval.approvalId, (row) => [
      sendToRequester(
        row,
        `release-approval-answer:${approval.approvalId}:${row.threadId}`,
        text,
        true,
      ),
    ]);
  };

  const answer: ReleaseApprovals["Service"]["answer"] = (input) =>
    Effect.gen(function* () {
      const found = yield* findApproval(input.approvalId);
      if (found === undefined) return yield* new ReleaseApprovalError({ reason: "not_found" });
      yield* lock.withLock(
        found.repository,
        Effect.gen(function* () {
          const approval = yield* findApproval(input.approvalId);
          if (approval === undefined) {
            return yield* new ReleaseApprovalError({ reason: "not_found" });
          }
          if (approval.candidate !== input.candidate) {
            return yield* new ReleaseApprovalError({ reason: "candidate_mismatch" });
          }
          if (approval.status !== "pending") {
            // A card still offering Approve here missed its update, perhaps to a restart
            // mid-fan-out; answering it repeats the fan-out, and keyed steps already done no-op.
            yield* settle(approval);
            return yield* new ReleaseApprovalError({
              reason: approval.status === "superseded" ? "superseded" : "already_answered",
            });
          }
          const now = DateTime.formatIso(yield* DateTime.now);
          const note = input.note?.trim();
          const answered: ReleaseApprovalAnswer = {
            decision: input.decision,
            candidate: approval.candidate,
            note: note === undefined || note === "" ? null : note,
            answeredBy: input.answeredBy,
            answeredAt: now,
          };
          yield* sql`
            UPDATE release_approvals
            SET status = ${input.decision}, answer_json = ${encodeAnswer(answered)},
              updated_at = ${now}
            WHERE approval_id = ${approval.approvalId}
          `;
          yield* settle({
            ...approval,
            status: input.decision,
            answerJson: encodeAnswer(answered),
          });
        }),
      );
    }).pipe(
      Effect.mapError((cause) => (isReleaseApprovalError(cause) ? cause : failed(cause))),
      Effect.withSpan("ReleaseApprovals.answer"),
    );

  return ReleaseApprovals.of({ request, answer });
});

const cardItemId = (approvalId: string, threadId: ThreadId) =>
  `turn-item:${approvalId}:${encodeURIComponent(threadId)}`;

export const layer = Layer.effect(ReleaseApprovals, make);
