import type { SubagentStatus } from "@t3tools/client-runtime/state/threads";

/** Delegated work reads apart from the blue of a thread working itself. */
const DELEGATED_WORK_CLASS = "text-cyan-700 dark:text-cyan-300";

export const SUBAGENT_STATUS_PRESENTATION: Record<
  SubagentStatus,
  { readonly label: string; readonly className: string }
> = {
  approval: { label: "Needs approval", className: "text-warning-foreground" },
  input: { label: "Needs input", className: "text-indigo-600 dark:text-indigo-300" },
  working: { label: "Working", className: DELEGATED_WORK_CLASS },
  waiting: { label: "Waiting", className: "text-muted-foreground" },
};
