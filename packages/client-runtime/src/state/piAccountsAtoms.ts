import type { EnvironmentId } from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";
import type * as EnvironmentRegistry from "../connection/registry.ts";
import type * as Persistence from "../platform/persistence.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** Settings → Accounts' Pi credentials (fork/differences.md `pi-accounts`). */
export function createPiAccountsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    EnvironmentRegistry.EnvironmentRegistry | Persistence.EnvironmentCacheStore | R,
    E
  >,
) {
  const version = Atom.family((_environmentId: EnvironmentId) => Atom.make(0).pipe(Atom.keepAlive));
  const invalidate = (
    { environmentId }: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) => Effect.sync(() => registry.update(version(environmentId), (value) => value + 1));
  const command = <T extends Parameters<typeof createEnvironmentRpcCommand>[1]["tag"]>(
    label: string,
    tag: T,
  ) => createEnvironmentRpcCommand(runtime, { label, tag, onSuccess: invalidate });
  return {
    piAccounts: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:pi-accounts:list",
      tag: WS_METHODS.piAccountsList,
      refreshTrigger: ({ environmentId }) => version(environmentId),
    }),
    savePiAccountKey: command(
      "environment-data:pi-accounts:save-key",
      WS_METHODS.piAccountsSaveKey,
    ),
    removePiAccount: command("environment-data:pi-accounts:remove", WS_METHODS.piAccountsRemove),
    separatePiAccounts: command(
      "environment-data:pi-accounts:separate",
      WS_METHODS.piAccountsSeparate,
    ),
    startPiAccountLogin: command(
      "environment-data:pi-accounts:login-start",
      WS_METHODS.piAccountsLoginStart,
    ),
    respondPiAccountLogin: command(
      "environment-data:pi-accounts:login-respond",
      WS_METHODS.piAccountsLoginRespond,
    ),
    cancelPiAccountLogin: command(
      "environment-data:pi-accounts:login-cancel",
      WS_METHODS.piAccountsLoginCancel,
    ),
    piAccountLogin: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:pi-accounts:login",
      tag: WS_METHODS.piAccountsLoginSubscribe,
      completeWhen: (state) =>
        state.phase === "succeeded" || state.phase === "failed" || state.phase === "cancelled",
    }),
    invalidatePiAccounts: invalidate,
  };
}
