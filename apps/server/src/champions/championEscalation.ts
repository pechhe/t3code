import type { ChampionFinding, OrchestrationV2ThreadChampion } from "@t3tools/contracts";

/**
 * Champion escalation threads (fork/differences.md `champions`): the Inbox's bar for a Champion is a
 * decision it needs, a new confirmed incident, or a Champion that is stuck. These pure rules say which
 * state needs a thread, how it reads, and when it is resolved; ChampionService runs the effects.
 */

/** Opens the attention line the agent-config folder sync leaves when a save fails. */
export const NOT_SAVED_PREFIX = "Not saved to agent-config: ";
/** Checks in a row that end without a clean report before a Champion is stuck; fewer stay quiet. */
export const STUCK_AFTER_FAILURES = 3;

export type EscalationFinding = {
  readonly id: string;
  readonly title: string;
  readonly metricId: string | null;
  /** The metric series a metric finding reads; with `latestSamples` it tells a regression from a chronic breach. */
  readonly seriesId?: string | null | undefined;
  readonly status: ChampionFinding["status"];
  readonly decision?:
    | { readonly status: "requested" | "resolved"; readonly id: string }
    | null
    | undefined;
  readonly repairAttention?: string | null | undefined;
  readonly escalationThreadId?: string | null | undefined;
};
export type EscalationDocument = {
  readonly champion: {
    readonly attention: ReadonlyArray<string>;
    readonly consecutiveCheckFailures?: number | undefined;
    readonly stuckEscalationThreadId?: string | null | undefined;
    readonly journeys?: unknown;
    readonly lifecycle?: string | undefined;
    /** Each series' latest reading as the Champion last presented it. */
    readonly latestSamples?:
      | ReadonlyArray<{ readonly seriesId: string; readonly health: string }>
      | undefined;
  };
  readonly findings: ReadonlyArray<EscalationFinding>;
};

export type EscalationShell = Required<
  Pick<OrchestrationV2ThreadChampion, "findingId" | "severity" | "trigger" | "resolved">
>;

const settledStatus = (finding: Pick<ChampionFinding, "status">) =>
  finding.status === "verified" || finding.status === "dismissed";

/** What a finding's escalation thread says it is, and whether it is over. */
export const classifyFinding = (
  finding: Pick<EscalationFinding, "status" | "metricId" | "decision" | "repairAttention">,
  journey: boolean,
): Pick<EscalationShell, "severity" | "trigger" | "resolved"> => {
  const decision = finding.decision?.status === "requested";
  const repair = finding.repairAttention != null;
  const resolved =
    settledStatus(finding) ||
    (finding.metricId !== null && finding.decision?.status === "resolved" && !repair);
  return {
    severity: decision ? "decision" : repair ? "stuck" : "incident",
    trigger: decision
      ? "Decision requested"
      : repair
        ? "Repair needs attention"
        : finding.metricId !== null
          ? "Metric regressed"
          : journey
            ? "Confirmed journey failure"
            : "New finding",
    resolved,
  };
};

