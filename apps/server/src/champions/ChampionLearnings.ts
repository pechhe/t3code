import {
  ChampionError,
  ChampionLearningConfirmation,
  ChampionLearningRevision,
  type ChampionLearningConfirmInput,
  type ChampionLearningEntry,
  type ChampionLearningNoteInput,
  type ChampionLearningReadInput,
  type ChampionLearningReadResult,
  type ChampionLearningSearchInput,
  type ChampionLearningSearchResult,
  type ChampionLearningTopicsResult,
  type ProjectId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Reading a Champion's learnings for people and other agents. Nothing here writes a retrieval
 * receipt or takes the evidence lock, so a search never waits behind investigation work; only
 * `ChampionEvidence.learningQuery` produces receipts that investigation admission accepts.
 */

const SCAN_LIMIT = 2_000;
const PAGE_BYTES = 60_000;
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeRevision = Schema.decodeUnknownEffect(Schema.fromJsonString(ChampionLearningRevision));
const decodeConfirmation = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ChampionLearningConfirmation),
);
const decodePlain = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ plainSummary: Schema.String })),
);
const isChampionError = Schema.is(ChampionError);
const failure = (cause: unknown) =>
  isChampionError(cause) ? cause : new ChampionError({ reason: "unavailable", cause });

interface Row {
  readonly document_json: string;
  readonly champion_name: string;
  readonly earlier: number;
  readonly plain_json: string | null;
  readonly confirmation_json: string | null;
}

/** Lower-cased words of two or more characters, at most twelve of them. */
export const searchTerms = (query: string | undefined) =>
  [
    ...new Set(
      (query ?? "")
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((term) => term.length >= 2),
    ),
  ].slice(0, 12);

