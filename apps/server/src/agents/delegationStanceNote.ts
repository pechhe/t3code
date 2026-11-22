import { type DelegationStance } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ManagedAgent from "./ManagedAgentService.ts";

const notes: Record<DelegationStance, string> = {
  orchestrate:
    "Delegation stance: orchestrate. This thread owns the outcome, the decisions and the checking. Hand building to implementers wherever the design is settled and an available implementer's note suits the work, UI building included. Keep design work that is still open and the rounds with the user. When no available implementer suits a piece, build that piece yourself rather than give it to a model whose note says it is poor at it. A small fix you may make yourself.",
  implement:
    "Delegation stance: implement. Build everything yourself; read-only helpers (scout, browser, reviewer, advisor) are fine. T3 refuses to start an implementer for this thread.",
};

export const delegationStanceNote = (stance: DelegationStance, readOnly = false): string =>
  readOnly ? "" : notes[stance];

/**
 * The stance note a thread's turn starts with (fork/differences.md `agent-policy-roles`): none
 * without managed agents, and none for a read-only helper.
 */
export const threadStanceNote = (
  managedAgents: Option.Option<ManagedAgent.ManagedAgentService["Service"]>,
  input: Parameters<ManagedAgent.ManagedAgentService["Service"]["resolveStance"]>[0] & {
    readonly thread: { readonly agentTask?: { readonly sourceAccess?: string } | undefined };
  },
): Effect.Effect<string> =>
  Option.isNone(managedAgents)
    ? Effect.succeed("")
    : managedAgents.value.resolveStance(input).pipe(
        Effect.orDie,
        Effect.map((resolved) =>
          delegationStanceNote(
            resolved.stance,
            input.thread.agentTask?.sourceAccess === "read-only",
          ),
        ),
      );
