import type {
  ChampionFinding,
  ChampionReportedLearning,
  OrchestrationV2ThreadChampion,
} from "@t3tools/contracts";

/**
 * Champion cases (fork/differences.md `champions`): every finding that needs work gets one escalation
 * thread in the Inbox, its case, and so does a stuck Champion. These pure rules say which state needs a
 * thread, how it reads, and when it is over; ChampionService runs the effects.
 */

/** Opens the attention line the agent-config folder sync leaves when a save fails. */
export const NOT_SAVED_PREFIX = "Not saved to agent-config: ";
/** Runs of one rhythm in a row that end without a clean report before a Champion is stuck; fewer stay quiet. */
const STUCK_AFTER_FAILURES = 3;
/** A goal finding's id ends with this; its score, not a metric, opens it. */
export const GOAL_FINDING_SUFFIX = ":goal";
const isGoalFinding = (finding: { readonly id: string }) =>
  finding.id.endsWith(GOAL_FINDING_SUFFIX);

/** A Champion's one tidy-up finding ends with this; it carries learning candidates no finding owns. */
export const TIDY_UP_FINDING_SUFFIX = ":tidy-up";
export const isTidyUpFinding = (finding: { readonly id: string }) =>
  finding.id.endsWith(TIDY_UP_FINDING_SUFFIX);

export type EscalationFinding = {
  readonly id: string;
  readonly title: string;
  readonly metricId: string | null;
  readonly status: ChampionFinding["status"];
  readonly decision?:
    | { readonly status: "requested" | "resolved"; readonly id: string }
    | null
    | undefined;
  readonly alarm?: boolean | undefined;
  readonly escalationThreadId?: string | null | undefined;
};
export type EscalationDocument = {
  readonly champion: {
    readonly attention: ReadonlyArray<string>;
    readonly consecutiveCheckFailures?: number | undefined;
    readonly consecutiveReviewFailures?: number | undefined;
    readonly stuckEscalationThreadId?: string | null | undefined;
    readonly journeys?: unknown;
    readonly lifecycle?: string | undefined;
    /** Set once a readings run has finished; a metric breach opens a case only after that. */
    readonly lastCheckAt?: string | null | undefined;
  };
  readonly findings: ReadonlyArray<EscalationFinding>;
};

export type EscalationShell = Required<
  Pick<OrchestrationV2ThreadChampion, "findingId" | "severity" | "trigger" | "resolved">
> &
  Pick<OrchestrationV2ThreadChampion, "alarm">;

const settledStatus = (finding: Pick<ChampionFinding, "status">) =>
  finding.status === "verified" || finding.status === "dismissed";

/** What a finding's case says it is, and whether it is over. */
export const classifyFinding = (
  finding: Pick<EscalationFinding, "id" | "status" | "metricId" | "decision" | "alarm">,
  journey: boolean,
): Pick<EscalationShell, "severity" | "trigger" | "resolved" | "alarm"> => {
  const decision = finding.decision?.status === "requested";
  return {
    severity: decision ? "decision" : "incident",
    trigger: decision
      ? "Decision requested"
      : finding.alarm === true
        ? "Alarm reached"
        : isGoalFinding(finding)
          ? "Goal score below target"
          : isTidyUpFinding(finding)
            ? "Learnings to record"
            : finding.metricId !== null
              ? "Metric outside target"
              : journey
                ? "Confirmed journey failure"
                : "New finding",
    resolved: settledStatus(finding),
    ...(finding.alarm === true ? { alarm: true } : {}),
  };
};

export const stuckState = (
  champion: Pick<
    EscalationDocument["champion"],
    "attention" | "consecutiveCheckFailures" | "consecutiveReviewFailures" | "lifecycle"
  >,
) => {
  const readings = champion.consecutiveCheckFailures ?? 0;
  const reviews = champion.consecutiveReviewFailures ?? 0;
  const folder = champion.attention.some((line) => line.startsWith(NOT_SAVED_PREFIX));
  // Each rhythm keeps its own streak: a success in one does not clear the other's.
  const failing = readings >= STUCK_AFTER_FAILURES || reviews >= STUCK_AFTER_FAILURES;
  // A retired Champion runs nothing, so nothing is stuck.
  const stuck = champion.lifecycle !== "retired" && (failing || folder);
  return {
    stuck,
    trigger:
      readings >= STUCK_AFTER_FAILURES
        ? `Failed ${readings} readings runs in a row`
        : reviews >= STUCK_AFTER_FAILURES
          ? `Failed ${reviews} goal reviews in a row`
          : folder
            ? "Folder error blocking save"
            : "No longer stuck",
  };
};

/** Every thread an escalation owns in this Champion state, with the shell metadata it carries. */
export const escalationShells = (doc: EscalationDocument) => {
  const journey = doc.champion.journeys !== undefined;
  const entries = new Map<string, EscalationShell>();
  for (const finding of doc.findings) {
    if (finding.escalationThreadId == null) continue;
    entries.set(finding.escalationThreadId, {
      findingId: finding.id,
      ...classifyFinding(finding, journey),
    });
  }
  const stuck = stuckState(doc.champion);
  if (doc.champion.stuckEscalationThreadId != null)
    entries.set(doc.champion.stuckEscalationThreadId, {
      findingId: null,
      severity: "stuck",
      trigger: stuck.trigger,
      resolved: !stuck.stuck,
    });
  return entries;
};

