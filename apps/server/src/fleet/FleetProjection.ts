import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class FleetProjectionError extends Schema.TaggedError<FleetProjectionError>()(
  "FleetProjectionError",
  {
    operation: Schema.Literals(["messages", "requests", "releases"]),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Fleet projection ${this.operation} could not be read.`;
  }
}
export class FleetProjection extends Context.Service<
  FleetProjection,
  {
    /** Bounded to `threadIds` so each query walks the `(thread_id, …)` indexes, not history. */
    readonly messageCounts: (
      now: number,
      threadIds: ReadonlyArray<ThreadId>,
    ) => Effect.Effect<
      ReadonlyArray<{
        readonly threadId: ThreadId;
        readonly senderThreadId: ThreadId;
        readonly count: number;
      }>,
      FleetProjectionError
    >;
    readonly pendingRequests: (
      threadIds: ReadonlyArray<ThreadId>,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly threadId: ThreadId; readonly count: number }>,
      FleetProjectionError
    >;
    readonly releases: Effect.Effect<
      ReadonlyArray<{
        readonly approvalId: string;
        readonly repository: string;
        readonly candidate: string;
        readonly candidateStatus: string | null;
        readonly candidateObservedAt: string;
      }>,
      FleetProjectionError
    >;
  }
>()("t3/fleet/FleetProjection") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return FleetProjection.of({
    messageCounts: (now, threadIds) =>
      threadIds.length === 0
        ? Effect.succeed([])
        : sql<{ threadId: ThreadId; senderThreadId: ThreadId; count: number }>`
      SELECT thread_id AS "threadId", json_extract(payload_json, '$.senderThreadId') AS "senderThreadId", COUNT(*) AS count
      FROM orchestration_v2_projection_messages
      WHERE thread_id IN ${sql.in(threadIds)}
        AND created_at > ${DateTime.formatIso(DateTime.makeUnsafe(now - 3_600_000))} AND created_at <= ${DateTime.formatIso(DateTime.makeUnsafe(now))}
        AND role = 'user'
        AND json_type(payload_json, '$.senderThreadId') = 'text'
        AND json_extract(payload_json, '$.senderThreadId') <> thread_id
        AND json_extract(payload_json, '$.senderThreadId') <> ''
        AND json_extract(payload_json, '$.scheduledTaskId') IS NULL
      GROUP BY thread_id, json_extract(payload_json, '$.senderThreadId')
      ORDER BY thread_id, "senderThreadId"
    `.pipe(Effect.mapError((cause) => new FleetProjectionError({ operation: "messages", cause }))),
    pendingRequests: (threadIds) =>
      threadIds.length === 0
        ? Effect.succeed([])
        : sql<{ threadId: ThreadId; count: number }>`
      SELECT thread_id AS "threadId", COUNT(*) AS count FROM (
        SELECT thread_id FROM orchestration_v2_projection_runtime_requests
        WHERE thread_id IN ${sql.in(threadIds)} AND status = 'pending'
        UNION ALL
        SELECT thread_id FROM orchestration_v2_projection_turn_items
        WHERE thread_id IN ${sql.in(threadIds)}
          AND type IN ('secret_request', 'release_approval_request') AND status = 'waiting'
      ) GROUP BY thread_id
    `.pipe(Effect.mapError((cause) => new FleetProjectionError({ operation: "requests", cause }))),
    releases: sql<{
      approvalId: string;
      repository: string;
      candidate: string;
      candidateStatus: string | null;
      candidateObservedAt: string;
    }>`
      SELECT approval_id AS "approvalId", repository, candidate,
        json_extract(summary_json, '$.verification.status') AS "candidateStatus", updated_at AS "candidateObservedAt"
      FROM release_approvals WHERE status = 'pending' ORDER BY repository, approval_id
    `.pipe(Effect.mapError((cause) => new FleetProjectionError({ operation: "releases", cause }))),
  });
});
export const layer = Layer.effect(FleetProjection, make);
