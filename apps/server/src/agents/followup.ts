import type { AgentRole, AgentTaskBinding } from "@t3tools/contracts";

/**
 * Roles whose conversation a follow-up may continue. Reviewers and UI verifiers
 * judge independently, so each of their rounds starts fresh.
 */
export const continuableRoles: ReadonlySet<AgentRole> = new Set([
  "advisor",
  "chore-worker",
  "implementation-worker",
  "ui-worker",
  "browser",
]);

/** The message a follow-up adds to the agent's existing conversation. */
export const followupPrompt = (
  followup: { readonly sourceRevision: string; readonly changes: string },
  task: string,
) =>
  `Source revision: ${followup.sourceRevision}\nChanges since your previous task: ${followup.changes}\n\n${task}`;

/**
 * Whether a follow-up's stated revision replaces the task's pinned source when
 * its runs start. An advisor reads a stated revision, so it is always pinned; a
 * worker launched without a revision stays unpinned, since its revision moves
 * as it writes.
 */
export const pinsFollowupRevision = (binding: AgentTaskBinding) =>
  binding.role === "advisor" || binding.sourceRevision !== undefined;
