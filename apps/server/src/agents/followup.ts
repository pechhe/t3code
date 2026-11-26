import { type AgentTaskBinding, isConsultingRole } from "@t3tools/contracts";

/** The message a follow-up adds to the agent's existing conversation. */
export const followupPrompt = (
  followup: { readonly sourceRevision?: string | undefined; readonly changes: string },
  task: string | undefined,
  /** Set when the follow-up moved the agent to a new checkout. */
  movedTo?: string,
) => {
  const header = `${movedTo === undefined ? "" : `Workspace moved to: ${movedTo} (previous checkout was cleaned up; read files from this path).\n`}${followup.sourceRevision === undefined ? "" : `Source revision: ${followup.sourceRevision}\n`}Changes since your previous task: ${followup.changes}`;
  // The changes alone often say what to do next, so a follow-up may carry no task text.
  return task === undefined || task.trim().length === 0 ? header : `${header}\n\n${task}`;
};

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
const pinsFollowupRevision = (binding: AgentTaskBinding) =>
  isConsultingRole(binding.role) || binding.sourceRevision !== undefined;

/** The binding a managed thread's runs are validated against, with any follow-up pin applied. */
export const pinnedBinding = (
  binding: AgentTaskBinding,
  followupSourceRevision: string | undefined,
) =>
  followupSourceRevision !== undefined && pinsFollowupRevision(binding)
    ? { ...binding, sourceRevision: followupSourceRevision }
    : binding;

/**
 * Whether a stated revision looks like an abbreviated commit id. A follow-up's revision is
 * stored as the thread's pin and compared exactly with full commit ids, so an abbreviation
 * could never match any checkout.
 */
export const isAbbreviatedRevision = (revision: string) =>
  /^[0-9a-f]+$/i.test(revision) && revision.length !== 40 && revision.length !== 64;
