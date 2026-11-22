import {
  DEFAULT_DELEGATION_STANCE,
  type DelegationStance,
  type DelegationStanceChoice,
  type ResolvedDelegationStance,
} from "@t3tools/contracts";

export interface DelegationStanceOption {
  readonly stance: DelegationStance;
  readonly label: string;
  readonly tooltip: string;
}

export const DELEGATION_STANCE_OPTIONS: readonly [DelegationStanceOption, DelegationStanceOption] =
  [
    {
      stance: "orchestrate",
      label: "Orchestrate",
      tooltip:
        "Plans, decides and checks. Hands the building to other agents wherever the design is settled.",
    },
    {
      stance: "implement",
      label: "Implement",
      tooltip:
        "Builds everything itself. Only read-only helpers can start, such as a scout or a reviewer.",
    },
  ];

export function getDelegationStanceOption(stance: DelegationStance): DelegationStanceOption {
  return (
    DELEGATION_STANCE_OPTIONS.find((option) => option.stance === stance) ??
    DELEGATION_STANCE_OPTIONS[1]
  );
}

/**
 * A draft thread follows its selected model's default stance until the owner
 * moves the lever by hand; once touched, model changes leave his choice alone.
 */
export function resolveDraftStance(input: {
  readonly manualChoice: DelegationStanceChoice | null | undefined;
  readonly modelResolved: ResolvedDelegationStance | null | undefined;
}): DelegationStance {
  if (input.manualChoice != null) {
    return input.manualChoice.stance;
  }
  return input.modelResolved?.stance ?? DEFAULT_DELEGATION_STANCE;
}

export function touchDraftStance(stance: DelegationStance): DelegationStanceChoice {
  return { stance, chosenBy: "owner" };
}

/**
 * An existing thread shows a pending owner pick immediately while `thread.stance.set`
 * is in flight, then falls back to the server's resolved stance once reconciled.
 */
export function resolveServerThreadStance(input: {
  readonly pending: { readonly threadKey: string; readonly stance: DelegationStance } | null;
  readonly threadKey: string;
  readonly serverResolved: ResolvedDelegationStance | null | undefined;
  readonly serverChoice: DelegationStanceChoice | null | undefined;
}): DelegationStance {
  if (input.pending !== null && input.pending.threadKey === input.threadKey) {
    return input.pending.stance;
  }
  return input.serverResolved?.stance ?? input.serverChoice?.stance ?? DEFAULT_DELEGATION_STANCE;
}

export function shouldClearPendingStance(input: {
  readonly pending: { readonly threadKey: string; readonly stance: DelegationStance } | null;
  readonly threadKey: string;
  readonly serverChoice: DelegationStanceChoice | null | undefined;
}): boolean {
  if (input.pending === null) return false;
  if (input.pending.threadKey !== input.threadKey) return true;
  return (
    input.serverChoice?.chosenBy === "owner" && input.serverChoice.stance === input.pending.stance
  );
}

export function stepDelegationStance(
  current: DelegationStance,
  direction: 1 | -1,
): DelegationStance {
  const index = DELEGATION_STANCE_OPTIONS.findIndex((option) => option.stance === current);
  const currentIndex = index >= 0 ? index : 1;
  const nextIndex =
    (currentIndex + direction + DELEGATION_STANCE_OPTIONS.length) %
    DELEGATION_STANCE_OPTIONS.length;
  return DELEGATION_STANCE_OPTIONS[nextIndex]!.stance;
}
