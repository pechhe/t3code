import type { AgentPolicyCompactionModel, ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ManagedAgent from "./ManagedAgentService.ts";

/**
 * The model the Compact chip names when no compaction model is set (fork/differences.md
 * `compact-model`): the chore worker's first text model, or none without managed agents.
 */
export const readCompactionModel = <E, R>(
  managedAgents: Option.Option<ManagedAgent.ManagedAgentService["Service"]>,
  getProviders: Effect.Effect<ReadonlyArray<ServerProvider>, E, R>,
): Effect.Effect<AgentPolicyCompactionModel, never, R> =>
  Option.match(managedAgents, {
    onNone: () => Effect.succeed({ selection: null }),
    onSome: (managedAgents) =>
      getProviders.pipe(
        Effect.flatMap((providers) => managedAgents.rankedTextModels({ providers })),
        Effect.map((models) => ({ selection: models[0] ?? null })),
        Effect.orElseSucceed(() => ({ selection: null })),
      ),
  });
