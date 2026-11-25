import { PAST_DEFAULT_CHAMPION_INSTRUCTIONS } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Champions observe and score (T3-928): the repair pipeline's stored state goes. Open repairs are
 * released with an activity line and their findings stay open, so the server gives each a case.
 */
type Json = Record<string, unknown>;
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const parse = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const REPAIR_FINDING_KEYS = [
  "workId",
  "attemptId",
  "childThreadId",
  "specUrl",
  "delivery",
  "deliveredAt",
  "repairAttention",
  "diagnosis",
  "undiagnosed",
  "baselineValue",
  "baselineMetric",
];
const REPAIR_STATUSES = new Set(["working", "handed_back", "delivered", "inconclusive"]);

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE champion_case_backfill (
    champion_id TEXT NOT NULL REFERENCES champions(id), finding_id TEXT NOT NULL,
    PRIMARY KEY(champion_id, finding_id)
  )`;
  const rows = yield* sql<{ readonly id: string; readonly document_json: string }>`
    SELECT id, document_json FROM champions WHERE json_valid(document_json)`;
  for (const row of rows) {
    const doc = yield* parse(row.document_json).pipe(Effect.orElseSucceed(() => undefined));
    if (!isRecord(doc) || !isRecord(doc.champion)) continue;
    const champion = doc.champion;
    delete champion.repairsVia;
    delete champion.whenInTarget;
    if (isRecord(champion.charter)) {
      delete champion.charter.maxConcurrentRepairs;
      delete champion.charter.maxRepairsPerDay;
      // A past default is cleared, so the current default applies on read; custom text stays.
      if (
        typeof champion.charter.instructions === "string" &&
        PAST_DEFAULT_CHAMPION_INSTRUCTIONS.includes(champion.charter.instructions)
      )
        delete champion.charter.instructions;
    }
    if (Array.isArray(champion.attention))
      champion.attention = champion.attention.filter(
        (line) =>
          typeof line !== "string" ||
          !(
            line.startsWith("Repair:") ||
            line.startsWith("Investigation:") ||
            line === "A repair child failed; inspect its activity before retrying."
          ),
      );
    const at = DateTime.formatIso(yield* DateTime.now);
    const findings = Array.isArray(doc.findings) ? doc.findings : [];
    for (const finding of findings) {
      if (!isRecord(finding)) continue;
      const settled = finding.status === "verified" || finding.status === "dismissed";
      const repairing =
        !settled &&
        (REPAIR_STATUSES.has(String(finding.status)) ||
          (typeof finding.childThreadId === "string" && finding.childThreadId !== ""));
      if (repairing) {
        const id = `${at}:released:${String(finding.id)}`;
        yield* sql`INSERT INTO champion_activity (id, champion_id, document_json) VALUES (${id}, ${row.id}, ${json(
          {
            id,
            championId: row.id,
            at,
            kind: "repair-released",
            text: "Champions no longer repair in the background, so this finding's repair was released. The finding stays open and its case in the Inbox carries the work.",
            findingId: finding.id,
            threadId: typeof finding.childThreadId === "string" ? finding.childThreadId : null,
            revision: null,
            specUrl: null,
          },
        )}) ON CONFLICT(id) DO NOTHING`;
      }
      for (const key of REPAIR_FINDING_KEYS) delete finding[key];
      if (settled) continue;
      finding.status = "open";
      // The server opens these cases once, after this commit (ChampionService runDue).
      if (finding.escalationThreadId == null)
        yield* sql`INSERT INTO champion_case_backfill (champion_id, finding_id) VALUES (${row.id}, ${String(finding.id)}) ON CONFLICT DO NOTHING`;
    }
    yield* sql`UPDATE champions SET document_json = ${json(doc)} WHERE id = ${row.id}`;
  }
  // Readings and goal reviews each hold one outstanding claim on the same owner thread.
  yield* sql`DROP INDEX IF EXISTS champion_one_outstanding`;
  yield* sql`CREATE UNIQUE INDEX champion_one_outstanding ON champion_checks(champion_id, thread_id, json_extract(document_json, '$.kind')) WHERE status = 'pending'`;
  yield* sql`DROP TABLE IF EXISTS champion_cancel_intents`;
  yield* sql`DROP TABLE IF EXISTS champion_recommendations`;
  yield* sql`DROP TABLE IF EXISTS champion_branch_attempts`;
  yield* sql`DROP TABLE IF EXISTS champion_investigations`;
  yield* sql`DROP TABLE IF EXISTS champion_repair_claims`;
});
