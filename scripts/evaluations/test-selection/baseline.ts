// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalTimers:off - Evaluation-only host script (wall-clock measurements, pacing and files); not Effect services.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  budgetLandingTests,
  estimateSeconds,
  invariantGuards,
  LANDING_BUDGET,
  readQuarantine,
  readWorkspaces,
  relativeImports,
  selectLandingTests,
  type Durations,
  type LandingChange,
  type LandingTest,
} from "../../test-landing.ts";
import { listTests, mapConcurrently } from "../../lib/test-landing-vitest.ts";

export const ROOT = NodePath.resolve(import.meta.dirname, "../../..");

export function checkoutWorkspaces(root = ROOT) {
  const manifests = [
    "scripts/package.json",
    "oxlint-plugin-t3code/package.json",
    ...["apps", "packages", "infra"].flatMap((directory) =>
      NodeFS.readdirSync(NodePath.join(root, directory)).map(
        (name) => `${directory}/${name}/package.json`,
      ),
    ),
  ].filter((file) => NodeFS.existsSync(NodePath.join(root, file)));
  return readWorkspaces(manifests, (file) =>
    NodeFS.readFileSync(NodePath.join(root, file), "utf8"),
  );
}

export function readDurations(root = ROOT): Durations {
  return JSON.parse(NodeFS.readFileSync(NodePath.join(root, "tests/durations.json"), "utf8"));
}

export interface Candidates {
  readonly kind: "related" | "complete" | "none";
  readonly reason?: string;
  readonly candidates: ReadonlyArray<LandingTest>;
}

/** The gate's own candidate list for a change: Vitest's related-test graph per planned run. */
export async function candidatesFor(change: LandingChange, root = ROOT): Promise<Candidates> {
  const workspaces = checkoutWorkspaces(root);
  const plan = selectLandingTests(change, workspaces);
  if (plan.kind !== "related")
    return {
      kind: plan.kind,
      reason: plan.kind === "complete" ? plan.reason : "none",
      candidates: [],
    };
  const quarantined = new Set(
    readQuarantine(NodeFS.readFileSync(NodePath.join(root, "tests/quarantine.json"), "utf8")).map(
      (e) => e.file,
    ),
  );
  const listable = plan.runs.filter(
    (run) => typeof workspaces.find((w) => w.directory === run.directory)?.test === "object",
  );
  const listed = await mapConcurrently(
    listable,
    (run) => {
      const test = workspaces.find((w) => w.directory === run.directory)!.test;
      return listTests({
        root,
        directory: run.directory,
        flags: typeof test === "object" ? test.flags : [],
        related: run.files,
      });
    },
    1,
  );
  return {
    kind: "related",
    candidates: listed.flatMap((files, index) =>
      files
        .filter((file) => !quarantined.has(file))
        .map((file) => ({ directory: listable[index]!.directory, file })),
    ),
  };
}

export const importsOf =
  (root = ROOT) =>
  (file: string): ReadonlyArray<string> => {
    try {
      return relativeImports(file, NodeFS.readFileSync(NodePath.join(root, file), "utf8"));
    } catch {
      return [];
    }
  };

/** The gate's rank for a candidate, mirrored from budgetLandingTests so arms can reorder only the optional ranks. */
export function budgetBaseline(
  candidates: ReadonlyArray<LandingTest>,
  change: LandingChange,
  durations: Durations,
  budgetSeconds: number = LANDING_BUDGET.seconds,
  root = ROOT,
) {
  return budgetLandingTests(candidates, change.changed, durations, budgetSeconds, {
    guards: invariantGuards(change),
    imports: importsOf(root),
  });
}
export { estimateSeconds, LANDING_BUDGET };

/** Builds the arms' shared input from the gate's own budgeting of the candidates. */
export function budgetInput(
  candidates: ReadonlyArray<LandingTest>,
  change: LandingChange,
  durations: Durations,
  budgetSeconds: number,
  root = ROOT,
) {
  const gate = budgetBaseline(candidates, change, durations, budgetSeconds, root);
  // The gate's order is mandatory-first and rank-ordered whatever the budget, so
  // selected-then-deferred is a complete ordering only once the budget is unlimited.
  const all = budgetBaseline(candidates, change, durations, Number.POSITIVE_INFINITY, root);
  return {
    gate,
    input: {
      candidates,
      gateOrder: all.selected,
      mandatory: all.mandatory,
      durations,
      budgetSeconds,
    },
  };
}
