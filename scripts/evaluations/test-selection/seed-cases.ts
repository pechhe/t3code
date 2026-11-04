// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalTimers:off - Evaluation-only host script (wall-clock measurements, pacing and files); not Effect services.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { budgetBaseline, budgetInput, readDurations, ROOT } from "./baseline.ts";
import { runFiles, withMutation } from "./label.ts";
import { hunkOf, mutationsOf, sampleMutations } from "./mutate.ts";
import { slug } from "./build-candidates.ts";
import { seededRandom } from "./select.ts";

const DIR = import.meta.dirname;
export const MAX_CANDIDATES = 200;

interface CachedCandidates {
  readonly changed: ReadonlyArray<string>;
  readonly kind: string;
  readonly candidates: ReadonlyArray<{ directory: string; file: string }>;
}

/**
 * Plants `perFile` seeded mutations in a source file, runs every candidate test once mutated
 * (labels), and re-runs failures on the pristine source so a pre-existing or flaky failure is
 * never counted as caused by the mutation. Survivors and uncontrolled failures are kept as attempts.
 */
async function main(file: string, perFile: number, seed: number) {
  const cache = JSON.parse(
    NodeFS.readFileSync(NodePath.join(DIR, "corpus/candidates", `${slug(file)}.json`), "utf8"),
  ) as CachedCandidates;
  const sampleSize = Number(process.env.T3_SAMPLE ?? 0);
  if (sampleSize === 0 && cache.candidates.length > MAX_CANDIDATES) {
    console.log(
      `${file}: ${cache.candidates.length} candidates exceeds ${MAX_CANDIDATES}; not labelled`,
    );
    return;
  }
  const full = cache.candidates.length;
  if (sampleSize > 0 && full > sampleSize) {
    // Hub fan-out is too large to execute under the host's load: keep every mandatory test and a seeded sample of the rest.
    const { input } = budgetInput(
      cache.candidates,
      { changed: [file], deleted: [] },
      readDurations(),
      60,
    );
    const mandatory = input.gateOrder.slice(0, input.mandatory);
    const random = seededRandom(seed);
    const rest = input.gateOrder
      .slice(input.mandatory)
      .map((t) => ({ t, k: random() }))
      .toSorted((a, b) => a.k - b.k)
      .slice(0, sampleSize)
      .map((e) => e.t);
    (cache as { candidates: unknown }).candidates = [...mandatory, ...rest];
  }
  const source = NodeFS.readFileSync(NodePath.join(ROOT, file), "utf8");
  const durations = readDurations();
  const picked = sampleMutations(mutationsOf(file, source), perFile, seed);
  for (const mutation of picked) {
    const id = `seeded-${slug(file).replace(/\.ts$/, "")}-L${mutation.line}-${mutation.operator}`;
    const target = NodePath.join(DIR, "corpus/cases", `${id}.json`);
    if (
      NodeFS.existsSync(target) ||
      NodeFS.existsSync(NodePath.join(DIR, "corpus/attempts", `${id}.json`))
    )
      continue;
    const mutated = withMutation(mutation, () => runFiles(cache.candidates, 6));
    const failed = Object.entries(mutated.results)
      .filter(([, r]) => r.status === "failed")
      .map(([f]) => f);
    const control = failed.length
      ? runFiles(
          cache.candidates.filter((c) => failed.includes(c.file)),
          6,
        )
      : undefined;
    // A failure counts only against an explicit passing pristine result; a missing or failed control is uncertain.
    const failing = failed.filter((f) => control?.results[f]?.status === "passed").toSorted();
    const uncertain = failed.filter((f) => !failing.includes(f)).toSorted();
    const verifiedPassing = Object.entries(mutated.results)
      .filter(([, r]) => r.status === "passed")
      .map(([f]) => f)
      .toSorted();
    const change = { changed: [file], deleted: [] };
    const baseline = budgetBaseline(cache.candidates, change, durations);
    const record = {
      id,
      kind: "seeded",
      seed,
      mutation,
      hunk: hunkOf(source, mutation),
      changed: [file],
      candidates: cache.candidates,
      subsampledFrom: sampleSize > 0 && full > sampleSize ? full : null,
      ranksNote: "ranks recomputed by the harness from the gate's budgetLandingTests inputs",
      mandatory: baseline.mandatory,
      failing,
      uncertain,
      verifiedPassing,
      controlVerified: true,
      controlExitCodes: control?.exitCodes ?? {},
      unreported: cache.candidates.filter((c) => !(c.file in mutated.results)).map((c) => c.file),
      measuredSeconds: Object.fromEntries(
        Object.entries(mutated.results).map(([f, r]) => [f, r.seconds]),
      ),
      measuredWallSeconds: mutated.wallSeconds,
      exitCodes: mutated.exitCodes,
    };
    NodeFS.writeFileSync(
      failing.length > 0 ? target : NodePath.join(DIR, "corpus/attempts", `${id}.json`),
      JSON.stringify(record, null, 1),
    );
    console.log(
      `${id}: candidates=${cache.candidates.length} failing=${failing.length} uncertain=${uncertain.length} wall=${Math.round(mutated.wallSeconds)}s ${failing.length ? "" : "SURVIVED"}`,
    );
  }
}
if (import.meta.main)
  await main(process.argv[2]!, Number(process.argv[3] ?? 3), Number(process.argv[4] ?? 1));
