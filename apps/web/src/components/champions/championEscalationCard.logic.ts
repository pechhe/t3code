import {
  canDismissChampionFinding,
  canReopenChampionFinding,
  CHAMPION_READING_STATUS_LABELS,
  championFindingIsClosed,
  formatChampionValue,
  pendingChampionDecision,
} from "@t3tools/client-runtime/champions";
import type {
  ChampionDetail,
  ChampionFinding,
  OrchestrationV2ThreadChampion,
} from "@t3tools/contracts";

import { metricHasTarget, metricTargetLabel } from "./champions.logic";

export interface EscalationMetricStrip {
  readonly name: string;
  readonly reading: string | null;
  readonly target: string | null;
  readonly baseline: string | null;
}

export type EscalationResolutionKind = "approved" | "dismissed" | "verified" | "resolved";

export interface EscalationCardState {
  readonly severity: "decision" | "incident" | "stuck";
  readonly resolution: EscalationResolutionKind | null;
  readonly canApproveProposal: boolean;
  readonly canDismiss: boolean;
  readonly canReopen: boolean;
  readonly canInvestigate: boolean;
}

export function selectEscalationFinding(
  detail: ChampionDetail | null | undefined,
  findingId: string | null | undefined,
): ChampionFinding | null {
  if (!detail || !findingId) return null;
  return detail.findings.find((finding) => finding.id === findingId) ?? null;
}

export function selectEscalationMetricStrip(
  detail: ChampionDetail | null | undefined,
  finding: ChampionFinding | null,
): EscalationMetricStrip | null {
  if (!finding) return null;
  const metric = finding.metricId
    ? (detail?.metrics.find((candidate) => candidate.id === finding.metricId) ?? null)
    : null;
  const sample =
    finding.metricId !== null
      ? ((detail?.latestSamples ?? detail?.champion.latestSamples ?? []).find(
          (candidate) => candidate.metricId === finding.metricId,
        ) ?? null)
      : null;
  if (metric === null && sample === null) return null;

  const name = metric?.name ?? sample?.name ?? finding.metricId ?? "";
  if (!name) return null;

  const unit = metric?.unit ?? sample?.unit ?? "";
  const reading =
    sample === null
      ? null
      : sample.status === "measured" && sample.value !== null
        ? formatChampionValue(sample.value, sample.unit)
        : CHAMPION_READING_STATUS_LABELS[sample.status === "measured" ? "unknown" : sample.status];
  const target = metric && metricHasTarget(metric) ? metricTargetLabel(metric) : null;
  const baseline = metric?.baseline != null ? formatChampionValue(metric.baseline, unit) : null;

  return { name, reading, target, baseline };
}

export function resolveEscalationCardState(input: {
  readonly champion: OrchestrationV2ThreadChampion;
  readonly detail: ChampionDetail | null | undefined;
  readonly finding: ChampionFinding | null;
  /** The thread already has a message or run, so its first conversation is under way. */
  readonly started?: boolean | undefined;
}): EscalationCardState {
  const { champion, detail, finding } = input;
  const severity: "decision" | "incident" | "stuck" =
    champion.severity ?? (champion.findingId == null ? "stuck" : "incident");
  const pendingDecision = finding ? pendingChampionDecision(finding) : null;

  let resolution: EscalationResolutionKind | null = null;
  if (finding !== null) {
    if (finding.status === "dismissed") {
      resolution = "dismissed";
    } else if (finding.status === "verified") {
      resolution = "verified";
    } else if (finding.decision?.status === "resolved") {
      resolution = "approved";
    } else if (championFindingIsClosed(finding) || champion.resolved === true) {
      resolution = "resolved";
    }
  } else if (champion.resolved === true) {
    resolution = "resolved";
  } else if (
    detail &&
    severity === "stuck" &&
    (detail.champion.consecutiveCheckFailures ?? 0) === 0 &&
    detail.champion.attention.length === 0
  ) {
    resolution = "resolved";
  }

  const unresolved = resolution === null;
  const canApproveProposal = unresolved && pendingDecision?.proposal !== undefined;
  const canDismiss = unresolved && finding !== null && canDismissChampionFinding(finding);
  const canReopen = finding !== null && canReopenChampionFinding(finding);
  const canInvestigate = unresolved && !canApproveProposal && input.started !== true;

  return {
    severity,
    resolution,
    canApproveProposal,
    canDismiss,
    canReopen,
    canInvestigate,
  };
}
