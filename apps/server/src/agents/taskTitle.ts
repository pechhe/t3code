import type { AgentRole } from "@t3tools/contracts";

const roleLabels: Record<AgentRole, string> = {
  "chore-worker": "Chore worker",
  "implementation-worker": "Implementation worker",
  "ui-worker": "UI worker",
  browser: "Browser",
  "ui-verifier": "UI verifier",
  advisor: "Advisor",
  "ticket-reviewer": "Ticket reviewer",
  "spec-reviewer": "Spec reviewer",
};

/** Thread-title prefixes callers used before T3 named the role itself. */
const callerPrefix = /^(?:lead|worker|solo|chat)\s*[·:\-–—]\s+/i;

/**
 * The title of a managed task: its role, then the caller's topic or else the first line
 * of the task, so every sub-agent row says which job it is doing.
 */
export const managedTaskTitle = (
  role: AgentRole,
  task: string,
  title: string | undefined,
): string => {
  const topic = (
    title?.trim().replace(callerPrefix, "") ||
    task.split("\n").find((line) => line.trim().length > 0) ||
    ""
  ).trim();
  return topic.length === 0 ? roleLabels[role] : `${roleLabels[role]} · ${topic}`;
};
