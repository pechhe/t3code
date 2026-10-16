import type {
  SlipJayRunnerOperation,
  SlipJayRunnerOverview,
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
 * The header's one-line summary of the runner, or null when this environment follows
 * no SlipJay runner. Counts only what is open in the lanes.
 */
export function resolveSlipJayRunnerSummary(
  overview: SlipJayRunnerOverview | null | undefined,
): { label: string; tone: "idle" | "busy" | "attention" } | null {
  if (overview === null || overview === undefined) return null;
  const open = [...overview.serial, ...overview.deploy];
  if (!overview.connected && open.length === 0 && overview.deploys.length === 0) return null;
  if (!overview.connected) return { label: "SlipJay · reconnecting", tone: "attention" };
  if (overview.paused) return { label: "SlipJay · paused", tone: "attention" };
  const running = open.filter((operation) => operation.status === "running").length;
  const queued = open.filter((operation) => operation.status === "queued").length;
  const parts = [
    ...(running > 0 ? [`${running} running`] : []),
    ...(queued > 0 ? [`${queued} queued`] : []),
  ];
  return parts.length === 0
    ? { label: "SlipJay · idle", tone: "idle" }
    : { label: `SlipJay · ${parts.join(" · ")}`, tone: "busy" };
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
