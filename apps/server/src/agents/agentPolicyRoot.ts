import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

// Read at use time, not through Config: a desktop started by launchd gets the login shell's
// value after the server's config provider has snapshotted the environment.
export const agentPolicyRoot: Effect.Effect<Option.Option<string>> = Effect.map(
  HostProcess.Environment,
  (environment) =>
    Option.fromNullishOr(environment.T3CODE_AGENT_POLICY_ROOT).pipe(
      Option.map((root) => root.trim()),
      Option.filter((root) => root.length > 0),
    ),
);
