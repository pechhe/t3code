/**
 * The fork's delegation reads for `ProjectionStore`: task lookup, pending blocking advice and the
 * managed children with a live follow-up. The store builds them once from its own `sql`.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import {
  OrchestrationV2RunJson as OrchestrationV2RunJsonSchema,
  OrchestrationV2SubagentJson as OrchestrationV2SubagentJsonSchema,
  type NodeId,
  type OrchestrationV2Subagent,
  type ThreadId,
} from "@t3tools/contracts";
import { readOnly } from "@t3tools/shared/nodeSqliteClient";

import type { ProjectionManagedChildContinuation } from "./ProjectionStore.ts";

type PayloadRow = { readonly payload_json: string };

const decodeRunPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2RunJsonSchema),
);
const decodeSubagentPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2SubagentJsonSchema),
);

/** A task has a result nobody has taken yet while its delivery is pending or claimed. */
export function hasUndeliveredDelegatedResult(
  subagents: ReadonlyArray<OrchestrationV2Subagent>,
): boolean {
  return subagents.some(
    (task) =>
      task.origin === "app_owned" &&
      task.status !== "idle" &&
      (task.completionDelivery?.state === "pending" ||
        task.completionDelivery?.state === "claimed"),
  );
}

export const makeDelegationReads = <ReadError, ShellError>(deps: {
  readonly sql: SqlClient.SqlClient;
  readonly controlReadError: (threadId: ThreadId) => (cause: unknown) => ReadError;
  readonly shellSnapshotReadError: (cause: unknown) => ShellError;
}) => {
  const { sql, controlReadError, shellSnapshotReadError } = deps;
  const getSubagent = Effect.fn("ProjectionStore.getSubagent")(
    function* (taskId: NodeId) {
      const rows = yield* sql<PayloadRow>`
      SELECT payload_json FROM orchestration_v2_projection_subagents
      WHERE subagent_id = ${taskId}
    `;
      return rows[0] === undefined ? undefined : yield* decodeSubagentPayload(rows[0].payload_json);
    },
    (effect) => effect.pipe(readOnly, Effect.mapError(shellSnapshotReadError)),
  );

  // The latest delivered result per child is the identity boundary; ordinals include queued followups without clock comparisons.
  const getManagedChildContinuations = Effect.fn("ProjectionStore.getManagedChildContinuations")(
    function* (parentThreadId: ThreadId) {
      const rows = yield* sql<{
        readonly task_payload_json: string;
        readonly result_run_payload_json: string;
        readonly run_payload_json: string;
      }>`WITH terminal_results AS (
            SELECT
              task.child_thread_id,
              task.subagent_id,
              task.payload_json AS task_payload_json,
              result_run.payload_json AS result_run_payload_json,
              result_run.ordinal AS result_ordinal,
              ROW_NUMBER() OVER (
                PARTITION BY task.child_thread_id
                ORDER BY result_run.ordinal DESC, task.subagent_id DESC
              ) AS result_rank
            FROM orchestration_v2_projection_subagents AS task
            JOIN orchestration_v2_projection_runs AS result_run
              ON result_run.run_id = (
                SELECT candidate.run_id
                FROM orchestration_v2_projection_runs AS candidate
                WHERE candidate.thread_id = task.child_thread_id
                  AND json_extract(candidate.payload_json, '$.delegatedTaskId') = task.subagent_id
                  AND candidate.status IN ('completed', 'failed', 'cancelled', 'interrupted', 'rolled_back')
                ORDER BY candidate.ordinal DESC, candidate.run_id DESC
                LIMIT 1
              )
            WHERE task.thread_id = ${parentThreadId}
              AND task.origin = 'app_owned'
              AND task.child_thread_id IS NOT NULL
              AND json_extract(task.payload_json, '$.result') IS NOT NULL
              AND task.status IN ('completed', 'failed', 'cancelled', 'interrupted')
              AND task.completion_delivery_state IN ('acknowledged', 'delivered')
          )
          SELECT terminal.task_payload_json,
            terminal.result_run_payload_json,
            live_run.payload_json AS run_payload_json
          FROM terminal_results AS terminal
          JOIN orchestration_v2_projection_runs AS live_run
            ON live_run.thread_id = terminal.child_thread_id
            AND live_run.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
            AND live_run.ordinal > terminal.result_ordinal
          WHERE terminal.result_rank = 1
          ORDER BY terminal.subagent_id ASC, live_run.ordinal ASC, live_run.run_id ASC`;
      return yield* Effect.forEach(rows, (row) =>
        Effect.gen(function* () {
          const [task, resultRun, run] = yield* Effect.all([
            decodeSubagentPayload(row.task_payload_json),
            decodeRunPayload(row.result_run_payload_json),
            decodeRunPayload(row.run_payload_json),
          ]);
          return { task, resultRun, run } satisfies ProjectionManagedChildContinuation;
        }),
      );
    },
    (effect, parentThreadId) => effect.pipe(Effect.mapError(controlReadError(parentThreadId))),
  );

  const hasPendingBlockingAdvice = Effect.fn("ProjectionStore.hasPendingBlockingAdvice")(
    function* (threadId: ThreadId) {
      const rows =
        yield* sql`SELECT 1 FROM advice_consultations WHERE worker_thread_id = ${threadId} AND worker_environment_id IS NULL AND (status = 'pending' OR (status = 'answered' AND answer_delivered = 0)) AND json_extract(payload_json, '$.blocking') = 1 LIMIT 1`;
      return rows.length > 0;
    },
    (effect, threadId) => effect.pipe(Effect.mapError(controlReadError(threadId))),
  );

  const getSubagentByChildThread = Effect.fn("ProjectionStore.getSubagentByChildThread")(
    function* (childThreadId: ThreadId) {
      const rows = yield* sql<PayloadRow>`
        SELECT payload_json FROM orchestration_v2_projection_subagents
        WHERE child_thread_id = ${childThreadId}
        LIMIT 1
      `;
      return rows[0] === undefined ? undefined : yield* decodeSubagentPayload(rows[0].payload_json);
    },
    (effect, childThreadId: ThreadId) =>
      effect.pipe(readOnly, Effect.mapError(controlReadError(childThreadId))),
  );

  const getSubagentsByChildThread = Effect.fn("ProjectionStore.getSubagentsByChildThread")(
    function* (childThreadId: ThreadId) {
      const rows = yield* sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_subagents
          WHERE child_thread_id = ${childThreadId}
        `;
      return yield* Effect.forEach(rows, (row) => decodeSubagentPayload(row.payload_json));
    },
    (effect, childThreadId: ThreadId) =>
      effect.pipe(readOnly, Effect.mapError(controlReadError(childThreadId))),
  );

  return {
    getSubagent,
    getSubagentByChildThread,
    getSubagentsByChildThread,
    getManagedChildContinuations,
    hasPendingBlockingAdvice,
  };
};
