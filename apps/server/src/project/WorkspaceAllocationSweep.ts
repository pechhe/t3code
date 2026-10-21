import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as WorkspaceProvider from "./WorkspaceProvider.ts";

/**
 * Settles the SlipJay allocations a crash, restart or lost receipt left unfinished. A
 * checkout is kept when a thread is bound to it or holds it as an attachment, or when the
 * thread that asked for it has a failed launch it can retry (its latest run); otherwise it is released. A
 * restart cancels a launch still preparing, and nothing retries that.
 */
export const sweep = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const workspaces = yield* WorkspaceProvider.WorkspaceProvider;
  yield* workspaces.reconcile({
    retryable: (threadId) =>
      sql`
        SELECT 1 AS present FROM orchestration_v2_projection_threads AS threads
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM orchestration_v2_projection_runs AS runs
            WHERE runs.thread_id = threads.thread_id
              AND runs.ordinal = (
                SELECT MAX(latest.ordinal) FROM orchestration_v2_projection_runs AS latest
                WHERE latest.thread_id = threads.thread_id
              )
              AND runs.status = 'failed'
              AND json_extract(runs.payload_json, '$.workspacePreparation') IS NOT NULL
          )
        LIMIT 1
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        // Unknown means retryable: a checkout is never released on a failed read.
        Effect.catch((error) =>
          Effect.logWarning("Could not check whether a thread can retry its launch", {
            threadId,
            error: error.message,
          }).pipe(Effect.as(true)),
        ),
      ),
    isBound: (workspacePath) =>
      sql`
        SELECT 1 AS bound FROM orchestration_v2_projection_threads
        WHERE deleted_at IS NULL
          AND (
            json_extract(payload_json, '$.worktreePath') = ${workspacePath}
            OR EXISTS (
              SELECT 1 FROM json_each(payload_json, '$.workspaceAttachments')
              WHERE json_extract(value, '$.workspacePath') = ${workspacePath}
            )
          )
        LIMIT 1
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        // Unknown means bound: a checkout is never released on a failed read.
        Effect.catch((error) =>
          Effect.logWarning("Could not check whether a workspace is bound", {
            workspacePath,
            error: error.message,
          }).pipe(Effect.as(true)),
        ),
      ),
  });
});
