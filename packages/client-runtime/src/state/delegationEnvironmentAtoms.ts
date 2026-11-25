import type { EnvironmentId } from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";
import type * as EnvironmentRegistry from "../connection/registry.ts";
import type * as Persistence from "../platform/persistence.ts";
import {
  type createAtomCommandScheduler,
  createEnvironmentGuardedRpcQueryAtomFamily,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** The delegation stance, agent policy and champion atoms of a server environment. */
export function createDelegationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    EnvironmentRegistry.EnvironmentRegistry | Persistence.EnvironmentCacheStore | R,
    E
  >,
  config: {
    readonly configScheduler: ReturnType<typeof createAtomCommandScheduler>;
    readonly configConcurrency: {
      readonly mode: "serial";
      readonly key: (input: { readonly environmentId: string }) => string;
    };
  },
) {
  const { configScheduler, configConcurrency } = config;
  const delegationStanceVersion = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make(0).pipe(Atom.keepAlive),
  );
  const delegationStanceResolve = createEnvironmentGuardedRpcQueryAtomFamily(runtime, {
    label: "environment-data:server:delegation-stance:resolve",
    tag: WS_METHODS.delegationStanceResolve,
    refreshTrigger: ({ environmentId }) => delegationStanceVersion(environmentId),
  });
  const invalidateDelegationStance = (
    { environmentId }: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() =>
      registry.update(delegationStanceVersion(environmentId), (value) => value + 1),
    );
  const championsLive = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "environment-data:champions:live",
    tag: WS_METHODS.championsSubscribe,
  });
  return {
    championsLive,
    championRuntimeState: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:champions:runtime-state",
      tag: WS_METHODS.championsRuntimeState,
      refreshTrigger: ({ environmentId }) => championsLive({ environmentId, input: {} }),
    }),
    championLearning: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:champions:learning",
      tag: WS_METHODS.championsLearningQuery,
    }),
    championLearningSearch: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:champions:learning-search",
      tag: WS_METHODS.championsLearningSearch,
      refreshTrigger: ({ environmentId }) => championsLive({ environmentId, input: {} }),
    }),
    championLearningRead: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:champions:learning-read",
      tag: WS_METHODS.championsLearningRead,
      refreshTrigger: ({ environmentId }) => championsLive({ environmentId, input: {} }),
    }),
    championDetail: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:champions:detail",
      tag: WS_METHODS.championsGet,
      refreshTrigger: ({ environmentId }) => championsLive({ environmentId, input: {} }),
    }),
    championHistory: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:champions:history",
      tag: WS_METHODS.championsHistory,
      refreshTrigger: ({ environmentId }) => championsLive({ environmentId, input: {} }),
    }),
    delegationStanceResolve,
    agentPolicyRead: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:agent-policy:read",
      tag: WS_METHODS.agentPolicyRead,
    }),
    agentPolicySave: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agent-policy:save",
      tag: WS_METHODS.agentPolicySave,
      scheduler: configScheduler,
      concurrency: configConcurrency,
      onSuccess: invalidateDelegationStance,
    }),
    upsertChampion: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:champions:Upsert",
      tag: WS_METHODS.championsUpsert,
    }),
    setChampionModels: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:champions:SetModels",
      tag: WS_METHODS.championsSetModels,
    }),
    setChampionLifecycle: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:champions:SetLifecycle",
      tag: WS_METHODS.championsSetLifecycle,
    }),
    setupChampion: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:champions:Setup",
      tag: WS_METHODS.championsSetup,
    }),
    runChampionCheck: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:champions:RunCheck",
      tag: WS_METHODS.championsRunCheck,
    }),
    changeChampionMetrics: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:champions:change-metrics",
      tag: WS_METHODS.championsChangeMetrics,
    }),
    cancelChampionSetup: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:champions:cancel-setup",
      tag: WS_METHODS.championsCancelSetup,
    }),
    startChampionMetricsLead: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:champions:start-metrics-lead",
      tag: WS_METHODS.championsStartMetricsLead,
    }),
    championFindingAction: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:champions:FindingAction",
      tag: WS_METHODS.championsFindingAction,
    }),
  };
}
