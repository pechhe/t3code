import type { SecureRandom } from "effect/crypto/SecureRandom";
import type { Atom } from "effect/reactivity";
import { ORCHESTRATION_V2_WS_METHODS } from "@t3tools/contracts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createCommandPermissions } from "./commandPermissions.ts";
import { type createAtomCommandScheduler, createEnvironmentCommand } from "./runtime.ts";
import { setThreadStance } from "../operations/commands.ts";

export function createSetStanceCommand<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | SecureRandom | R, E>,
  scheduler: ReturnType<typeof createAtomCommandScheduler>,
  concurrency: {
    readonly mode: "serial";
    readonly key: (input: { environmentId: string; input: { threadId: string } }) => string;
  },
) {
  return {
    ...createEnvironmentCommand(runtime, {
      label: "environment-data:commands:thread:set-stance",
      execute: setThreadStance,
      scheduler,
      concurrency,
    }),
    permissionAtom: createCommandPermissions(runtime, ORCHESTRATION_V2_WS_METHODS.dispatchCommand)
      .permissionAtom,
  };
}
