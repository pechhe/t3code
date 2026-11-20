import type { AgentTaskBinding } from "@t3tools/contracts";

import type { ThreadLaunchWorkspaceStrategy } from "./ThreadLaunchService.ts";

/**
 * A launch naming the item by the contract's older key (`buildItem`) reads as `forgeItem` from
 * here on, so a saved client keeps binding the item's workspace.
 */
export const withForgeItem = (
  strategy: ThreadLaunchWorkspaceStrategy,
): ThreadLaunchWorkspaceStrategy =>
  strategy.type !== "worktree" ||
  strategy.forgeItem !== undefined ||
  strategy.buildItem === undefined
    ? strategy
    : { ...strategy, forgeItem: strategy.buildItem };

/**
 * A task a link sent to a project's root runs in the folder this launch allocated, so
 * the folder, not the root the caller could not know to avoid, is the workspace it was given.
 */
export const rebindRootTask = (input: {
  readonly agentTask: AgentTaskBinding | undefined;
  readonly initialWorktreePath: string | null;
  readonly requestedStrategy: ThreadLaunchWorkspaceStrategy;
  readonly workspaceRoot: string;
}): AgentTaskBinding | undefined =>
  input.agentTask !== undefined &&
  input.initialWorktreePath !== null &&
  input.requestedStrategy.type === "root" &&
  input.agentTask.workspacePath === input.workspaceRoot
    ? { ...input.agentTask, workspacePath: input.initialWorktreePath }
    : input.agentTask;
