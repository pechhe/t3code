import { type AgentRole, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ManagedAgent from "./ManagedAgentService.ts";

const formatRoleRecoveryNote = (roles: ReadonlyArray<AgentRole>): string => {
  const unique = [...new Set(roles)].toSorted();
  if (unique.length === 0) return "";
  return unique.length === 1
    ? `Role available again: ${unique[0]}. Call \`agent_roles\` before assuming it is still unavailable.`
    : `Roles available again: ${unique.join(", ")}. Call \`agent_roles\` before assuming they are still unavailable.`;
};

/**
 * The note a thread's turn starts with when a delegated role it saw unavailable can start again
 * (fork/differences.md `agent-policy-roles`), and the effect that clears it once the turn is
 * accepted. Empty for a thread that saw no blocked role.
 */
export const threadRoleRecoveryNote = (
  managedAgents: Option.Option<ManagedAgent.ManagedAgentService["Service"]>,
  input: { readonly threadId: ThreadId },
): Effect.Effect<{ readonly note: string; readonly delivered: Effect.Effect<void> }> =>
  Option.isNone(managedAgents)
    ? Effect.succeed({ note: "", delivered: Effect.void })
    : managedAgents.value.recoveredRoles(input.threadId).pipe(
        Effect.map((recovered) =>
          recovered.length === 0
            ? { note: "", delivered: Effect.void }
            : {
                note: formatRoleRecoveryNote(recovered),
                delivered: managedAgents.value.acknowledgeRecoveredRoles(input.threadId, recovered),
              },
        ),
        Effect.orElseSucceed(() => ({ note: "", delivered: Effect.void })),
      );
