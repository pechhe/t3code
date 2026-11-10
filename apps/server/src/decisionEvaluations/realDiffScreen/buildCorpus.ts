// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - one-off corpus builder, not server code
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { CaseRecord } from "./corpus.ts";
import { diffEvidence, sha256, type Repo } from "./diffs.ts";

/**
 * Joins the yield list, the sampled pool and the two blind labelers into `corpus/cases.json`.
 * Held-out: the attributed defects and the sampled commits; tune: the partly attributed defects and the tune sample.
 * Usage: node buildCorpus.ts
 */
const here = import.meta.dirname;
const read = <T>(file: string) =>
  JSON.parse(NodeFS.readFileSync(NodePath.join(here, file), "utf8")) as T;

interface Yield {
  yes: { repo: Repo; commit: string; laterCommits: string[]; diffVisible: boolean }[];
  partly: { repo: Repo; commit: string }[];
}
const yieldList = read<Yield>("results/yield.json");
const pool = read<{ pool: Record<Repo, { heldout: string[]; tune: string[] }> }>(
  "results/pool.json",
).pool;
const key = read<Record<string, { ref: string; digest: string }>>("results/labeler-key.json");
const labelsA = read<Record<string, "defect" | "clean" | "unsure">>("results/labels-A.json");
const labelsB = read<Record<string, "defect" | "clean" | "unsure">>("results/labels-B.json");

const sensitiveIds = new Set(
  read<{ sensitiveIds: string[] }>("results/sensitive-flags.json").sensitiveIds,
);
const sensitiveRefs = new Set([...sensitiveIds].map((id) => key[id]!.ref));

const labelsFor = new Map<string, readonly [CaseRecord["labels"][0], CaseRecord["labels"][1]]>();
for (const [id, { ref }] of Object.entries(key)) labelsFor.set(ref, [labelsA[id]!, labelsB[id]!]);

const make = (
  split: CaseRecord["split"],
  repo: Repo,
  commit: string,
  origin: CaseRecord["origin"],
  record: string,
  needsFiles: boolean,
): CaseRecord => {
  const e = diffEvidence(repo, commit);
  const digest = sha256(e.text);
  const ref = `${repo}:${commit}`;
  const entry = Object.values(key).find((k) => k.ref === ref);
  if (entry === undefined || entry.digest !== digest)
    throw new Error(`Labelers did not see this evidence: ${ref}`);
  return {
    id: `${origin === "defect" ? "d" : "c"}-${repo}-${commit.slice(0, 8)}`,
    split,
    repo,
    commit,
    origin,
    record,
    needsFiles,
    truncated: e.truncated,
    digest,
    labels: labelsFor.get(ref)!,
  };
};

const excluded = new Set(
  read<{ excluded: { id: string }[] }>("results/excluded-cases.json").excluded.map((e) => e.id),
);
const cases: CaseRecord[] = [
  ...yieldList.yes.map((d) =>
    make(
      "heldout",
      d.repo,
      d.commit,
      "defect",
      `later commits ${d.laterCommits.join(", ")} name it and fix a defect it introduced`,
      !d.diffVisible,
    ),
  ),
  ...yieldList.partly.map((d) =>
    make(
      "tune",
      d.repo,
      d.commit,
      "defect",
      "a later commit names it and fixes a defect it contributed to",
      true,
    ),
  ),
  ...(Object.entries(pool) as [Repo, { heldout: string[]; tune: string[] }][]).flatMap(
    ([repo, p]) => [
      ...p.heldout
        .filter((c) => !sensitiveRefs.has(`${repo}:${c}`))
        .map((c) =>
          make(
            "heldout",
            repo,
            c,
            "clean-candidate",
            "sampled by buildPool.ts (seed T3-573); clean only if both blind labelers say so",
            false,
          ),
        ),
      ...p.tune
        .filter((c) => !sensitiveRefs.has(`${repo}:${c}`))
        .map((c) =>
          make(
            "tune",
            repo,
            c,
            "clean-candidate",
            "sampled by buildPool.ts (seed T3-573); clean only if both blind labelers say so",
            false,
          ),
        ),
    ],
  ),
].filter((c) => !excluded.has(c.id));
NodeFS.writeFileSync(
  NodePath.join(here, "corpus/cases.json"),
  `${JSON.stringify(cases, null, 1)}\n`,
);
console.log(`wrote ${cases.length} cases`);
