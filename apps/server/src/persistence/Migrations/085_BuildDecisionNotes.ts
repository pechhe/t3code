import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A note a person sent back on a Proposed Decision (YS-277) names that Decision to the lead.
  yield* sql`ALTER TABLE build_send_back_deliveries ADD COLUMN decision_label TEXT`;
});
