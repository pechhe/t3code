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
  followup: { readonly sourceRevision?: string | undefined; readonly changes: string },
  task: string,
) =>
  `${followup.sourceRevision === undefined ? "" : `Source revision: ${followup.sourceRevision}\n`}Changes since your previous task: ${followup.changes}\n\n${task}`;

/**
 * The binding a follow-up is validated against. A task launched with a source
 * revision needs a newly stated one; a task launched without one, as outside a
 * repository, stays without one. Undefined when a pinned task states none.
 */
export const followupBinding = (
  binding: AgentTaskBinding,
  followup: { readonly sourceRevision?: string | undefined },
) =>
  followup.sourceRevision !== undefined
    ? { ...binding, sourceRevision: followup.sourceRevision }
    : binding.sourceRevision === undefined
      ? binding
      : undefined;

/**
 * Whether a follow-up's stated revision replaces the task's pinned source when
 * its runs start. An advisor reads a stated revision, so it is always pinned; a
 * worker launched without a revision stays unpinned, since its revision moves
 * as it writes.
 */
export const pinsFollowupRevision = (binding: AgentTaskBinding) =>
  binding.role === "advisor" || binding.sourceRevision !== undefined;
