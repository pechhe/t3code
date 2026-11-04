import pool from "./pool.json" with { type: "json" };
import type { PoolItem, RankingCase, Stratum } from "./corpusTypes.ts";

export const POOL: ReadonlyArray<PoolItem> = pool.items as PoolItem[];
export const POOL_BY_ID: ReadonlyMap<string, PoolItem> = new Map(POOL.map((i) => [i.id, i]));

export const s = (name: string) => `skill:${name}`;
export const f = (path: string) => `file:${path}`;
export const k = (slug: string) => `finding:${slug}`;
export const GOVERNING = [f("AGENTS.md")] as const;
export const CANDIDATES_PER_CASE = 16;

/** Small deterministic generator, so the filler for a case never changes between runs. */
export const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
export const seedOf = (text: string) => {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
};
export const shuffled = <T>(items: ReadonlyArray<T>, seed: string): T[] => {
  const rand = mulberry32(seedOf(seed));
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};

interface Spec {
  readonly id: string;
  readonly split: "tune" | "heldout";
  readonly family: string;
  readonly stratum: Stratum;
  readonly task: string;
  /** Items the author expects to be needed. */
  readonly needed: ReadonlyArray<string>;
  /** Tempting items that look related but should not be needed. */
  readonly decoys: ReadonlyArray<string>;
  readonly requested?: ReadonlyArray<string>;
  readonly mandatory?: ReadonlyArray<string>;
  readonly changedFiles?: ReadonlyArray<string>;
}

/** Candidates are the needed items, the decoys, then seeded filler up to a fixed pool size; the order is shuffled by the harness. */
export const makeCase = (spec: Spec): RankingCase => {
  const mandatory = spec.mandatory ?? GOVERNING;
  const requested = spec.requested ?? [];
  const taken = new Set<string>([...mandatory, ...requested]);
  const chosen: string[] = [];
  for (const id of [...spec.needed, ...spec.decoys]) {
    if (!POOL_BY_ID.has(id)) throw new Error(`${spec.id}: ${id} is not in the pool`);
    if (!taken.has(id) && !chosen.includes(id)) chosen.push(id);
  }
  const filler = shuffled(
    POOL.map((i) => i.id).filter((id) => !taken.has(id) && !chosen.includes(id)),
    `fill:${spec.id}`,
  );
  while (chosen.length < CANDIDATES_PER_CASE) chosen.push(filler.shift()!);
  return {
    id: spec.id,
    split: spec.split,
    family: spec.family,
    stratum: spec.stratum,
    task: spec.task,
    mandatory,
    requested,
    candidates: chosen,
    authorNeeded: spec.needed.filter((id) => !taken.has(id)),
    ...(spec.changedFiles === undefined ? {} : { changedFiles: spec.changedFiles }),
  };
};

/** The order, and the opaque question ids, in which a case's candidates are shown to rankers and labelers alike. */
export const orderedCandidates = (c: RankingCase): ReadonlyArray<{ ref: string; id: string }> =>
  shuffled(c.candidates, `order:${c.id}`).map((id, i) => ({
    ref: `c${String(i + 1).padStart(2, "0")}`,
    id,
  }));