/** Distinct terms matched first, then where they matched: the plain sentence weighs most. */
export const relevance = (entry: ChampionLearningEntry, terms: ReadonlyArray<string>) => {
  const fields: ReadonlyArray<readonly [string, number]> = [
    [(entry.plainSummary ?? "").toLowerCase(), 4],
    [entry.revision.conclusion.toLowerCase(), 3],
    [entry.revision.question.toLowerCase(), 2],
    [entry.revision.topic.toLowerCase(), 1],
  ];
  let matched = 0;
  let weight = 0;
  for (const term of terms) {
    const hits = fields.filter(([text]) => text.includes(term));
    if (hits.length > 0) matched += 1;
    for (const [, fieldWeight] of hits) weight += fieldWeight;
  }
  return { matched, weight };
};

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const random = yield* SecureRandom.SecureRandom;
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const entry = Effect.fn("ChampionLearnings.entry")(function* (row: Row, at: string) {
    const revision = yield* decodeRevision(row.document_json);
    const due = revision.reviewAt !== null && revision.reviewAt <= at;
    const plain =
      revision.plainSummary ??
      (row.plain_json === null ? null : (yield* decodePlain(row.plain_json)).plainSummary);
    return {
      revision: { ...revision, isCurrent: true, applicabilityState: due ? "uncertain" : "current" },
      championName: row.champion_name,
      plainSummary: plain,
      confirmation:
        row.confirmation_json === null ? null : yield* decodeConfirmation(row.confirmation_json),
      due,
      earlierRevisions: row.earlier,
    } satisfies ChampionLearningEntry;
  });

  const currentRows = (filter: {
    readonly championId?: string | undefined;
    readonly projectId?: ProjectId | undefined;
    readonly learningId?: string | undefined;
  }) =>
    sql<Row>`SELECT r.document_json, json_extract(c.document_json, '$.champion.name') AS champion_name,
      (SELECT COUNT(*) FROM champion_learning_revisions e WHERE e.champion_id = r.champion_id AND e.learning_id = r.learning_id) - 1 AS earlier,
      (SELECT a.document_json FROM champion_learning_annotations a WHERE a.revision_id = r.id AND a.kind = 'plain' ORDER BY a.at DESC, a.id DESC LIMIT 1) AS plain_json,
      (SELECT a.document_json FROM champion_learning_annotations a WHERE a.revision_id = r.id AND a.kind = 'confirmation' ORDER BY a.at DESC, a.id DESC LIMIT 1) AS confirmation_json
      FROM champion_learning_heads h
      JOIN champion_learning_revisions r ON r.id = h.revision_id
      JOIN champions c ON c.id = h.champion_id
      WHERE (${filter.championId ?? null} IS NULL OR h.champion_id = ${filter.championId ?? null})
        AND (${filter.learningId ?? null} IS NULL OR h.learning_id = ${filter.learningId ?? null})
        AND (${filter.projectId ?? null} IS NULL OR json_extract(r.document_json, '$.projectId') = ${filter.projectId ?? null})
      ORDER BY r.at DESC, r.id DESC LIMIT ${SCAN_LIMIT}`;

  const search = Effect.fn("ChampionLearnings.search")(function* (
    input: ChampionLearningSearchInput,
  ) {
    const at = yield* now;
    const rows = yield* currentRows(input);
    const entries = yield* Effect.forEach(rows, (row) => entry(row, at));
    const filter = input.filter ?? "all";
    const terms = searchTerms(input.query);
    const kept = entries.filter((candidate) =>
      filter === "due"
        ? candidate.due
        : filter === "contributed"
          ? candidate.revision.contribution !== undefined
          : filter === "needs-review"
            ? candidate.plainSummary === null ||
              (candidate.revision.contribution !== undefined && candidate.confirmation === null)
            : true,
    );
    const ranked =
      terms.length === 0
        ? kept
        : kept
            .map((candidate) => ({ candidate, score: relevance(candidate, terms) }))
            .filter(({ score }) => score.matched > 0)
            // Rows arrive newest first and the sort is stable, so ties stay by recency.
            .sort((a, b) => b.score.matched - a.score.matched || b.score.weight - a.score.weight)
            .map(({ candidate }) => candidate);
    const offset = Number.parseInt(input.cursor ?? "0", 10) || 0;
    const limit = input.limit ?? 20;
    const page: ChampionLearningEntry[] = [];
    let bytes = 0;
    for (const candidate of ranked.slice(offset, offset + limit)) {
      const size = new TextEncoder().encode(json(candidate)).length;
      if (page.length > 0 && bytes + size > PAGE_BYTES) break;
      page.push(candidate);
      bytes += size;
    }
    const next = offset + page.length;
    return {
      learnings: page,
      total: ranked.length,
      nextCursor: next < ranked.length ? String(next) : null,
    } satisfies ChampionLearningSearchResult;
  }, Effect.mapError(failure));

  const topics = Effect.fn("ChampionLearnings.topics")(function* (input: {
    readonly projectId?: ProjectId | undefined;
    readonly championId?: string | undefined;
  }) {
    const rows = yield* sql<{
      champion_id: string;
      champion_name: string;
      topic: string;
      learnings: number;
      latest_at: string;
    }>`SELECT h.champion_id, json_extract(c.document_json, '$.champion.name') AS champion_name, r.topic, COUNT(*) AS learnings, MAX(r.at) AS latest_at
      FROM champion_learning_heads h
      JOIN champion_learning_revisions r ON r.id = h.revision_id
      JOIN champions c ON c.id = h.champion_id
      WHERE (${input.championId ?? null} IS NULL OR h.champion_id = ${input.championId ?? null})
        AND (${input.projectId ?? null} IS NULL OR json_extract(r.document_json, '$.projectId') = ${input.projectId ?? null})
      GROUP BY h.champion_id, r.topic ORDER BY latest_at DESC LIMIT 200`;
    return {
      topics: rows.map((row) => ({
        championId: row.champion_id,
        championName: row.champion_name,
        topic: row.topic,
        learnings: row.learnings,
        latestAt: row.latest_at,
      })),
    } satisfies ChampionLearningTopicsResult;
  }, Effect.mapError(failure));

  const current = Effect.fn("ChampionLearnings.current")(function* (
    championId: string,
    learningId: string,
  ) {
    const [row] = yield* currentRows({ championId, learningId });
    if (row === undefined) return yield* new ChampionError({ reason: "not-found" });
    return yield* entry(row, yield* now);
  });

  const readLearning = Effect.fn("ChampionLearnings.read")(function* (
    input: ChampionLearningReadInput,
  ) {
    const head = yield* current(input.id, input.learningId);
    const revisions = yield* sql<{
      document_json: string;
    }>`SELECT document_json FROM champion_learning_revisions WHERE champion_id = ${input.id} AND learning_id = ${input.learningId} ORDER BY rowid DESC LIMIT 50`;
    const confirmations = yield* sql<{
      document_json: string;
    }>`SELECT document_json FROM champion_learning_annotations WHERE champion_id = ${input.id} AND learning_id = ${input.learningId} AND kind = 'confirmation' ORDER BY at DESC, id DESC LIMIT 50`;
    return {
      current: head,
      history: yield* Effect.forEach(revisions, (row) =>
        decodeRevision(row.document_json).pipe(
          Effect.map((revision) =>
            revision.id === head.revision.id
              ? head.revision
              : { ...revision, isCurrent: false, applicabilityState: "uncertain" as const },
          ),
        ),
      ),
      confirmations: yield* Effect.forEach(confirmations, (row) =>
        decodeConfirmation(row.document_json),
      ),
    } satisfies ChampionLearningReadResult;
  }, Effect.mapError(failure));

  /** Confirmations and plain notes attach to the current revision and never replace it. */
  const annotate = Effect.fn("ChampionLearnings.annotate")(function* (
    input: { readonly id: string; readonly learningId: string; readonly revisionId: string },
    kind: "confirmation" | "plain",
    check: (entry: ChampionLearningEntry) => string | null,
    document: (at: string) => unknown,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const head = yield* current(input.id, input.learningId);
        if (head.revision.id !== input.revisionId)
          return yield* new ChampionError({
            reason: "conflict",
            detail: `Revision ${input.revisionId} is no longer current; read the learning again.`,
          });
        const refusal = check(head);
        if (refusal !== null)
          return yield* new ChampionError({ reason: "invalid", detail: refusal });
        const at = yield* now;
        const id = yield* random.uuidV4();
        yield* sql`INSERT INTO champion_learning_annotations (id,champion_id,learning_id,revision_id,kind,at,document_json) VALUES (${id},${input.id},${input.learningId},${input.revisionId},${kind},${at},${json(document(at))})`;
        return yield* current(input.id, input.learningId);
      }),
    );
  }, Effect.mapError(failure));

  const confirm = (input: ChampionLearningConfirmInput) =>
    annotate(
      input,
      "confirmation",
      (head) =>
        head.revision.contribution === undefined
          ? "Only a contributed learning is confirmed; revise your own with t3_champions_record_learning."
          : null,
      (at) =>
        ({
          revisionId: input.revisionId,
          at,
          note: input.note,
        }) satisfies ChampionLearningConfirmation,
    );

  const note = (input: ChampionLearningNoteInput) =>
    annotate(
      input,
      "plain",
      (head) =>
        head.revision.plainSummary === undefined
          ? null
          : "This revision already carries its own plain sentence.",
      () => ({ plainSummary: input.plainSummary }),
    );

  return { search, topics, read: readLearning, confirm, note };
});
