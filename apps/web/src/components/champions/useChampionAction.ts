import { type ChampionAction, championFailureMessage } from "@t3tools/client-runtime/champions";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import { useState } from "react";

import { useEnvironmentPresentation } from "../../state/presentation";

export function useChampionMachineConnected(environmentId: EnvironmentId): boolean {
  return useEnvironmentPresentation(environmentId).presentation?.connection.phase === "connected";
}

/** A session's grant outlives its connection, so the permission alone can allow a doomed command. */
export function useChampionCommandAllowed(
  command: { readonly permissionAtom: (environmentId: EnvironmentId) => Atom.Atom<boolean> },
  environmentId: EnvironmentId,
): boolean {
  const granted = useAtomValue(command.permissionAtom(environmentId));
  return useChampionMachineConnected(environmentId) && granted;
}

export function useChampionAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (
    key: string,
    action: ChampionAction,
    steps: ReadonlyArray<() => Promise<AtomCommandResult<unknown, unknown>>>,
  ): Promise<boolean> => {
    if (busy !== null) return false;
    setBusy(key);
    setError(null);
    let succeeded = true;
    for (const step of steps) {
      const result = await step();
      if (result._tag === "Failure") {
        succeeded = false;
        if (!isAtomCommandInterrupted(result)) {
          setError(championFailureMessage(squashAtomCommandFailure(result), action));
        }
        break;
      }
    }
    setBusy(null);
    return succeeded;
  };

  return { busy, error, run, clearError: () => setError(null) };
}
