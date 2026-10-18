import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * A release approval asks the owner to approve one candidate commit of a repository. The agent
 * supplies the summary; T3 never inspects the repository itself. There is at most one open
 * approval per repository, and an approval covers exactly its candidate.
 */
export const ReleaseApprovalId = TrimmedNonEmptyString.pipe(Schema.brand("ReleaseApprovalId"));
export type ReleaseApprovalId = typeof ReleaseApprovalId.Type;

export const ReleaseCandidate = Schema.String.check(
  Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, {
    message: "candidate must be a full lowercase commit id",
  }),
);

/** SlipJay's verification states, copied from `slipjay promote`'s plan. */
export const ReleaseVerificationStatus = Schema.Literals([
  "passed",
  "failed",
  "running",
  "queued",
  "none",
]);
export type ReleaseVerificationStatus = typeof ReleaseVerificationStatus.Type;

export const ReleaseApprovalSummary = Schema.Struct({
  commits: NonNegativeInt,
  items: Schema.Array(
    Schema.Struct({
      ref: TrimmedNonEmptyString,
      title: Schema.String,
      partialBuild: Schema.Boolean,
    }),
  ),
  migrations: Schema.Array(
    Schema.Struct({
      name: TrimmedNonEmptyString,
      nonAdditive: Schema.Boolean,
    }),
  ),
  verification: Schema.Struct({
    status: ReleaseVerificationStatus,
    detail: Schema.optional(Schema.String),
  }),
  coveredByEarlierApproval: Schema.Boolean,
});
export type ReleaseApprovalSummary = typeof ReleaseApprovalSummary.Type;

export const ReleaseApprovalStatus = Schema.Literals([
  "pending",
  "approved",
  "declined",
  "superseded",
]);
export type ReleaseApprovalStatus = typeof ReleaseApprovalStatus.Type;

export const ReleaseApprovalDecision = Schema.Literals(["approved", "declined"]);
export type ReleaseApprovalDecision = typeof ReleaseApprovalDecision.Type;

export const ReleaseApprovalAnswer = Schema.Struct({
  decision: ReleaseApprovalDecision,
  candidate: ReleaseCandidate,
  note: Schema.NullOr(Schema.String),
  /** The answering client session's subject. */
  answeredBy: Schema.String,
  answeredAt: Schema.String,
});
export type ReleaseApprovalAnswer = typeof ReleaseApprovalAnswer.Type;

/** What an open card shows outside its thread, without the details markdown. */
export const ReleaseApprovalCardSummary = Schema.Struct({
  approvalId: ReleaseApprovalId,
  repository: TrimmedNonEmptyString,
  candidate: ReleaseCandidate,
  base: TrimmedNonEmptyString,
  summary: ReleaseApprovalSummary,
  requestedAt: Schema.String,
});
export type ReleaseApprovalCardSummary = typeof ReleaseApprovalCardSummary.Type;

export const ReleaseApprovalAnswerInput = Schema.Struct({
  approvalId: ReleaseApprovalId,
  /** The candidate the owner saw; an answer never applies to another one. */
  candidate: ReleaseCandidate,
  decision: ReleaseApprovalDecision,
  note: Schema.optional(Schema.String),
});
export type ReleaseApprovalAnswerInput = typeof ReleaseApprovalAnswerInput.Type;

const RELEASE_APPROVAL_FAILURE_MESSAGES = {
  not_found: "This release approval no longer exists.",
  candidate_mismatch: "This release approval is for a different candidate.",
  already_answered: "This release approval was already answered.",
  superseded: "A newer candidate replaced this release approval.",
  failed: "Could not record the answer.",
} as const;

export const ReleaseApprovalFailureReason = Schema.Literals(
  Object.keys(RELEASE_APPROVAL_FAILURE_MESSAGES) as Array<
    keyof typeof RELEASE_APPROVAL_FAILURE_MESSAGES
  >,
);
export type ReleaseApprovalFailureReason = typeof ReleaseApprovalFailureReason.Type;

export class ReleaseApprovalError extends Schema.TaggedError<ReleaseApprovalError>()(
  "ReleaseApprovalError",
  {
    reason: ReleaseApprovalFailureReason,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return RELEASE_APPROVAL_FAILURE_MESSAGES[this.reason];
  }
}
