import {
  AGENT_ROLE_TITLE_LABEL,
  AGENT_TASK_TITLE_LABELS,
  type AgentRole,
  withoutAgentRolePrefix,
} from "@t3tools/contracts";

/**
 * The title of a managed task: its role, then the caller's topic or else the first line of the
 * task, so every sub-agent row says which job it is doing. The caller's own role word is dropped
 * so the row's role chip is the only place the role appears.
 */
export const managedTaskTitle = (
  role: AgentRole,
  task: string,
  title: string | undefined,
): string => {
  const topic = (
    withoutAgentRolePrefix(title?.trim() ?? "", AGENT_TASK_TITLE_LABELS) ||
    task.split("\n").find((line) => line.trim().length > 0) ||
    ""
  ).trim();
  return topic.length === 0
    ? AGENT_ROLE_TITLE_LABEL[role]
    : `${AGENT_ROLE_TITLE_LABEL[role]} · ${topic}`;
};
