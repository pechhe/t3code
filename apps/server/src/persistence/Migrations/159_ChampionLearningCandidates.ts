import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Learnings a goal review reported that belong to no finding (fork/differences.md `champions`). T3-side
 * only, so a hosted Champion's folder never carries them and a re-import cannot wipe them. `carried_by`
 * names the tidy-up finding whose case lists the candidate; null while it waits.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE champion_learning_candidates (
    id TEXT PRIMARY KEY,
    champion_id TEXT NOT NULL REFERENCES champions(id),
    at TEXT NOT NULL,
    statement TEXT NOT NULL,
    evidence TEXT NOT NULL,
    home TEXT NOT NULL,
    urgent INTEGER NOT NULL DEFAULT 0,
    carried_by TEXT
  )`;
  yield* sql`CREATE INDEX champion_learning_candidates_champion ON champion_learning_candidates(champion_id, at)`;
});
