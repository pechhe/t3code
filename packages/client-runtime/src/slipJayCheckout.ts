import type {
  SlipJayRunnerOperation,
  SlipJayRunnerOverview,
  VcsSlipJayLandingDetailResult,
  VcsStatusResult,
  VcsStatusSlipJayLanding,
} from "@t3tools/contracts";

/** Where a thread works in a SlipJay project, from the checkout's VCS status. */
export interface SlipJayCheckout {
  /** Null when slipjay.json does not name a usable integration bookmark. */
  integration: string | null;
  workspace: NonNullable<VcsStatusResult["slipJay"]>["workspace"];
  behindCount: number;
  changedFileCount: number;
  /** The latest landing of the workspace's change, or null when it has none. */
  landing: VcsStatusSlipJayLanding | null;
}

/** A SlipJay checkout with the path its status describes, for acting on it. */
export interface SlipJayCheckoutStatus extends SlipJayCheckout {
  cwd: string;
}

/** A checkout in a SlipJay project: the server reports it from the same slipjay.json check. */
export function resolveSlipJayCheckout(
  status: VcsStatusResult | null | undefined,
): SlipJayCheckout | null {
  if (status?.slipJay === undefined) return null;
  return {
    integration: status.slipJay.integration,
    workspace: status.slipJay.workspace,
    behindCount: status.behindCount,
    changedFileCount: status.workingTree.files.length,
    landing: status.slipJay.landing ?? null,
  };
}

export function resolveSlipJayCheckoutStatus(
  status: VcsStatusResult | null | undefined,
  cwd: string | null,
): SlipJayCheckoutStatus | null {
  const checkout = resolveSlipJayCheckout(status);
  return checkout === null || cwd === null ? null : { ...checkout, cwd };
}

/** The strip's label for a landing, in SlipJay's own stage names. */
export function resolveSlipJayLandingLabel(landing: VcsStatusSlipJayLanding): string {
  switch (landing.status) {
    case "active":
      return landing.live
        ? `Landing · ${landing.stage}`
        : `Landing · ${landing.stage} · reconnecting`;
    case "landed":
      return landing.commitId === undefined ? "Landed" : `Landed ${landing.commitId.slice(0, 7)}`;
    case "failed":
      return `Land failed: ${landing.stage}`;
    case "cancelled":
      return "Land cancelled";
    case "declined":
      return "Land declined";
    case "unknown":
      return "Land outcome unknown";
  }
}

/**
 * A draft is labelled for the workspace its first message allocates; a started
 * thread names its own, or the integration checkout as `<integration> (root)`.
 */
export function resolveSlipJayWorkspaceLabel(status: SlipJayCheckout, isDraft: boolean): string {
  if (isDraft) return "New workspace";
  const workspace = status.workspace;
  if (workspace === undefined) return "SlipJay workspace";
  if (workspace.isIntegration) return `${status.integration ?? "Integration"} (root)`;
  return workspace.issueNumber === undefined
    ? workspace.name
    : `${workspace.name} · #${workspace.issueNumber}`;
}

/**
 * `on <integration>`, with how far it has moved past the base and the uncommitted
 * edits; null when slipjay.json names no usable bookmark.
 */
export function resolveSlipJayBaseLabel(status: SlipJayCheckout, isDraft: boolean): string | null {
  if (status.integration === null) return null;
  const parts = [`on ${status.integration}`];
  // A draft's counts describe the root checkout, not the workspace it will get.
  if (!isDraft && status.behindCount > 0) parts.push(`${status.behindCount} behind`);
  if (!isDraft && status.changedFileCount > 0)
    parts.push(`${status.changedFileCount} ${status.changedFileCount === 1 ? "file" : "files"}`);
  return parts.join(" · ");
}

/** The SlipJay workspace a thread works in: SlipJay names it after its directory. */
export function slipJayWorkspaceName(worktreePath: string | null): string | null {
  if (worktreePath === null) return null;
  const name = worktreePath
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .at(-1);
  return name === undefined || name.length === 0 ? null : name;
}

/** An open operation in the runner's lanes by its id; null once it has left them. */
export function findSlipJayRunnerOperation(
  overview: SlipJayRunnerOverview | null | undefined,
  operationId: string,
): SlipJayRunnerOperation | null {
  if (overview === null || overview === undefined) return null;
  return (
    [...overview.serial, ...overview.deploy].find(
      (operation) => operation.operationId === operationId,
    ) ?? null
  );
}

