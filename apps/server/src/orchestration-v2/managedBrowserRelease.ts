import { CommandId, type RunId, type ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";

/** How long a finished managed task keeps its browser tabs for a follow-up to continue in. */
const MANAGED_TAB_FOLLOWUP_GRACE_MINUTES = 10;

/**
 * A managed task's browser tabs close when it ends (fork/differences.md `managed-browser-roles`):
 * at once if it was cancelled, else after a grace period in which a follow-up can pick them up.
 * The worker skips the release when a later run has started.
 */
export const managedBrowserReleaseEffects = (input: {
  readonly managedTask: boolean;
  readonly childThreadId: ThreadId;
  readonly childRunId: RunId;
  readonly terminalStatus: string;
  readonly now: DateTime.Utc;
}): ReadonlyArray<PendingOrchestrationEffectV2> =>
  !input.managedTask
    ? []
    : [
        {
          id: `effect:system:browser-sessions.release:${input.childRunId}`,
          commandId: CommandId.make(`command:system:browser-sessions.release:${input.childRunId}`),
          threadId: input.childThreadId,
          request: { type: "browser-sessions.release", sourceRunId: input.childRunId },
          availableAt:
            input.terminalStatus === "cancelled" || input.terminalStatus === "interrupted"
              ? input.now
              : DateTime.add(input.now, { minutes: MANAGED_TAB_FOLLOWUP_GRACE_MINUTES }),
        },
      ];
