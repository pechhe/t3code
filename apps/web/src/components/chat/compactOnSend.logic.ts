/**
 * The history the next send summarises first, or null when it sends as is. Only a plain
 * message send compacts: answering a question, acting on a plan, resuming or updating a
 * queued message never does, so the screen's flag and the send dial agree on every state.
 */
export function compactOnSendTokens(input: {
  readonly resumeCompactionTokens: number | null;
  readonly answeringQuestion: boolean;
  readonly showingPlanFollowUp: boolean;
  readonly showingResume: boolean;
  readonly editingQueuedMessage: boolean;
}): number | null {
  if (
    input.answeringQuestion ||
    input.showingPlanFollowUp ||
    input.showingResume ||
    input.editingQueuedMessage
  ) {
    return null;
  }
  return input.resumeCompactionTokens;
}