/** Where a queued operation waits: `next`, or how many are ahead of it. Null once it runs. */
export function resolveSlipJayQueueLabel(operation: SlipJayRunnerOperation): string | null {
  if (operation.status !== "queued") return null;
  if (operation.position === undefined) return "Queued";
  const ahead = operation.position - 1;
  return ahead <= 0 ? "Queued · next" : `Queued · ${ahead} ahead`;
}

/**
 * The header's one-line summary of the runner, such as `1 running · 2 queued`, or null
 * when this environment follows no SlipJay runner. Counts only what is open in the lanes.
 */
export function resolveSlipJayRunnerSummary(
  overview: SlipJayRunnerOverview | null | undefined,
  /** An operation shown on its own, such as the thread's landing, left out of the count. */
  excludeOperationId?: string,
): {
  label: string;
  tone: "idle" | "busy" | "attention";
  /** The operation to name: the running landing, else a running deploy; null while nothing runs. */
  lead: SlipJayRunnerOperation | null;
  /** Open operations besides `lead`. */
  others: number;
} | null {
  if (overview === null || overview === undefined) return null;
  const open = [...overview.serial, ...overview.deploy].filter(
    (operation) => operation.operationId !== excludeOperationId,
  );
  if (!overview.connected && open.length === 0 && overview.deploys.length === 0) return null;
  const lead = open.find((operation) => operation.status === "running") ?? null;
  const others = open.length - (lead === null ? 0 : 1);
  if (!overview.connected) return { label: "reconnecting", tone: "attention", lead, others };
  if (overview.paused) return { label: "paused", tone: "attention", lead, others };
  const running = open.filter((operation) => operation.status === "running").length;
  const queued = open.length - running;
  const parts = [
    ...(running > 0 ? [`${running} running`] : []),
    ...(queued > 0 ? [`${queued} queued`] : []),
  ];
  return parts.length === 0
    ? { label: "idle", tone: "idle", lead, others }
    : { label: parts.join(" · "), tone: "busy", lead, others };
}

/** What a runner row is, in the words a lane shows it with. */
export function resolveSlipJayOperationLabel(operation: SlipJayRunnerOperation): string {
  const commit = operation.commitId === undefined ? "" : ` ${operation.commitId.slice(0, 7)}`;
  switch (operation.kind) {
    case "deploy":
      return `Deploy${commit} to ${operation.environment ?? "an environment"}`;
    case "release":
      return `Release${commit}`;
    case "reset":
      return "Reset";
    default:
      return operation.workspaceName ?? `Landing${commit}`;
  }
}

/**
 * The composer prompt asking a thread's agent to fix its failed landing, in SlipJay's own
 * words, so the agent can read the log and land again from the same workspace.
 */
export function resolveSlipJayFixPrompt(landing: VcsStatusSlipJayLanding): string {
  const reason = landing.reason === undefined ? "" : `: ${landing.reason}`;
  return [
    `The SlipJay landing ${landing.operationId} failed at ${landing.stage}${reason}.`,
    `Read its log with \`slipjay runner log ${landing.operationId}\`, fix the cause in this workspace, and land again.`,
  ].join("\n");
}

/** A landing's stages after the queue, in the order the runner moves through them. */
export const SLIPJAY_LANDING_STAGES = [
  "fetching",
  "rebasing",
  "installing",
  "verifying",
  "integrating",
  "finalizing",
  "publishing",
] as const;

/**
 * How far a landing got through `SLIPJAY_LANDING_STAGES`: how many it finished and the one
 * it is in, or stopped in when it failed. A stage SlipJay adds later counts as none.
 */
export function resolveSlipJayStageProgress(landing: VcsStatusSlipJayLanding): {
  completed: number;
  current: number | null;
} {
  if (landing.status === "landed")
    return { completed: SLIPJAY_LANDING_STAGES.length, current: null };
  const index = SLIPJAY_LANDING_STAGES.indexOf(
    landing.stage as (typeof SLIPJAY_LANDING_STAGES)[number],
  );
  return index < 0 ? { completed: 0, current: null } : { completed: index, current: index };
}