export type EscalationStep = {
  readonly target:
    | { readonly kind: "finding"; readonly findingId: string }
    | { readonly kind: "stuck" };
  /** `ensure` makes the case exist and unsettles it so it returns to the Inbox; `settle` retires it. */
  readonly action: "ensure" | "settle";
  /** A finding that closed and reopened gets a new case even when its old one was archived or deleted. */
  readonly fresh?: boolean | undefined;
  /** An alarm: the case starts at once, attended or not. */
  readonly start?: boolean | undefined;
};

/**
 * The case work one Champion write implies: one case per new, reopened or alarmed finding. A metric
 * breach waits for a finished readings run, so the first-ever reading opens none. `forced` names
 * findings that need a case whatever changed (reopened by a person, or left caseless by an upgrade).
 */
export const planEscalation = (
  before: EscalationDocument | undefined,
  after: EscalationDocument,
  forced: ReadonlySet<string> = new Set(),
): ReadonlyArray<EscalationStep> => {
  const steps: EscalationStep[] = [];
  const readingsRan = before?.champion.lastCheckAt != null;
  for (const finding of after.findings) {
    const prior = before?.findings.find((candidate) => candidate.id === finding.id);
    const target = { kind: "finding", findingId: finding.id } as const;
    const open = !settledStatus(finding);
    const reopened = prior !== undefined && settledStatus(prior) && open;
    const isNew =
      prior === undefined &&
      before !== undefined &&
      (finding.metricId === null || readingsRan || finding.alarm === true);
    const alarmed = finding.alarm === true && prior?.alarm !== true;
    const wanted = forced.has(finding.id);
    if (open && (isNew || reopened || alarmed || wanted))
      steps.push({
        target,
        action: "ensure",
        fresh: reopened || wanted,
        start: finding.alarm === true,
      });
    else if (
      finding.escalationThreadId != null &&
      prior !== undefined &&
      settledStatus(finding) &&
      !settledStatus(prior)
    )
      steps.push({ target, action: "settle" });
  }
  const wasStuck = before !== undefined && stuckState(before.champion).stuck;
  const isStuck = stuckState(after.champion).stuck;
  if (isStuck && !wasStuck) steps.push({ target: { kind: "stuck" }, action: "ensure" });
  else if (!isStuck && wasStuck && after.champion.stuckEscalationThreadId != null)
    steps.push({ target: { kind: "stuck" }, action: "settle" });
  return steps;
};

/** The workspace line every case brief carries. */
export const CASE_WORKSPACE_RULE =
  "Read and investigate in the project's main checkout without editing it. Only work that changes code allocates a workspace: a SlipJay workspace in the repository that owns the cause";

/** How a case records the learnings its brief lists, by the home each belongs in. */
const LEARNINGS_TO_RECORD = [
  "Learnings to record: a goal review reported these. Verify each against the code. Record each one that holds in its canonical home, in the same change as the fix (or as one change when there is no fix), following the learnings map in ~/.agents/references/learnings.md. Delete any Champion copy you promote in the same change. Say what you did with each, including any that did not hold. Homes:",
  "- decision: a product or architectural rule becomes a Decision proposal.",
  "- doc: a behaviour or trap goes in the owning doc.",
  "- glossary: a term goes in the glossary.",
  "- research: an experiment or R&D outcome goes in the area's research ledger.",
  "- agents: a tool or harness behaviour goes in ~/.agents, which is plain git: commit and push there directly.",
  "- champion: a measurement quirk goes in the Champion's own learnings: t3_champions_record_learning for a local Champion, or the repository's .agents/champions/<id>/learnings/ by landing for a repository-hosted one.",
  "- check: a rule a test or check can enforce becomes that test or check, not prose.",
].join("\n");

/**
 * The case's brief for its first message, complete enough for a strong agent to diagnose, fix, file a
 * Spec or ask Henry. After that the agent reads live state with the Champion tools.
 */
