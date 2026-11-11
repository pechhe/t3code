import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Read by name (INDEXED BY) in LandingWatchReactor.ts; without it the lookup scans every turn item.
// CASE fixes the evaluation order, so a malformed payload is skipped rather than failing its write.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_turn_items_slipjay_land_idx
    ON orchestration_v2_projection_turn_items(updated_at)
    WHERE type = 'command_execution'
      AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.input') END
        LIKE '%slipjay%land%'
  `;
});
