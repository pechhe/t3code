import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { type PersistenceSqlError, toPersistenceSqlError } from "./Errors.ts";

export interface WorkspaceAllocationIntent {
  /** The id SlipJay records the start under, so `slipjay attempt show` can settle it. */
  readonly attemptId: string;
  readonly projectRoot: string;
  /** Who asked for the checkout, for the log and for a human reading an unsettled row. */
  readonly ownerKind: string;
  readonly ownerRef: string;
  readonly createdAt: string;
  /** Why SlipJay would not release the checkout yet; null while nothing has gone wrong. */
  readonly detail: string | null;
}

/**
 * A SlipJay workspace start T3 asked for and has not yet bound to a thread or given back. A
 * row is written before the start, so a crash, timeout or lost receipt leaves a record that
 * a later sweep can settle against SlipJay's own attempt record instead of orphaning a checkout.
 */
export class WorkspaceAllocationIntents extends Context.Service<
  WorkspaceAllocationIntents,
  {
    readonly record: (
      intent: Omit<WorkspaceAllocationIntent, "detail">,
    ) => Effect.Effect<void, PersistenceSqlError>;
    readonly list: Effect.Effect<ReadonlyArray<WorkspaceAllocationIntent>, PersistenceSqlError>;
    readonly annotate: (
      attemptId: string,
      detail: string,
    ) => Effect.Effect<void, PersistenceSqlError>;
    readonly forget: (attemptId: string) => Effect.Effect<void, PersistenceSqlError>;
  }
>()("t3/persistence/WorkspaceAllocationIntents") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return WorkspaceAllocationIntents.of({
    record: Effect.fn("WorkspaceAllocationIntents.record")(function* (intent) {
      yield* sql`
        INSERT INTO workspace_allocation_intents
          (attempt_id, project_root, owner_kind, owner_ref, created_at)
        VALUES (${intent.attemptId}, ${intent.projectRoot}, ${intent.ownerKind},
          ${intent.ownerRef}, ${intent.createdAt})
      `.pipe(Effect.mapError(toPersistenceSqlError("recordWorkspaceAllocationIntent")));
    }),
    list: sql<{
      readonly attempt_id: string;
      readonly project_root: string;
      readonly owner_kind: string;
      readonly owner_ref: string;
      readonly created_at: string;
      readonly detail: string | null;
    }>`
      SELECT attempt_id, project_root, owner_kind, owner_ref, created_at, detail
      FROM workspace_allocation_intents
      ORDER BY created_at
    `.pipe(
      Effect.map((rows) =>
        rows.map((row): WorkspaceAllocationIntent => ({
          attemptId: row.attempt_id,
          projectRoot: row.project_root,
          ownerKind: row.owner_kind,
          ownerRef: row.owner_ref,
          createdAt: row.created_at,
          detail: row.detail,
        })),
      ),
      Effect.mapError(toPersistenceSqlError("listWorkspaceAllocationIntents")),
    ),
    annotate: Effect.fn("WorkspaceAllocationIntents.annotate")(function* (attemptId, detail) {
      yield* sql`
        UPDATE workspace_allocation_intents SET detail = ${detail} WHERE attempt_id = ${attemptId}
      `.pipe(Effect.mapError(toPersistenceSqlError("annotateWorkspaceAllocationIntent")));
    }),
    forget: Effect.fn("WorkspaceAllocationIntents.forget")(function* (attemptId) {
      yield* sql`
        DELETE FROM workspace_allocation_intents WHERE attempt_id = ${attemptId}
      `.pipe(Effect.mapError(toPersistenceSqlError("forgetWorkspaceAllocationIntent")));
    }),
  });
});

export const layer = Layer.effect(WorkspaceAllocationIntents, make);
