import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import type * as EnvironmentRegistry from "../connection/registry.ts";
import type * as Persistence from "../platform/persistence.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** Model routing's runtime blocks on accounts (fork/differences.md `account-pools`). */
export function createAccountRoutingEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    EnvironmentRegistry.EnvironmentRegistry | Persistence.EnvironmentCacheStore | R,
    E
  >,
) {
  return {
    accountRouting: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:account-routing",
      tag: WS_METHODS.accountRoutingSubscribe,
    }),
    clearAccountBlock: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:account-routing:clear",
      tag: WS_METHODS.accountRoutingClear,
    }),
  };
}
