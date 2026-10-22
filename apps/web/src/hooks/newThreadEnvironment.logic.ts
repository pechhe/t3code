import type { EnvironmentId } from "@t3tools/contracts";

/**
 * Which machine a new thread without a project starts on: the one the composer's switch
 * was last left on, so the switch keeps its position between threads. A machine that no
 * longer offers a scratch folder (disconnected, or the switch has never been moved) leaves
 * the choice to where the newest thread started, which is what T3 did before the switch
 * was remembered.
 */
export function resolveNewThreadEnvironmentId(input: {
  readonly remembered: EnvironmentId | null;
  readonly lastStarted: EnvironmentId | null;
  readonly scratchEnvironmentIds: readonly EnvironmentId[];
}): EnvironmentId | null {
  if (input.remembered !== null && input.scratchEnvironmentIds.includes(input.remembered)) {
    return input.remembered;
  }
  return input.lastStarted;
}