/** `42s`, `1:36` or `1:02:05`. */
export function formatSlipJayDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

/**
 * How long an operation has spent in its current phase: waiting since submission while
 * queued, then running since it left the queue. Null where the runner gave no time.
 */
export function resolveSlipJayOperationElapsed(
  operation: Pick<SlipJayRunnerOperation, "submittedAt" | "startedAt">,
  queued: boolean,
  now: number,
): string | null {
  const since = queued ? operation.submittedAt : operation.startedAt;
  return since === undefined ? null : formatSlipJayDuration(now - Date.parse(since));
}

export type SlipJayLandingChipTone = "waiting" | "running" | "failed" | "landed" | "ended";

/**
 * What a thread's landing chip says about its landing. `operation` is the landing's row in
 * the runner's lanes, read for its queue place and timing; the overview can trail the
 * landing's own stage, so its timing counts only while both agree on the phase or stage.
 */
export function resolveSlipJayLandingChip(
  landing: VcsStatusSlipJayLanding,
  operation: SlipJayRunnerOperation | null,
  now: number,
): {
  tone: SlipJayLandingChipTone;
  label: string;
  detail: string | null;
  elapsed: string | null;
  /** The running stage has outlasted the runner's median for it. */
  slow: boolean;
} {
  const queued = landing.stage === "queued";
  const elapsed =
    landing.status === "active" && operation !== null && (operation.status === "queued") === queued
      ? resolveSlipJayOperationElapsed(operation, queued, now)
      : null;
  switch (landing.status) {
    case "active": {
      // The landing's own stage is current; the overview only adds its queue place.
      if (landing.stage === "queued") {
        const ahead =
          operation?.status !== "queued" || operation.position === undefined
            ? null
            : operation.position - 1;
        return {
          tone: "waiting",
          label: "waiting",
          detail: ahead === null ? null : ahead <= 0 ? "next" : `${ahead} ahead`,
          elapsed,
          slow: false,
        };
      }
      const timing = operation?.stage === landing.stage ? operation : null;
      const left =
        timing?.stageStartedAt === undefined || timing.stageMedianMs === undefined
          ? null
          : timing.stageMedianMs - (now - Date.parse(timing.stageStartedAt));
      return {
        tone: "running",
        label: landing.live ? landing.stage : `${landing.stage} · reconnecting`,
        detail:
          left === null
            ? null
            : left > 0
              ? `~${formatSlipJayDuration(left)} left`
              : "slower than usual",
        elapsed,
        slow: left !== null && left <= 0,
      };
    }
    case "landed":
      return {
        tone: "landed",
        label: "landed",
        detail: landing.commitId === undefined ? null : landing.commitId.slice(0, 7),
        elapsed: null,
        slow: false,
      };
    case "failed":
      return {
        tone: "failed",
        label: `failed at ${landing.stage}`,
        detail: null,
        elapsed: null,
        slow: false,
      };
    case "cancelled":
      return { tone: "ended", label: "cancelled", detail: null, elapsed: null, slow: false };
    case "declined":
      return { tone: "ended", label: "declined", detail: null, elapsed: null, slow: false };
    case "unknown":
      return { tone: "ended", label: "outcome unknown", detail: null, elapsed: null, slow: false };
  }
}

/**
 * How long a landing has taken, from submission to its finish or `now`, and how much of
 * that its checks ran; null where the runner did not record enough to say.
 */
export function resolveSlipJayLandingTimes(
  detail: VcsSlipJayLandingDetailResult,
  now: number,
): { took: string | null; checks: string | null } {
  const finished = detail.checks.flatMap((check) =>
    check.durationMs === undefined ? [] : [check.durationMs],
  );
  const submitted = detail.submittedAt === undefined ? NaN : Date.parse(detail.submittedAt);
  // A finished landing without its finish time took an unknown time, not one up to now.
  const end =
    detail.finishedAt !== undefined ? Date.parse(detail.finishedAt) : detail.terminal ? NaN : now;
  const took = end - submitted;
  return {
    took: Number.isFinite(took) ? formatSlipJayDuration(took) : null,
    checks:
      finished.length === 0
        ? null
        : formatSlipJayDuration(finished.reduce((total, ms) => total + ms, 0)),
  };
}
