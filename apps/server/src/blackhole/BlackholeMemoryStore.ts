import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import type { StoredMemoryRecord } from "./BlackholeSession.ts";

// Ledger data is plain JSON built by Blackhole's own record builders.
const encodeData = (data: unknown): string => JSON.stringify(data) ?? "null";

interface Row {
  readonly seq: number;
  readonly anchor_item_id: string;
  readonly custom_type: string;
  readonly data_json: string;
  readonly created_at: string;
}

/** Blackhole's ledger records per thread (migration 156). */
export class BlackholeMemoryStore extends Context.Service<
  BlackholeMemoryStore,
  {
    readonly list: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<StoredMemoryRecord>>;
    readonly append: (input: {
      readonly threadId: ThreadId;
      readonly anchorItemId: string;
      readonly records: ReadonlyArray<{ readonly customType: string; readonly data: unknown }>;
      readonly createdAt: string;
    }) => Effect.Effect<void>;
  }
>()("t3/blackhole/BlackholeMemoryStore") {}

export const layer = Layer.effect(
  BlackholeMemoryStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return BlackholeMemoryStore.of({
      list: Effect.fn("BlackholeMemoryStore.list")(
        function* (threadId) {
          const rows = yield* sql<Row>`
            SELECT seq, anchor_item_id, custom_type, data_json, created_at
            FROM blackhole_memory_records WHERE thread_id = ${threadId} ORDER BY seq ASC
          `;
          return rows.flatMap((row): StoredMemoryRecord[] => {
            try {
              return [
                {
                  seq: row.seq,
                  anchorItemId: row.anchor_item_id,
                  customType: row.custom_type,
                  data: JSON.parse(row.data_json),
                  createdAt: row.created_at,
                },
              ];
            } catch {
              return [];
            }
          });
        },
        // Memory is advisory: a thread whose records cannot be read compacts without them.
        Effect.catch((cause) =>
          Effect.logWarning("blackhole memory unreadable", { cause }).pipe(Effect.as([])),
        ),
      ),
      append: Effect.fn("BlackholeMemoryStore.append")(
        function* (input) {
          if (input.records.length === 0) return;
          yield* sql.withTransaction(
            Effect.gen(function* () {
              const [last] = yield* sql<{ readonly seq: number | null }>`
                SELECT MAX(seq) AS seq FROM blackhole_memory_records
                WHERE thread_id = ${input.threadId}
              `;
              let seq = last?.seq ?? 0;
              for (const record of input.records) {
                seq += 1;
                yield* sql`
                  INSERT INTO blackhole_memory_records
                    (thread_id, seq, anchor_item_id, custom_type, data_json, created_at)
                  VALUES (${input.threadId}, ${seq}, ${input.anchorItemId}, ${record.customType},
                    ${encodeData(record.data)}, ${input.createdAt})
                `;
              }
            }),
          );
        },
        Effect.catch((cause) => Effect.logWarning("blackhole memory not saved", { cause })),
      ),
    });
  }),
);
