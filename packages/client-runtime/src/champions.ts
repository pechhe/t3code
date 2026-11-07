import {
  AGENT_ROLE_TITLE_LABEL,
  type ChampionLearningEntry,
  ChampionError,
  type ChampionFinding,
  type ChampionLatestSample,
  type ChampionMetric,
  type ChampionMetricInput,
  type ChampionSummary,
  type ChampionInvestigation,
  type ChampionLearningRevision,
  type ChampionRecommendation,
  type ChampionRuntimeState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { RpcClientError } from "effect/rpc";
import * as Schema from "effect/Schema";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DAYS_IN_WEEK = 7;

export function championCadenceMs(schedule: ChampionSummary["schedule"]): number {
  if (schedule.type === "interval") return schedule.everyMs;
  const days = [...new Set(schedule.weekdays ?? [])].sort((a, b) => a - b);
  const first = days[0];
  if (first === undefined) return DAY_MS;
  let longest = 0;
  days.forEach((day, index) => {
    longest = Math.max(longest, (days[index + 1] ?? first + DAYS_IN_WEEK) - day);
  });
  return longest * DAY_MS;
}

/** The server applies this window when a metric sets no `staleAfterMs` of its own. */
export function championStaleAfterMs(
  metric: Pick<ChampionMetricInput, "staleAfterMs">,
  schedule: ChampionSummary["schedule"],
): number {
  return metric.staleAfterMs ?? championCadenceMs(schedule) * 2;
}

export function formatChampionDuration(ms: number): string {
  if (ms >= 2 * DAY_MS) return `${Math.round(ms / DAY_MS)} days`;
  if (ms >= 2 * HOUR_MS) return `${Math.round(ms / HOUR_MS)} hours`;
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/** Expiry is a timestamp so a reading goes stale here between the server's own refreshes. */
function effectiveHealth(sample: ChampionLatestSample, nowMs: number) {
  if (sample.health !== "healthy" && sample.health !== "breached") return sample.health;
  if (sample.staleAt === null) return "unknown";
  return nowMs >= Date.parse(sample.staleAt) ? "stale" : sample.health;
}

export type ChampionStatus =
  | "review"
  | "attention"
  | "setting-up"
  | "checking"
  | "working"
  | "off-target"
  | "unknown"
  | "stale"
  | "unmeasured"
  | "healthy"
  | "paused"
  | "retired";

export const CHAMPION_STATUS_LABELS: Record<ChampionStatus, string> = {
  review: "Review metrics",
  attention: "Needs attention",
  "setting-up": "Setting up",
  checking: "Checking",
  working: "Working",
  "off-target": "Outside target",
  unknown: "Can't tell",
  stale: "Readings out of date",
  unmeasured: "Not measured yet",
  healthy: "Healthy",
  paused: "Paused",
  retired: "Retired",
};

const isSettingUp = (champion: ChampionSummary) =>
  (champion.outstandingSetupId ?? null) !== null && champion.lastCheckAt === null;

export function championNeedsAttention(champion: ChampionSummary): boolean {
  if (champion.lifecycle === "retired") return false;
  return champion.pendingProposal || (!isSettingUp(champion) && champion.attention.length > 0);
}

function evidenceStatus(champion: ChampionSummary, nowMs: number): ChampionStatus {
  const samples = champion.latestSamples ?? [];
  const required = samples.filter((sample) => sample.required);
  const counted = required.length > 0 ? required : samples;
  if (counted.length === 0) return champion.lastCheckAt === null ? "unmeasured" : "unknown";
  const healths = counted.map((sample) => effectiveHealth(sample, nowMs));
  if (healths.every((health) => health === "healthy")) return "healthy";
  if (healths.includes("breached")) return "off-target";
  if (champion.lastCheckAt === null) return "unmeasured";
  return healths.includes("stale") ? "stale" : "unknown";
}

export function championStatus(champion: ChampionSummary, nowMs: number): ChampionStatus {
  if (champion.lifecycle === "retired") return "retired";
  if (champion.pendingProposal) return "review";
  if (isSettingUp(champion)) return "setting-up";
  if (champion.attention.length > 0) return "attention";
  if (champion.lifecycle === "paused") return "paused";
  if (champion.outstandingCheckId !== null) return "checking";
  if (champion.openFindingCount > 0) return "working";
  return evidenceStatus(champion, nowMs);
}

export type ChampionReading =
  | {
      readonly kind: "measured";
      readonly value: number;
      readonly observedAt: string | null;
      readonly health: ChampionLatestSample["health"];
    }
  | {
      readonly kind: "unmeasured";
      readonly status: Exclude<ChampionLatestSample["status"], "measured">;
      readonly observedAt: string | null;
    }
  | { readonly kind: "not-yet" }
  /** The server sent no latest samples, so neither a value nor its absence can be claimed. */
  | { readonly kind: "unavailable" };

export function championReading(
  metric: Pick<ChampionMetric, "id" | "seriesId" | "unit">,
  samples: ReadonlyArray<ChampionLatestSample> | undefined,
  nowMs: number,
): ChampionReading {
  if (samples === undefined) return { kind: "unavailable" };
  const sample = samples.find((candidate) => candidate.metricId === metric.id);
  if (
    sample === undefined ||
    sample.seriesId !== metric.seriesId ||
    sample.unit !== metric.unit ||
    (sample.observedAt === null && sample.collectedAt === null)
  ) {
    return { kind: "not-yet" };
  }
  if (sample.status === "measured" && sample.value !== null) {
    return {
      kind: "measured",
      value: sample.value,
      observedAt: sample.observedAt,
      health: effectiveHealth(sample, nowMs),
    };
  }
  return {
    kind: "unmeasured",
    status: sample.status === "measured" ? "unknown" : sample.status,
    observedAt: sample.observedAt,
  };
}

export const CHAMPION_READING_STATUS_LABELS = {
  unknown: "Unknown",
  insufficient: "Not enough data",
  error: "Couldn't measure",
} as const;

const VALUE_FORMAT = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

export function formatChampionValue(value: number, unit: string): string {
  return unit === "%" ? `${VALUE_FORMAT.format(value)}%` : `${VALUE_FORMAT.format(value)} ${unit}`;
}

export function championReadingLabel(reading: ChampionReading, unit: string): string {
  switch (reading.kind) {
    case "measured":
      return formatChampionValue(reading.value, unit);
    case "unmeasured":
      return CHAMPION_READING_STATUS_LABELS[reading.status];
    case "not-yet":
      return "Not yet measured";
    case "unavailable":
      return "Reading unavailable";
  }
}

export const CHAMPION_FINDING_STATUS_LABELS: Record<ChampionFinding["status"], string> = {
  open: "Open",
  working: "Repair running",
  handed_back: "Ready to integrate",
  delivered: "Rechecking",
  verified: "Verified",
  inconclusive: "Can't tell",
  dismissed: "Dismissed",
};

export const championFindingIsClosed = (finding: ChampionFinding) =>
  finding.status === "verified" || finding.status === "dismissed";

export const canDismissChampionFinding = (finding: ChampionFinding) =>
  !championFindingIsClosed(finding);

export const canReopenChampionFinding = (finding: ChampionFinding) =>
  championFindingIsClosed(finding) || finding.status === "inconclusive";

const DECISION_ANSWER_LIMIT = 500;

/** The answer sent when the user approves a decision's proposal, kept within the answer limit. */
export function championApprovalAnswer(action: string): string {
  const answer = `Approved: ${action}`;
  return answer.length <= DECISION_ANSWER_LIMIT
    ? answer
    : `${answer.slice(0, DECISION_ANSWER_LIMIT - 1)}…`;
}

/** When an approval relayed through an agent was given, as "7 Nov, 16:00 GMT". */
export function championApprovalWhen(approvedAt: string, locale?: string): string {
  const at = DateTime.make(approvedAt);
  if (Option.isNone(at)) return "";
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(DateTime.toEpochMillis(at.value));
}

export function pendingChampionDecision(finding: ChampionFinding) {
  return finding.decision?.status === "requested" ? finding.decision : null;
}

const isRpcClientError = Schema.is(RpcClientError.RpcClientError);
const isChampionError = Schema.is(ChampionError);

/** Only a request the server has no handler for means it needs updating. */
export function championsUnsupportedByServer(cause: Cause.Cause<unknown>): boolean {
  return cause.reasons.some(
    (reason) =>
      reason._tag === "Die" ||
      (reason._tag === "Fail" &&
        isRpcClientError(reason.error) &&
        reason.error.reason._tag === "RpcClientDefect"),
  );
}

export type ChampionAction =
  | "investigation"
  | "learning"
  | "load"
  | "save"
  | "setup"
  | "cancel-setup"
  | "check"
  | "lifecycle"
  | "metrics"
  | "discard"
  | "finding"
  | "decision";

const CONFLICT_MESSAGES: Partial<Record<ChampionAction, string>> = {
  investigation:
    "The investigation or its available capacity changed. Refresh its evidence before trying again.",
  learning: "This learning has a newer revision. Read the current revision before replacing it.",
  finding: "A repair is still running on this. Wait for it to finish, then try again.",
  decision: "This decision has changed. Check its current state.",
  metrics: "There is no proposal to accept any more.",
  "cancel-setup": "Setup is still starting, so it can't be cancelled yet. Try again shortly.",
};

const INVALID_MESSAGES: Partial<Record<ChampionAction, string>> = {
  save: "The chosen project or model can't be used on this machine.",
  setup: "The chosen project or model can't be used on this machine.",
  lifecycle: "Accept metrics before starting this champion.",
  metrics: "The machine refused these metrics. Check their targets.",
  decision: "That answer can't be used. Keep it to 500 characters.",
};

/** The server's reason is a code rather than a sentence, and its meaning depends on the action; a detail the server wrote for this refusal wins. */
export function championFailureMessage(failure: unknown, action: ChampionAction): string {
  if (isChampionError(failure)) {
    if (failure.detail !== undefined && failure.detail.trim()) return failure.detail;
    switch (failure.reason) {
      case "unauthorized":
        return action === "load"
          ? "This device isn't allowed to see champions on this machine."
          : "This device isn't allowed to change champions on this machine.";
      case "not-found":
        return "This machine no longer has this champion or its project.";
      case "conflict":
        return (
          CONFLICT_MESSAGES[action] ??
          "It changed while you were acting on it. Check its state and try again."
        );
      case "invalid":
        return INVALID_MESSAGES[action] ?? "The machine refused this request.";
      case "unavailable":
        return action === "load"
          ? "This machine couldn't load champions. Try again."
          : "The chosen model or this machine isn't available right now. Nothing was switched; try again.";
    }
  }
  return failure instanceof Error && failure.message.trim()
    ? failure.message
    : "That didn't work. Try again.";
}

export function championLoadFailureMessage(cause: Cause.Cause<unknown>): string {
  if (championsUnsupportedByServer(cause)) {
    return "This machine's server needs updating to use Champions.";
  }
  return championFailureMessage(Cause.squash(cause), "load");
}

export type ChampionResearchTone = "running" | "done" | "warning" | "failed" | "idle";

interface ChampionResearchBranch {
  readonly id: string;
  readonly hypothesis: string;
  readonly tone: ChampionResearchTone;
  readonly status: string;
  readonly result: string | null;
}

export interface ChampionResearchView {
  readonly investigationId: string;
  /** The server hasn't confirmed every task has stopped, so nothing may be dismissed under it. */
  readonly live: boolean;
  readonly cancellable: boolean;
  readonly cancelRequested: boolean;
  readonly cannotConfirm: boolean;
  readonly summary: string | null;
  readonly attention: string | null;
  readonly branches: ReadonlyArray<ChampionResearchBranch>;
}

const counted = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

export function championResearchView(investigation: ChampionInvestigation): ChampionResearchView {
  const requested = investigation.status === "cancel_requested";
  const branches = investigation.branches.map((branch): ChampionResearchBranch => {
    const attempt = investigation.attempts
      .filter((candidate) => candidate.branchId === branch.id)
      .sort((a, b) => a.admittedAt.localeCompare(b.admittedAt))
      .at(-1);
    const view = (tone: ChampionResearchTone, status: string) => ({
      id: branch.id,
      hypothesis: branch.hypothesis,
      tone,
      status,
      result: attempt?.result ?? null,
    });
    switch (attempt?.state) {
      case undefined:
        return view("idle", investigation.status === "open" ? "Not started" : "Never started");
      case "admitted":
        return view("running", requested ? "Stop requested" : "Starting");
      case "accepted":
        return view("running", requested ? "Stop requested" : "Running");
      case "unknown":
        return view("warning", "Can't confirm");
      case "completed":
        return view("done", "Finished");
      case "failed":
        return view("failed", "Failed");
      case "cancelled":
        return view("idle", "Cancelled");
    }
  });
  const running = branches.filter((branch) => branch.tone === "running").length;
  const unknown = branches.filter((branch) => branch.tone === "warning").length;
  const unconfirmed =
    unknown > 0 ? ` · ${counted(unknown, "task", "tasks")} can't be confirmed` : "";
  const open = investigation.status === "open";
  const tasks = branches.length;
  const summary =
    investigation.status === "synthesized"
      ? null
      : investigation.status === "cancelled"
        ? `Research cancelled${unconfirmed}`
        : requested
          ? running + unknown > 0
            ? `Cancel requested · ${counted(running + unknown, "task", "tasks")} not yet stopped`
            : "Cancel requested"
          : running > 0
            ? `Researching ${counted(tasks, "option", "options")} · ${counted(running, "task", "tasks")} running${unconfirmed}`
            : unknown > 0
              ? `Researching ${counted(tasks, "option", "options")}${unconfirmed}`
              : branches.every((branch) => branch.tone === "idle")
                ? `Research planned · ${counted(tasks, "option", "options")}`
                : `Researched ${counted(tasks, "option", "options")} · No recommendation yet`;
  return {
    investigationId: investigation.investigationId,
    live: open || requested || running + unknown > 0,
    cancellable: open,
    cancelRequested: requested,
    cannotConfirm: unknown > 0,
    summary,
    attention: investigation.attention,
    branches,
  };
}

export interface ChampionFindingRuntime {
  readonly research: ChampionResearchView | null;
  /** What the open or last decision was asked about. Null when it wasn't asked from one. */
  readonly recommendation: ChampionRecommendation | null;
  /** The decision names a recommendation this client doesn't have, so it can't be read yet. */
  readonly recommendationMissing: boolean;
  readonly earlier: ReadonlyArray<ChampionRecommendation>;
}

export function championFindingRuntime(
  finding: ChampionFinding,
  state: ChampionRuntimeState | null,
  exact: ChampionRecommendation | null = null,
): ChampionFindingRuntime {
  const recommendationId = finding.decision?.recommendationId;
  const recommendation =
    recommendationId === undefined
      ? null
      : (state?.recommendations.find(
          (candidate) =>
            candidate.recommendationId === recommendationId &&
            candidate.findingId === finding.id &&
            candidate.findingAttemptId === finding.attemptId,
        ) ??
        (exact?.recommendationId === recommendationId &&
        exact.findingId === finding.id &&
        exact.findingAttemptId === finding.attemptId
          ? exact
          : null));
  // The server lists pending investigations first, then the newest.
  const investigation = state?.investigations.find(
    (candidate) => candidate.findingId === finding.id,
  );
  return {
    research: investigation ? championResearchView(investigation) : null,
    recommendation,
    recommendationMissing: recommendationId !== undefined && recommendation === null,
    earlier: (state?.recommendations ?? [])
      .filter(
        (candidate) =>
          candidate.findingId === finding.id &&
          candidate.recommendationId !== recommendationId &&
          (recommendation === null || candidate.recordedAt <= recommendation.recordedAt),
      )
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)),
  };
}

