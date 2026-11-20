/* oxlint-disable t3code/no-untranslated-copy -- English labels in the operating guide's words, as they were in subagentDisplay.ts. */
import type { AgentExecutionBoundary } from "@t3tools/contracts";
import type { RuntimeSubagentStatus } from "./subagentRuntime.ts";

/** A task its parent's Stop interrupted; its status stays `interrupted`, and the parent's next message resumes it. */
export function isSubagentPausedByParentStop(subagent: {
  readonly status: RuntimeSubagentStatus;
  readonly pausedByParentStop?: true | undefined;
}): boolean {
  return subagent.status === "interrupted" && subagent.pausedByParentStop === true;
}

export const PAUSED_SUBAGENT_LABEL = "Paused";

/**
 * What a managed task's runtime technically enforces, in the words the operating guide
 * uses. A trusted writer's workspace is its assignment, not a sandbox.
 */
export function agentExecutionBoundaryLabel(boundary: AgentExecutionBoundary): string {
  switch (boundary) {
    case "read-only":
      return "Read-only";
    case "workspace-sandbox":
      return "Workspace sandbox";
    case "trusted-host-access":
      return "Trusted host access";
  }
}
