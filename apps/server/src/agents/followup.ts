import { type AgentTaskBinding, isConsultingRole } from "@t3tools/contracts";

/** The message a follow-up adds to the agent's existing conversation. */
export const followupPrompt = (
  followup: { readonly sourceRevision?: string | undefined; readonly changes: string },
  task: string,
) =>
  `${followup.sourceRevision === undefined ? "" : `Source revision: ${followup.sourceRevision}\n`}Changes since your previous task: ${followup.changes}\n\n${task}`;

/**
 * The binding a follow-up is validated against. A pinned task, launched on a source
 * revision or given one by an earlier follow-up that its runs keep, needs a newly
 * stated one; an unpinned task may state one or not, as at launch. Undefined when a
 * pinned task states none. `priorRevision` is the thread's `followupSourceRevision`.
 */
export const followupBinding = (
  binding: AgentTaskBinding,
  followup: { readonly sourceRevision?: string | undefined },
  priorRevision: string | undefined,
) =>
  followup.sourceRevision !== undefined
    ? { ...binding, sourceRevision: followup.sourceRevision }
    : binding.sourceRevision === undefined &&
        (priorRevision === undefined || !pinsFollowupRevision(binding))
      ? binding
      : undefined;

/**
 * Whether a follow-up's stated revision replaces the task's pinned source when
 * its runs start. A consulting role reads a stated revision, so it is always
 * pinned; a worker launched without a revision stays unpinned, since its
 * revision moves as it writes.
 */
export const pinsFollowupRevision = (binding: AgentTaskBinding) =>
  isConsultingRole(binding.role) || binding.sourceRevision !== undefined;
