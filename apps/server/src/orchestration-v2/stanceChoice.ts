import type { DelegationStanceChoice, DelegationStance } from "@t3tools/contracts";

/**
 * The stance a new thread starts with (fork/differences.md `agent-policy-roles`): the one the
 * command chose, else the stance its parent gave the task.
 */
export const commandStanceChoice = (command: {
  readonly stanceChoice?: DelegationStanceChoice | undefined;
  readonly agentTask?: { readonly stance?: DelegationStance | undefined } | undefined;
}): DelegationStanceChoice | undefined =>
  command.stanceChoice ??
  (command.agentTask?.stance === undefined
    ? undefined
    : { stance: command.agentTask.stance, chosenBy: "parent" });

/** {@link commandStanceChoice} as an optional field, absent when nobody chose a stance. */
export const commandStanceChoiceField = (
  command: Parameters<typeof commandStanceChoice>[0],
): { readonly stanceChoice?: DelegationStanceChoice } => {
  const stanceChoice = commandStanceChoice(command);
  return stanceChoice === undefined ? {} : { stanceChoice };
};
