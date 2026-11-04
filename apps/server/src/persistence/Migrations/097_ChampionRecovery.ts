import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE UNIQUE INDEX champions_owner_thread ON champions(json_extract(document_json, '$.champion.ownerThreadId'))`;
  yield* sql`CREATE INDEX champions_setup_thread ON champions(json_extract(document_json, '$.champion.setupThreadId'))`;
  yield* sql`ALTER TABLE champion_repair_claims RENAME TO champion_repair_claims_v1`;
  yield* sql`CREATE TABLE champion_repair_claims (
    work_id TEXT NOT NULL, attempt_id TEXT NOT NULL, phase TEXT NOT NULL,
    client_request_id TEXT NOT NULL, role TEXT NOT NULL, state TEXT NOT NULL,
    updated_at TEXT NOT NULL, command_id TEXT, PRIMARY KEY(work_id, attempt_id, phase)
  )`;
  yield* sql`INSERT INTO champion_repair_claims SELECT work_id, attempt_id,
    CASE role WHEN 'advisor' THEN 'advice' WHEN 'lead' THEN 'lead' ELSE 'implementation' END,
    client_request_id, role, 'unknown', '1970-01-01T00:00:00.000Z', NULL FROM champion_repair_claims_v1`;
  yield* sql`ALTER TABLE champion_repair_claims ADD COLUMN latest_request_id TEXT`;
  yield* sql`ALTER TABLE champion_repair_claims ADD COLUMN latest_followup INTEGER NOT NULL DEFAULT 0`;
  yield* sql`UPDATE champion_repair_claims SET latest_request_id = client_request_id`;
  yield* sql`DROP TABLE champion_repair_claims_v1`;
  yield* sql`CREATE INDEX champion_claim_active ON champion_repair_claims(work_id,attempt_id) WHERE state IN ('reserved','unknown','accepted')`;
  yield* sql`CREATE INDEX champion_claim_recent ON champion_repair_claims(updated_at,work_id,attempt_id)`;
  yield* sql`CREATE TABLE champion_finding_archive (id TEXT PRIMARY KEY, champion_id TEXT NOT NULL REFERENCES champions(id), at TEXT NOT NULL, document_json TEXT NOT NULL)`;
  yield* sql`CREATE INDEX champion_finding_archive_history ON champion_finding_archive(champion_id,at DESC)`;
  yield* sql`CREATE TABLE champion_decision_deliveries (
    id TEXT PRIMARY KEY, champion_id TEXT NOT NULL REFERENCES champions(id),
    finding_id TEXT NOT NULL, answer TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0
  )`;
});
