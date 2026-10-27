import { AgentPolicySnapshot } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class AgentPolicyStoreError extends Schema.TaggedError<AgentPolicyStoreError>()(
  "AgentPolicyStoreError",
  {
    reason: Schema.Literals(["read", "write", "missing"]),
    /** The policy hash whose snapshot was asked for. */
    hash: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "missing"
      ? `Agent policy snapshot unavailable (missing): no stored snapshot for policy hash ${this.hash ?? "unknown"}.`
      : `Agent policy snapshot unavailable (${this.reason}).`;
  }
}
export class AgentPolicyStore extends Context.Service<
  AgentPolicyStore,
  {
    readonly save: (snapshot: AgentPolicySnapshot) => Effect.Effect<void, AgentPolicyStoreError>;
    readonly get: (hash: string) => Effect.Effect<AgentPolicySnapshot, AgentPolicyStoreError>;
  }
>()("t3/agents/AgentPolicyStore") {}

const json = Schema.fromJsonString(AgentPolicySnapshot);
const encode = Schema.encodeSync(json);
const decode = Schema.decodeUnknownEffect(json);
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return AgentPolicyStore.of({
    save: (snapshot) =>
      sql`INSERT INTO agent_policy_snapshots (hash, payload_json)
      VALUES (${snapshot.hash}, ${encode(snapshot)}) ON CONFLICT(hash) DO NOTHING`.pipe(
        Effect.asVoid,
        Effect.mapError((cause) => new AgentPolicyStoreError({ reason: "write", cause })),
      ),
    get: Effect.fn("AgentPolicyStore.get")(function* (hash) {
      const rows = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM agent_policy_snapshots WHERE hash = ${hash}`.pipe(
        Effect.mapError((cause) => new AgentPolicyStoreError({ reason: "read", hash, cause })),
      );
      if (rows[0] === undefined)
        return yield* new AgentPolicyStoreError({ reason: "missing", hash });
      return yield* decode(rows[0].payload_json).pipe(
        Effect.mapError((cause) => new AgentPolicyStoreError({ reason: "read", hash, cause })),
      );
    }),
  });
});
export const layer = Layer.effect(AgentPolicyStore, make);
