import { AGENT_ROLE_TITLE_LABEL, type AgentRole } from "@t3tools/contracts";

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
  return topic.length === 0
    ? AGENT_ROLE_TITLE_LABEL[role]
    : `${AGENT_ROLE_TITLE_LABEL[role]} · ${topic}`;
};
