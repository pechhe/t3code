import type { VcsStatusResult, VcsStatusSlipJayLanding } from "@t3tools/contracts";

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
