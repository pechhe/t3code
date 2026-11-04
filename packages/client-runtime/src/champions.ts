import {
  ChampionError,
  type ChampionFinding,
  type ChampionLatestSample,
  type ChampionMetric,
  type ChampionMetricInput,
  type ChampionSummary,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
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

/** The server's reason is a code rather than a sentence, and its meaning depends on the action. */
export function championFailureMessage(failure: unknown, action: ChampionAction): string {
  if (isChampionError(failure)) {
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
