import type { AccountId } from "@t3tools/contracts";
import * as Equal from "effect/Equal";

import type { ScopedSettingsTarget } from "./scopedSettings";

/** Whether the scoped environments disagree on one account's reserve. */
export function accountReserveIsMixed(
  targets: readonly ScopedSettingsTarget[],
  account: AccountId,
): boolean {
  const first = targets[0]?.settings.accountReserves?.[account];
  return (
    targets.length > 1 &&
    targets.some((target) => !Equal.equals(target.settings.accountReserves?.[account], first))
  );
}
