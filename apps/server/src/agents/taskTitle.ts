import type { AgentRole } from "@t3tools/contracts";

const roleLabels: Record<AgentRole, string> = {
  "chore-worker": "Chore worker",
  "implementation-worker": "Implementation worker",
  "ui-worker": "UI worker",
  browser: "Browser",
  "ui-verifier": "UI verifier",
  advisor: "Advisor",
  reviewer: "Reviewer",
};

/**
 * The title of a managed task: the caller's own, else its role and the first line of
 * the task, so a sub-agent row names what it is rather than quoting its role brief.
 */
export const managedTaskTitle = (
  role: AgentRole,
  task: string,
  title: string | undefined,
): string => {
  if (title !== undefined) return title;
  const firstLine = task
    .split("\n")
    .find((line) => line.trim().length > 0)
    ?.trim();
  return firstLine === undefined ? roleLabels[role] : `${roleLabels[role]}: ${firstLine}`;
};
