import {
  type OrchestrationV2Run,
  RunSetupRecord,
  type RunSetupComposedPrompt,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(RunSetupRecord));
export const encodeRecord = Schema.encodeSync(Schema.fromJsonString(RunSetupRecord));
const encodeRecordEffect = Schema.encodeEffect(Schema.fromJsonString(RunSetupRecord));

/** The record kept when capture failed outright: only what the run itself carries is known. */
export function uncapturedRunSetup(
  run: Pick<OrchestrationV2Run, "id" | "threadId" | "modelSelection"> &
    Partial<Pick<OrchestrationV2Run, "ordinal">>,
  capturedAt: string,
): RunSetupRecord {
  return {
    runId: run.id,
    threadId: run.threadId,
    ...(run.ordinal === undefined ? {} : { runOrdinal: run.ordinal }),
    capturedAt,
    composedPrompt: null,
    agentConfig: null,
    instructions: null,
    skills: null,
    policy: null,
    modelSelection: run.modelSelection,
    effectiveOptions: null,
    experimentAssignments: null,
  };
}

/** The stored setup records of the given runs, in no particular order. */
const listRunSetups = Effect.fn("RunSetupRecorder.listRunSetups")(function* (
  runIds: ReadonlyArray<string>,
) {
  if (runIds.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ record_json: string }>`SELECT record_json FROM run_setup_records
    WHERE run_id IN ${sql.in(runIds)}`;
  return yield* Effect.forEach(rows, (row) => decodeRecord(row.record_json));
});

/** Reads stored setup records; the MCP read tool depends on this alone. */
export class RunSetupStore extends Context.Service<
  RunSetupStore,
  {
    readonly list: (
      runIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<RunSetupRecord>, RunSetupStoreError>;
    readonly recordComposed: (
      run: OrchestrationV2Run,
      composed: RunSetupComposedPrompt,
    ) => Effect.Effect<void, RunSetupStoreError>;
  }
>()("t3/agents/RunSetupStore") {}

export class RunSetupStoreError extends Schema.TaggedError<RunSetupStoreError>()(
  "RunSetupStoreError",
  { cause: Schema.Defect() },
) {}

export const storeLayer = Layer.effect(
  RunSetupStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return RunSetupStore.of({
      recordComposed: Effect.fn("RunSetupStore.recordComposed")(
        function* (run, composed) {
          const fallback = {
            ...uncapturedRunSetup(run, DateTime.formatIso(yield* DateTime.now)),
            composedPrompt: composed,
          };
          const encoded = yield* encodeRecordEffect(fallback);
          yield* sql`INSERT INTO run_setup_records (run_id, thread_id, captured_at, record_json)
            VALUES (${run.id}, ${run.threadId}, ${fallback.capturedAt}, ${encoded})
            ON CONFLICT(run_id) DO UPDATE SET record_json = json_set(run_setup_records.record_json, '$.composedPrompt', json_extract(excluded.record_json, '$.composedPrompt'))
              WHERE json_extract(run_setup_records.record_json, '$.composedPrompt') IS NULL`;
        },
        Effect.mapError((cause) => new RunSetupStoreError({ cause })),
      ),
      list: Effect.fn("RunSetupStore.list")((runIds) =>
        listRunSetups(runIds).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.mapError((cause) => new RunSetupStoreError({ cause })),
        ),
      ),
    });
  }),
);
