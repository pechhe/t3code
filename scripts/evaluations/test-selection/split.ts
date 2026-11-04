// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalTimers:off - Evaluation-only host script (wall-clock measurements, pacing and files); not Effect services.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const DIR = import.meta.dirname;

const HUBS = /AgentRoleResolver|RunMetrics/;
const hash = (file: string) =>
  NodeCrypto.createHash("sha256").update(`t3-354:${file}`).digest("hex");

/**
 * Whole source files, never single mutants, are assigned by hash alone: the first 30% of files in
 * hash order tune the prompt. Hub files (budget-binding fan-out) are held-out only, so tuning
 * never sees the cases that decide the conclusion.
 */
export function splitFiles(files: ReadonlyArray<string>) {
  const ordered = files
    .filter((f) => !HUBS.test(f))
    .toSorted((a, b) => hash(a).localeCompare(hash(b)));
  const tuning = new Set(ordered.slice(0, Math.round(ordered.length * 0.3)));
  return (file: string) => (tuning.has(file) ? "tuning" : "heldout");
}

if (import.meta.main) {
  const dir = NodePath.join(DIR, "corpus/cases");
  const cases = NodeFS.readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .toSorted()
    .map(
      (f) =>
        JSON.parse(NodeFS.readFileSync(NodePath.join(dir, f), "utf8")) as {
          id: string;
          changed: string[];
        },
    );
  const assign = splitFiles([
    ...new Set(
      cases.filter((c) => !c.id.startsWith("historical-")).map((c) => c.changed.join(",")),
    ),
  ]);
  const split = Object.fromEntries(
    cases.map((c) => [
      c.id,
      c.id.startsWith("historical-") ? "historical" : assign(c.changed.join(",")),
    ]),
  );
  NodeFS.writeFileSync(NodePath.join(DIR, "corpus/split.json"), JSON.stringify(split, null, 1));
  console.log(
    Object.values(split).reduce<Record<string, number>>(
      (a, s) => Object.assign(a, { [s]: (a[s] ?? 0) + 1 }),
      {},
    ),
  );
}