const NOTE_DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});

const dateOf = (value: string) => NOTE_DATE_FORMAT.format(Date.parse(value));

const OUTCOME_WORDS = { improved: "It helped", failed: "It failed", inconclusive: "Inconclusive" };

/** An exact historical revision as plain sentences. Its own text is never swapped for the head's. */
export function learningNoteProse(revision: ChampionLearningRevision): ReadonlyArray<string> {
  const standing = !revision.isCurrent
    ? ["A newer note has replaced this one. It's kept as what was known at the time."]
    : revision.applicabilityState === "uncertain"
      ? [
          "This is due another look, so it may no longer hold. That doesn't make it wrong, nothing was deleted, and nothing reruns by itself.",
        ]
      : [];
  const reconsider = [
    ...revision.reviewConditions.map((condition) => `We'll reconsider if ${condition}.`),
    ...revision.versionConditions.map(
      (condition) =>
        `We'll reconsider if ${condition.component} moves on from ${condition.version}.`,
    ),
    ...(revision.reviewAt === null
      ? []
      : [`We planned to look again by ${dateOf(revision.reviewAt)}.`]),
  ];
  return [
    ...standing,
    ...revision.evidence.map(
      (item) => `${item.evidence} (${item.source}, ${dateOf(item.observedAt)})`,
    ),
    ...revision.attempts.map((attempt) => `${OUTCOME_WORDS[attempt.outcome]}: ${attempt.evidence}`),
    revision.applicability,
    revision.tradeoffs,
    ...reconsider,
  ].flatMap((line) => (line.trim() ? [line.trim().replace(/\.\.$/, ".")] : []));
}

