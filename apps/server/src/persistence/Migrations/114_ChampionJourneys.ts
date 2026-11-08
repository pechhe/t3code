import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE champion_journey_checks (
    check_id TEXT PRIMARY KEY,
    champion_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    document_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX champion_journey_checks_champion_idx ON champion_journey_checks(champion_id, started_at)`;
  // What a thread's browser may do: an owner thread by id, a replay by its workId. A row with no
  // allowance fails closed once a check's target is down.
  yield* sql`CREATE TABLE champion_journey_grants (
    grant_key TEXT PRIMARY KEY,
    check_id TEXT NOT NULL,
    allow_json TEXT NOT NULL,
    tab_limit INTEGER NOT NULL,
    decision_cap INTEGER NOT NULL,
    journey_limit INTEGER NOT NULL
  )`;
  yield* sql`CREATE TABLE champion_journeys (
    id TEXT PRIMARY KEY,
    check_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    document_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX champion_journeys_check_idx ON champion_journeys(check_id, started_at)`;
  yield* sql`CREATE TABLE champion_journey_network (
    check_id TEXT NOT NULL,
    destination TEXT NOT NULL,
    allowed INTEGER NOT NULL,
    requests INTEGER NOT NULL,
    PRIMARY KEY (check_id, destination, allowed)
  )`;
  // A candidate raises nothing: no finding, no open count and no activity until a replay confirms it.
  yield* sql`CREATE TABLE champion_journey_candidates (
    id TEXT PRIMARY KEY,
    champion_id TEXT NOT NULL,
    check_id TEXT NOT NULL,
    status TEXT NOT NULL,
    finding_id TEXT,
    created_at TEXT NOT NULL,
    document_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX champion_journey_candidates_check_idx ON champion_journey_candidates(check_id)`;
  yield* sql`CREATE INDEX champion_journey_candidates_finding_idx ON champion_journey_candidates(finding_id)`;
});
