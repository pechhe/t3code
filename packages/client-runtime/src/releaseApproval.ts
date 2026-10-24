import type {
  OrchestrationV2TurnItem,
  ReleaseApprovalCardSummary,
  ReleaseApprovalSummary,
  ReleaseVerificationStatus,
} from "@t3tools/contracts";

export type ReleaseApprovalItem = Extract<
  OrchestrationV2TurnItem,
  { readonly type: "release_approval_request" }
>;

export const shortCommit = (commit: string) =>
  /^[0-9a-f]{12,}$/.test(commit) ? commit.slice(0, 12) : commit;

const VERIFICATION_LABELS: Record<ReleaseVerificationStatus, string> = {
  passed: "Verification passed",
  failed: "Verification failed",
  running: "Verification running",
  queued: "Verification queued",
  none: "Not verified",
};

const verificationLabel = (verification: ReleaseApprovalSummary["verification"]) =>
  verification.detail?.trim()
    ? `${VERIFICATION_LABELS[verification.status]}: ${verification.detail.trim()}`
    : VERIFICATION_LABELS[verification.status];

/** The facts an owner weighs, in the order the card lists them. */
export function releaseApprovalFacts(summary: ReleaseApprovalSummary): ReadonlyArray<{
  readonly label: string;
  readonly tone: "default" | "warning" | "danger";
}> {
  const nonAdditive = summary.migrations.filter((migration) => migration.nonAdditive);
  const partial = summary.items.filter((item) => item.partialBuild);
  return [
    {
      label: `${summary.commits} ${summary.commits === 1 ? "commit" : "commits"}`,
      tone: "default",
    },
    {
      label: verificationLabel(summary.verification),
      tone:
        summary.verification.status === "passed"
          ? "default"
          : summary.verification.status === "failed"
            ? "danger"
            : "warning",
    },
    ...(summary.migrations.length === 0
      ? []
      : [
          {
            label:
              nonAdditive.length === 0
                ? `${summary.migrations.length} additive ${summary.migrations.length === 1 ? "migration" : "migrations"}`
                : `${nonAdditive.length} non-additive ${nonAdditive.length === 1 ? "migration" : "migrations"}`,
            tone: nonAdditive.length === 0 ? ("default" as const) : ("danger" as const),
          },
        ]),
    ...(partial.length === 0
      ? []
      : [
          {
            label: `${partial.length} partly built`,
            tone: "warning" as const,
          },
        ]),
    ...(summary.coveredByEarlierApproval
      ? [{ label: "Covered by an earlier approval", tone: "default" as const }]
      : []),
  ];
}

export const releaseApprovalTitle = (
  card: Pick<ReleaseApprovalCardSummary, "repository" | "candidate">,
) => `Release ${card.repository} at ${shortCommit(card.candidate)}`;

/** What an answered, replaced or forked card says instead of offering Approve and Decline. */
export function releaseApprovalOutcome(
  item: Pick<ReleaseApprovalItem, "approvalStatus" | "answer" | "supersededBy">,
  visibility: "local" | "inherited" | "synthetic",
): string | null {
  switch (item.approvalStatus) {
    case "pending":
      return visibility === "local" ? null : "Waiting for an answer in the original thread";
    case "approved":
    case "declined": {
      const verb = item.approvalStatus === "approved" ? "Approved" : "Declined";
      return item.answer?.note ? `${verb}: ${item.answer.note}` : verb;
    }
    case "superseded":
      return item.supersededBy === undefined
        ? "Replaced by a newer candidate"
        : `Replaced by ${shortCommit(item.supersededBy)}`;
  }
}

const USER_FACING_FAILURE_TAGS = new Set(["ReleaseApprovalError", "EnvironmentAuthorizationError"]);

export function releaseApprovalFailureMessage(failure: unknown): string {
  if (
    typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    typeof failure._tag === "string" &&
    USER_FACING_FAILURE_TAGS.has(failure._tag) &&
    "message" in failure &&
    typeof failure.message === "string" &&
    failure.message.trim().length > 0
  ) {
    return failure.message;
  }
  return "Could not record the answer. Try again.";
}

export interface OpenReleaseApproval<Thread> {
  readonly key: string;
  readonly card: ReleaseApprovalCardSummary;
  /** Every thread waiting on this card, oldest ask first. */
  readonly threads: ReadonlyArray<Thread>;
}

/**
 * One entry per open card, however many threads asked for it. Archived threads keep no card:
 * the server no longer delivers to them.
 */
export function groupOpenReleaseApprovals<
  Thread extends {
    readonly environmentId: string;
    readonly archivedAt: string | null;
    readonly pendingReleaseApprovals?: ReadonlyArray<ReleaseApprovalCardSummary>;
  },
>(threads: ReadonlyArray<Thread>): ReadonlyArray<OpenReleaseApproval<Thread>> {
  const groups = new Map<
    string,
    { card: ReleaseApprovalCardSummary; asks: Array<{ thread: Thread; requestedAt: string }> }
  >();
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    for (const card of thread.pendingReleaseApprovals ?? []) {
      const key = `${thread.environmentId}\u0000${card.approvalId}`;
      const ask = { thread, requestedAt: card.requestedAt };
      const group = groups.get(key);
      if (group === undefined) groups.set(key, { card, asks: [ask] });
      else group.asks.push(ask);
    }
  }
  const open = [...groups.entries()].map(([key, group]) => ({
    key,
    card: group.card,
    threads: [...group.asks]
      .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt))
      .map((ask) => ask.thread),
  }));
  return open.sort((left, right) => left.card.requestedAt.localeCompare(right.card.requestedAt));
}
