import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { AgentPolicySettings, EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useContext } from "react";

import { formatEnvironmentQueryError } from "../../state/query";
import { serverEnvironment } from "../../state/server";

export interface AgentPolicyView {
  readonly environmentId: EnvironmentId;
  readonly canEdit: boolean;
  readonly data: AgentPolicySettings | null;
  readonly error: string | null;
  readonly isPending: boolean;
}

// Keyed by the ids so each render reads the same atom, as with the member project files.
const agentPoliciesAtom = Atom.family((idsKey: string) =>
  Atom.make((get) =>
    (JSON.parse(idsKey) as ReadonlyArray<EnvironmentId>).map((environmentId) => {
      const canEdit = get(serverEnvironment.agentPolicySave.permissionAtom(environmentId));
      // Reading needs the same owner grant as saving.
      const result = canEdit
        ? get(serverEnvironment.agentPolicyRead({ environmentId, input: {} }))
        : null;
      return { environmentId, canEdit, result };
    }),
  ).pipe(Atom.withLabel(`web-settings-agent-policies:${idsKey}`)),
);

/** Each environment's own policy, read in parallel; `reload` re-reads them all. */
export function useAgentPolicies(environmentIds: ReadonlyArray<EnvironmentId>) {
  const registry = useContext(RegistryContext);
  const entries = useAtomValue(agentPoliciesAtom(JSON.stringify(environmentIds)));
  const policies = entries.map(({ environmentId, canEdit, result }): AgentPolicyView => ({
    environmentId,
    canEdit,
    data: result === null ? null : Option.getOrNull(AsyncResult.value(result)),
    error: result?._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
    isPending: result?.waiting ?? false,
  }));
  const reload = () => {
    for (const environmentId of environmentIds) {
      registry.refresh(serverEnvironment.agentPolicyRead({ environmentId, input: {} }));
    }
  };
  return { policies, reload };
}
