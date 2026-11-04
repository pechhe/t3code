// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalTimers:off - Evaluation-only host script (wall-clock measurements, pacing and files); not Effect services.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { candidatesFor, budgetBaseline, readDurations } from "./baseline.ts";

const OUT = NodePath.join(import.meta.dirname, "corpus/candidates");
export const slug = (file: string) => file.replaceAll("/", "__");

/** Caches the gate's candidate list for a one-file change so every arm sees identical input. */
async function main(files: ReadonlyArray<string>) {
  const durations = readDurations();
  for (const file of files) {
    const target = NodePath.join(OUT, `${slug(file)}.json`);
    if (NodeFS.existsSync(target)) continue;
    const started = Date.now();
    const change = { changed: [file], deleted: [] };
    const found = await candidatesFor(change);
    const budget = budgetBaseline(found.candidates, change, durations);
    NodeFS.writeFileSync(
      target,
      JSON.stringify(
        {
          changed: [file],
          kind: found.kind,
          reason: found.reason ?? null,
          candidates: found.candidates,
        },
        null,
        1,
      ),
    );
    console.log(
      `${file}: ${found.kind} candidates=${found.candidates.length} mandatory=${budget.mandatory} selected=${budget.selected.length} deferred=${budget.deferred.length} est=${Math.round(budget.seconds)}s listing=${Math.round((Date.now() - started) / 1000)}s`,
    );
  }
}
if (import.meta.main) await main(process.argv.slice(2));