export const stuckState = (
  champion: Pick<
    EscalationDocument["champion"],
    "attention" | "consecutiveCheckFailures" | "lifecycle"
  >,
) => {
  const failures = champion.consecutiveCheckFailures ?? 0;
  const folder = champion.attention.some((line) => line.startsWith(NOT_SAVED_PREFIX));
  return {
    // A retired Champion runs no checks, so nothing is stuck.
    stuck: champion.lifecycle !== "retired" && (failures >= STUCK_AFTER_FAILURES || folder),
    trigger:
      failures >= STUCK_AFTER_FAILURES
        ? `Failed ${failures} checks in a row`
        : "Folder error blocking save",
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
  /** `ensure` makes the thread exist and unsettles it so it returns to the Inbox; `settle` retires it. */
  readonly action: "ensure" | "settle";
};

/**
 * True when a metric finding just opened over a series whose last reading was in target: a regression.
 * A breach the Champion found on its first reading of a series, or one already off target, is a chronic
 * baseline that stays on the Champions page.
 */
const regressed = (
  before: EscalationDocument,
  finding: EscalationFinding,
  prior: EscalationFinding | undefined,
) =>
  finding.metricId !== null &&
  finding.seriesId != null &&
  (prior === undefined || settledStatus(prior)) &&
  (before.champion.latestSamples ?? []).some(
    (sample) => sample.seriesId === finding.seriesId && sample.health === "healthy",
  );

/**
 * The escalation work one Champion write implies: only a new condition escalates (decision request,
 * repair attention, new qualitative finding, metric regression, reopened finding, newly stuck).
 * Routine checks over an unchanged state leave a thread the user settled alone.
 */
export const planEscalation = (
  before: EscalationDocument | undefined,
  after: EscalationDocument,
  forced: ReadonlySet<string> = new Set(),
): ReadonlyArray<EscalationStep> => {
  const steps: EscalationStep[] = [];
  const journey = after.champion.journeys !== undefined;
  for (const finding of after.findings) {
    const prior = before?.findings.find((candidate) => candidate.id === finding.id);
    const now = classifyFinding(finding, journey);
    const target = { kind: "finding", findingId: finding.id } as const;
    const open = !settledStatus(finding);
    const triggered =
      open &&
      ((finding.decision?.status === "requested" &&
        !(prior?.decision?.status === "requested" && prior.decision.id === finding.decision.id)) ||
        (finding.repairAttention != null && prior?.repairAttention == null) ||
        (prior === undefined && before !== undefined && finding.metricId === null) ||
        (before !== undefined && regressed(before, finding, prior)) ||
        (prior?.status === "verified" && !now.resolved) ||
        forced.has(finding.id));
    if (triggered) steps.push({ target, action: "ensure" });
    else if (
      finding.escalationThreadId != null &&
      prior !== undefined &&
      ((now.resolved && !classifyFinding(prior, journey).resolved) ||
        (prior.decision?.status === "requested" && finding.decision?.status !== "requested"))
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

/**
 * The Champion's brief for the first message in an escalation thread, so the person's reply reaches an
 * interactive model that already knows what is wrong. The thread itself starts idle.
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
        "id" | "title" | "evidence" | "status" | "decision" | "diagnosis" | "repairAttention"
      >
    | undefined;
  readonly attention: ReadonlyArray<string>;
}) => {
  const { champion, shell, finding } = input;
  const lines = [
    `This thread was opened by the ${champion.name} Champion (id ${champion.id}) because: ${shell.trigger} (${shell.severity}).`,
    ...(champion.purpose ? [`Its goal: ${champion.purpose}`] : []),
  ];
  if (finding === undefined) {
    lines.push(
      `Champion attention:\n${input.attention.map((line) => `- ${line}`).join("\n") || "- none recorded"}`,
      "Read its current state with t3_champions_get before acting.",
    );
  } else {
    lines.push(
      `Finding ${finding.id} (${finding.status}): ${finding.title}`,
      `Evidence: ${finding.evidence}`,
    );
    if (finding.diagnosis != null)
      lines.push(
        `Diagnosis (${finding.diagnosis.route}): ${finding.diagnosis.text} Why: ${finding.diagnosis.why}`,
      );
    if (finding.repairAttention != null)
      lines.push(`Repair needs attention: ${finding.repairAttention}`);
    const decision = finding.decision;
    if (decision?.status === "requested") {
      lines.push(`Decision ${decision.id} awaits the user: ${decision.question}`);
      if (decision.proposal !== undefined)
        lines.push(
          `Proposal: ${decision.proposal.action} Why: ${decision.proposal.why}${decision.proposal.otherOptions === undefined ? "" : ` Other options: ${decision.proposal.otherOptions}`}`,
        );
      lines.push(
        `Only if the user explicitly approves in this chat, resolve it with t3_champions_finding (action resolve_decision) and approvalQuote set to their exact words; otherwise leave it for the Champion page.`,
      );
    }
  }
  return `Champion escalation context:\n${lines.join("\n")}`;
};

export const sameShell = (a: EscalationShell | undefined, b: EscalationShell | undefined) =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.findingId === b.findingId &&
    a.severity === b.severity &&
    a.trigger === b.trigger &&
    a.resolved === b.resolved);
