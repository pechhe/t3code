import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as AgentPolicy from "../src/agents/AgentPolicyService.ts";

const encodeResult = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      hash: Schema.String,
      revision: Schema.String,
      roles: Schema.Array(Schema.String),
    }),
  ),
);
// Offline validation only: no provider, auth, database or experiment is started.
await Effect.runPromise(
  Effect.gen(function* () {
    const sourceRoot = process.argv[2];
    if (!sourceRoot) {
      yield* Console.error(
        "Usage: node apps/server/scripts/validate-agent-policy.ts <agent-config-root>",
      );
      process.exitCode = 1;
      return;
    }
    const policy = yield* AgentPolicy.AgentPolicyService;
    const snapshot = yield* policy.snapshot(sourceRoot);
    yield* Console.log(
      encodeResult({
        hash: snapshot.hash,
        revision: snapshot.sourceRevision,
        roles: Object.keys(snapshot.briefs),
      }),
    );
  }).pipe(
    Effect.provide(AgentPolicy.layer.pipe(Layer.provide(NodeServices.layer))),
    Effect.catch((error) =>
      Effect.gen(function* () {
        yield* Console.error(error.message);
        process.exitCode = 1;
      }),
    ),
  ),
);
