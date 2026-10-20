import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The outbox of Send backs a person made from the Build dropdown (Spec #4070), keyed by the finding
  // HQ recorded. A row stays until HQ has accepted the delivery report, so a restart or a failed
  // call picks up where it stopped and a note is never sent to its lead thread twice. Only the HQ
  // that recorded a finding (`hq_origin`) is told how its delivery went.
  yield* sql`CREATE TABLE build_send_back_deliveries (
    finding_id TEXT PRIMARY KEY,
    spec_label TEXT NOT NULL,
    note TEXT NOT NULL,
    lead_harness TEXT,
    lead_session_ref TEXT,
    state TEXT NOT NULL,
    detail TEXT,
    reported_at TEXT,
    created_at TEXT NOT NULL,
    hq_origin TEXT NOT NULL
  )`;
});
