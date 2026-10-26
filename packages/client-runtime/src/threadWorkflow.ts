import type {
  OrchestrationV2ThreadWorkflow,
  OrchestrationV2ThreadWorkflowKind,
  ProjectIconColor,
} from "@t3tools/contracts";

/** The workflows a person can pick. `worker` is a child thread's own role, shown by its role chip. */
export const SELECTABLE_THREAD_WORKFLOW_KINDS = [
  "lead",
  "shape",
  "solo",
  "chat",
] as const satisfies ReadonlyArray<OrchestrationV2ThreadWorkflowKind>;

export type SelectableThreadWorkflowKind = (typeof SELECTABLE_THREAD_WORKFLOW_KINDS)[number];

export const THREAD_WORKFLOW_LABELS: Record<SelectableThreadWorkflowKind, string> = {
  lead: "Lead",
  shape: "Shape",
  solo: "Solo",
  chat: "Chat",
};

/** Each workflow's tint, from the project colour palette, the same on every client. */
export const THREAD_WORKFLOW_TINTS: Record<SelectableThreadWorkflowKind, ProjectIconColor> = {
  lead: "indigo",
  shape: "fuchsia",
  solo: "sky",
  chat: "gray",
};

/**
 * The workflow a list or header chip shows, or null for no chip: unset, and `worker`,
 * which child threads already show as their role chip.
 */
export function visibleThreadWorkflow(
  workflow: OrchestrationV2ThreadWorkflow | null | undefined,
): { kind: SelectableThreadWorkflowKind } | null {
  if (!workflow || workflow.kind === "worker") return null;
  return { kind: workflow.kind };
}

/** Away is environment-wide, so a workflow the client sets carries no per-thread stance. */
export function withWorkflowKind(
  kind: SelectableThreadWorkflowKind,
): OrchestrationV2ThreadWorkflow {
  return { kind, unattended: false };
}
