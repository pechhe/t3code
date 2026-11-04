// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalTimers:off - Evaluation-only host script (wall-clock measurements, pacing and files); not Effect services.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { candidatesFor, ROOT } from "./baseline.ts";

const DIR = import.meta.dirname;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const MAX_DIFF_BYTES = 12_000;

/**
 * A real landed change's source files and diff, with its tests removed (the author's own test edits
 * would trivially be mandatory). Candidates come from the gate's listing on this checkout, so
 * they approximate the tree the change landed on; the case carries no failure labels.
 */
async function main(commits: ReadonlyArray<string>) {
  for (const commit of commits) {
    const id = `historical-${commit}`;
    const target = NodePath.join(DIR, "corpus/cases", `${id}.json`);
    if (NodeFS.existsSync(target)) continue;
    const names = NodeChildProcess.execFileSync(
      "git",
      ["diff-tree", "--no-commit-id", "--name-only", "-r", commit],
      { cwd: ROOT, encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    const changed = names.filter(
      (f) =>
        !TEST_FILE.test(f) &&
        /\.[cm]?[jt]sx?$/.test(f) &&
        NodeFS.existsSync(NodePath.join(ROOT, f)),
    );
    if (changed.length === 0) continue;
    const diff = NodeChildProcess.execFileSync(
      "git",
      ["diff", `${commit}^`, commit, "--", ...changed],
      { cwd: ROOT, encoding: "utf8" },
    ).slice(0, MAX_DIFF_BYTES);
    const found = await candidatesFor({ changed, deleted: [] });
    if (found.kind !== "related") {
      console.log(`${id}: ${found.kind} (${found.reason ?? ""}); skipped`);
      continue;
    }
    NodeFS.writeFileSync(
      target,
      JSON.stringify(
        { id, kind: "historical", commit, changed, diff, candidates: found.candidates },
        null,
        1,
      ),
    );
    console.log(`${id}: changed=${changed.length} candidates=${found.candidates.length}`);
  }
}
if (import.meta.main) await main(process.argv.slice(2));
