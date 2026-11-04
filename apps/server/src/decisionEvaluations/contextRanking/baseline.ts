import { orderedCandidates, POOL, POOL_BY_ID } from "./caseBuilder.ts";
import type { RankingCase } from "./corpusTypes.ts";

export const BASELINE_VERSION = "bm25-pool-idf-v1";

const STOPWORDS = new Set(
  "a an and are as at be but by do for from has have how i if in into is it its me my new no not of on one or so than that the their then there these they this to up was we what when which who will with you your".split(
    " ",
  ),
);

/** Lower-cases, splits camelCase and punctuation, drops stopwords and one-character tokens, and strips a plural or -ing/-ed ending. */
export const tokenize = (text: string): string[] =>
  text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map((t) => t.replace(/(?:ing|ed|es|s)$/, (m) => (t.length - m.length >= 3 ? "" : m)));

const K1 = 1.2;
const B = 0.75;

const itemText = (id: string) => {
  const item = POOL_BY_ID.get(id)!;
  return `${item.title} ${item.description}`;
};
const docs = POOL.map((i) => tokenize(itemText(i.id)));
const averageLength = docs.reduce((n, d) => n + d.length, 0) / docs.length;
const documentFrequency = new Map<string, number>();
for (const d of docs)
  for (const t of new Set(d)) documentFrequency.set(t, (documentFrequency.get(t) ?? 0) + 1);
const idf = (t: string) => {
  const n = documentFrequency.get(t) ?? 0;
  return Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
};

/** BM25 of each candidate's title and description against the task text. Document statistics come from the whole pool and are fixed. */
export const lexicalScores = (c: RankingCase): Readonly<Record<string, number>> => {
  const query = [...new Set(tokenize(c.task))];
  const out: Record<string, number> = {};
  for (const { ref, id } of orderedCandidates(c)) {
    const tokens = tokenize(itemText(id));
    const counts = new Map<string, number>();
    for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
    out[ref] = query.reduce((score, q) => {
      const tf = counts.get(q) ?? 0;
      return tf === 0
        ? score
        : score +
            (idf(q) * (tf * (K1 + 1))) / (tf + K1 * (1 - B + (B * tokens.length) / averageLength));
    }, 0);
  }
  return out;
};
