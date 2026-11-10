// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - one-off corpus builder, not server code
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { diffEvidence, git, INTEGRATION_REF, type Repo } from "./diffs.ts";

/** Sampling rule for clean candidates, fixed before any engine call; the full rule is in README.md. */
export const WINDOW = { from: "2026-09-22", to: "2026-11-10" } as const;
export const SEED = "T3-573";
export const TAKE: Readonly<Record<Repo, { heldout: number; tune: number }>> = {
  t3code: { heldout: 40, tune: 5 },
  yardsmith: { heldout: 40, tune: 5 },
  slipjay: { heldout: 10, tune: 0 },
};
const SUBJECT_EXCLUDED = /^(revert|wip|merge|chore\(release\)|temp|release)\b/i;

const seedOf = (text: string) => {
  let h = 1779033703 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
};
const mulberry32 = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const here = import.meta.dirname;
const named = new Set(
  (
    JSON.parse(NodeFS.readFileSync(NodePath.join(here, "results/named.json"), "utf8")) as string[]
  ).map((s) => s.slice(0, 10)),
);
const defects = new Set(
  (
    JSON.parse(NodeFS.readFileSync(NodePath.join(here, "results/yield.json"), "utf8")) as {
      yes: { commit: string }[];
    }
  ).yes.map((d) => d.commit.slice(0, 10)),
);

const pool: Record<string, { heldout: string[]; tune: string[]; eligible: number }> = {};
for (const repo of Object.keys(TAKE) as Repo[]) {
  const shas = git(
    repo,
    "log",
    INTEGRATION_REF[repo],
    "--no-merges",
    `--since=${WINDOW.from}T00:00:00Z`,
    `--until=${WINDOW.to}T23:59:59Z`,
    "--format=%H%x09%s",
  )
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("\t") as [string, string])
    .filter(
      ([sha, subject]) =>
        !SUBJECT_EXCLUDED.test(subject) &&
        !named.has(sha.slice(0, 10)) &&
        !defects.has(sha.slice(0, 10)),
    )
    .map(([sha]) => sha)
    .sort();
  const random = mulberry32(seedOf(`${SEED}:${repo}`));
  const order = shas.map((sha) => ({ sha, key: random() })).sort((a, b) => a.key - b.key);
  const kept: string[] = [];
  const want = TAKE[repo].heldout + TAKE[repo].tune;
  for (const { sha } of order) {
    if (kept.length >= want) break;
    const e = diffEvidence(repo, sha);
    if (e.hasCode && e.changedLines >= 5 && e.changedLines <= 400) kept.push(sha);
  }
  pool[repo] = {
    heldout: kept.slice(0, TAKE[repo].heldout),
    tune: kept.slice(TAKE[repo].heldout),
    eligible: shas.length,
  };
}
NodeFS.writeFileSync(
  NodePath.join(here, "results/pool.json"),
  `${JSON.stringify({ rule: "see buildPool.ts", seed: SEED, window: WINDOW, pool }, null, 1)}\n`,
);
console.log(
  JSON.stringify(
    Object.fromEntries(
      Object.entries(pool).map(([r, p]) => [r, [p.eligible, p.heldout.length, p.tune.length]]),
    ),
  ),
);