/** Who recorded a learning: the Champion, or the agent and the machine it ran on. */
export function championLearningAuthor(
  revision: Pick<ChampionLearningRevision, "contribution">,
): string {
  const from = revision.contribution;
  if (from === undefined) return "The Champion";
  const who = from.role === null ? "An agent thread" : AGENT_ROLE_TITLE_LABEL[from.role];
  return from.environmentLabel === null ? who : `${who} on ${from.environmentLabel}`;
}

/** The expanded detail's "Recorded by" line: the author, and the thread a contribution came from. */
export function championLearningRecordedBy(
  revision: Pick<ChampionLearningRevision, "contribution">,
): string {
  const title = revision.contribution?.threadTitle;
  const author = championLearningAuthor(revision);
  return title == null ? author : `${author}, in “${title}”`;
}

/** The line a learning leads with: its plain sentence, or its conclusion until it has one. */
export function championLearningHeadline(entry: ChampionLearningEntry): string {
  return entry.plainSummary ?? entry.revision.conclusion;
}

/** Where a contributed learning stands with its Champion; null for the Champion's own. */
export function championLearningReview(entry: ChampionLearningEntry): string | null {
  if (entry.revision.contribution === undefined) return null;
  return entry.confirmation === null
    ? "Counts now; the Champion confirms or replaces it on its next check."
    : `Confirmed by the Champion: ${entry.confirmation.note}`;
}
