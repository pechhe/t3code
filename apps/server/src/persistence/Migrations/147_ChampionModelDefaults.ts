import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Normalises a stored selection (legacy rows use `provider`) into a canonical object. */
const canonicalSelection = (value: unknown): Json | undefined => {
  if (!isRecord(value)) return undefined;
  const instanceId = value.instanceId ?? value.provider;
  if (typeof instanceId !== "string" || typeof value.model !== "string") return undefined;
  const selection: Json = { instanceId, model: value.model };
  if (Array.isArray(value.options) && value.options.length > 0) {
    selection.options = value.options
      .filter(isRecord)
      .map((option) => ({ id: option.id, value: option.value }))
      .toSorted((a, b) => String(a.id).localeCompare(String(b.id)));
  }
  if (typeof value.pinned === "boolean") selection.pinned = value.pinned;
  return selection;
};

const mostCommon = (
  champions: ReadonlyArray<{ readonly updatedAt: string; readonly selection: unknown }>,
): Json | undefined => {
  const groups = new Map<string, { count: number; latest: string; selection: Json }>();
  for (const champion of champions) {
    const selection = canonicalSelection(champion.selection);
    if (selection === undefined) continue;
    const key = JSON.stringify(selection);
    const group = groups.get(key) ?? { count: 0, latest: "", selection };
    group.count += 1;
    if (champion.updatedAt > group.latest) group.latest = champion.updatedAt;
    groups.set(key, group);
  }
  return [...groups.entries()].toSorted(
    ([keyA, a], [keyB, b]) =>
      b.count - a.count ||
      (a.latest === b.latest ? 0 : a.latest < b.latest ? 1 : -1) ||
      keyA.localeCompare(keyB),
  )[0]?.[1].selection;
};

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS champion_model_defaults (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    document_json TEXT NOT NULL
  )`;

  const rows = yield* sql<{
    readonly updatedAt: string | null;
    readonly routine: string | null;
    readonly setup: string | null;
  }>`
    SELECT json_extract(document_json, '$.champion.updatedAt') AS updatedAt,
           json_extract(document_json, '$.champion.routineModelSelection') AS routine,
           json_extract(document_json, '$.champion.setupModelSelection') AS setup
    FROM champions
    WHERE json_valid(document_json)
      AND json_extract(document_json, '$.champion.lifecycle') = 'active'
  `;
  if (rows.length === 0) return;

  const parse = (text: string | null): unknown => {
    if (text === null) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };
  const checks = mostCommon(
    rows.map((row) => ({ updatedAt: row.updatedAt ?? "", selection: parse(row.routine) })),
  );
  const advice = mostCommon(
    rows.map((row) => ({ updatedAt: row.updatedAt ?? "", selection: parse(row.setup) })),
  );
  const document = {
    ...(checks === undefined ? {} : { checks: { model: checks } }),
    ...(advice === undefined ? {} : { advice: { model: advice } }),
  };
  yield* sql`INSERT INTO champion_model_defaults (id, document_json) VALUES (1, ${json(document)})`;
});
