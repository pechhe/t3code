import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A Champion's confirmations and plain-sentence notes sit beside a revision without changing it.
  yield* sql`CREATE TABLE champion_learning_annotations (id TEXT PRIMARY KEY, champion_id TEXT NOT NULL REFERENCES champions(id), learning_id TEXT NOT NULL, revision_id TEXT NOT NULL REFERENCES champion_learning_revisions(id), kind TEXT NOT NULL, at TEXT NOT NULL, document_json TEXT NOT NULL)`;
  yield* sql`CREATE INDEX champion_learning_history ON champion_learning_revisions(champion_id, learning_id)`;
  yield* sql`CREATE INDEX champion_learning_annotation_revision ON champion_learning_annotations(revision_id, kind, at)`;
});