export const formatEscalationBrief = (input: {
  readonly champion: {
    readonly id: string;
    readonly name: string;
    readonly purpose?: string | undefined;
  };
  readonly shell: EscalationShell;
  readonly finding?:
    | Pick<
        ChampionFinding,
        | "id"
        | "title"
        | "evidence"
        | "status"
        | "decision"
        | "alarm"
        | "firstSeenAt"
        | "lastConfirmedAt"
        | "updatedAt"
      >
    | undefined;
  readonly attention: ReadonlyArray<string>;
  /** The thread the Champion's readings and reviews run in; absent when it has none. */
  readonly ownerThreadId?: string | null | undefined;
  /** Where the Champion's definition lives, for the workspace line. */
  readonly repository?: string | undefined;
  /** The finding's metric readings, newest first. */
  readonly readings?:
    | ReadonlyArray<{
        readonly at: string;
        readonly value: number | null;
        readonly status: string;
        readonly unit: string;
      }>
    | undefined;
  /** The latest goal score, with its reasons. */
  readonly goalScore?:
    | {
        readonly score: number;
        readonly target: number;
        readonly reasons: string;
        readonly change: string;
        readonly at: string;
      }
    | undefined;
  /** Recent runs that counted as failed, newest first; read for a stuck case only. */
  readonly failures?: ReadonlyArray<{ readonly at: string; readonly text: string }> | undefined;
  /** The learnings the case records: the finding's own, or the candidates a tidy-up finding carries. */
  readonly learnings?: ReadonlyArray<ChampionReportedLearning> | undefined;
  /** Repair threads the upgrade to observe-only Champions released for this finding (migration 158). */
  readonly releasedRepairThreadIds?: ReadonlyArray<string> | undefined;
}) => {
  const { champion, shell, finding } = input;
  const lines = [
    `This case was opened by the ${champion.name} Champion (id ${champion.id}) because: ${shell.trigger}.`,
    ...(champion.purpose ? [`Its goal: ${champion.purpose}`] : []),
    ...(input.ownerThreadId
      ? [
          `Its readings and goal reviews run in thread ${input.ownerThreadId}, which only observes and scores; read it with t3_thread_read to see what recent runs found.`,
        ]
      : []),
    input.goalScore === undefined
      ? "No goal review has scored the goal yet."
      : `Latest goal score: ${input.goalScore.score}/10 (target ${input.goalScore.target}) at ${input.goalScore.at}. Why not higher: ${input.goalScore.reasons} Changed since the previous score: ${input.goalScore.change}`,
  ];
  if (finding === undefined) {
    lines.push(
      `Champion attention:\n${input.attention.map((line) => `- ${line}`).join("\n") || "- none recorded"}`,
      ...(input.failures === undefined || input.failures.length === 0
        ? []
        : [
            `Recent runs that ended without a report:\n${input.failures.map((entry) => `- ${entry.at} ${entry.text}`).join("\n")}`,
          ]),
    );
  } else {
    lines.push(
      `Finding ${finding.id} (${finding.status}${finding.alarm === true ? ", ALARM" : ""}): ${finding.title}`,
      `First seen ${finding.firstSeenAt ?? finding.updatedAt}; last confirmed ${finding.lastConfirmedAt ?? finding.updatedAt}.`,
      finding.alarm === true
        ? "This is an alarm: a reading reached the metric's alarm value, or two readings in a row could not be taken, so this case started at once."
        : "This is not an alarm.",
      `Evidence: ${finding.evidence}`,
      ...(input.releasedRepairThreadIds ?? []).map(
        (threadId) =>
          `An earlier repair attempt ran in thread ${threadId} before Champions stopped repairing; read it with t3_thread_read and build on what it did rather than repeating it.`,
      ),
    );
    if (input.readings !== undefined && input.readings.length > 0)
      lines.push(
        `Its readings, newest first:\n${input.readings.map((reading) => `- ${reading.at} ${reading.status === "measured" ? `${reading.value} ${reading.unit}` : reading.status}`).join("\n")}`,
      );
    const decision = finding.decision;
    if (decision?.status === "requested") {
      lines.push(`Decision ${decision.id} awaits the user: ${decision.question}`);
      if (decision.proposal !== undefined)
        lines.push(
          `Proposal: ${decision.proposal.action} Why: ${decision.proposal.why}${decision.proposal.otherOptions === undefined ? "" : ` Other options: ${decision.proposal.otherOptions}`}`,
        );
      lines.push(
        `Only if the user explicitly approves in this chat, resolve it with t3_champions_finding_action (action resolve_decision) and approvalQuote set to their exact words; otherwise leave it for the card.`,
      );
    }
    if (input.learnings !== undefined && input.learnings.length > 0)
      lines.push(
        `${LEARNINGS_TO_RECORD}\n${input.learnings.map((learning, index) => `${index + 1}. [${learning.home}] ${learning.statement} Evidence: ${learning.evidence}`).join("\n")}`,
      );
    lines.push(
      isTidyUpFinding(finding)
        ? `You own this case: it only records the learnings above. When each is recorded or found not to hold, close the finding with t3_champions_finding_action action verify and say what you did with each; dismiss it with a reason if none needs recording.`
        : `You own this case: diagnose it, fix it, file a Spec, or ask Henry here (an owner wait) when only he can decide. When it is fixed, close the finding with t3_champions_finding_action action verify and the evidence; dismiss it with a reason if it needs no work.`,
    );
  }
  lines.push(
    `Workspace rule: ${CASE_WORKSPACE_RULE} (${input.repository ?? "the Champion's repository"}, or T3 Peach (pechhe/t3code) when the Champion pipeline itself fails). Never edit a shared main checkout.`,
    "Read the Champion's current state with t3_champions_get before acting.",
  );
  return `Champion case brief:\n${lines.join("\n")}`;
};

export const sameShell = (a: EscalationShell | undefined, b: EscalationShell | undefined) =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.findingId === b.findingId &&
    a.severity === b.severity &&
    a.trigger === b.trigger &&
    a.resolved === b.resolved &&
    a.alarm === b.alarm);
