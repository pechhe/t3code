import type { EnvironmentId } from "@t3tools/contracts";

import type { EnvironmentOption } from "../../BranchToolbar.logic";

/** The load-balancing weight a machine has when the user never set one ("Normal"). */
const DEFAULT_WEIGHT = 50;

/**
 * The two machines the device composer's lever offers: with more than two, this device and the remote with the
 * highest load-balancing weight, so a "Manual only" machine never displaces one the user codes on. The thread's
 * current machine always keeps a position. Null with fewer than two.
 */
export function leverEnvironments(
  candidates: readonly EnvironmentOption[],
  currentEnvironmentId: EnvironmentId | null | undefined,
  weights: Readonly<Record<string, number>>,
): readonly [EnvironmentOption, EnvironmentOption] | null {
  if (candidates.length < 2) return null;
  const weight = (option: EnvironmentOption) => weights[option.environmentId] ?? DEFAULT_WEIGHT;
  const current = candidates.find((option) => option.environmentId === currentEnvironmentId);
  const primary = candidates.find((option) => option.isPrimary);
  const byPreference = candidates.toSorted(
    (left, right) => weight(right) - weight(left) || left.label.localeCompare(right.label),
  );
  const anchor = primary ?? current ?? byPreference[0]!;
  const partner =
    current && current.environmentId !== anchor.environmentId
      ? current
      : byPreference.find((option) => option.environmentId !== anchor.environmentId)!;
  const pair = [anchor, partner].toSorted(
    (left, right) => Number(right.isPrimary) - Number(left.isPrimary),
  );
  return [pair[0]!, pair[1]!];
}
