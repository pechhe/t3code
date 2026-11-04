// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off globalTimers:off - Evaluation-only host script that re-runs pristine controls.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { runFiles } from "./label.ts";

const DIR = import.meta.dirname;

export interface RetainedControls {
  readonly requested: ReadonlyArray<string>;
  readonly results: Record<string, { status: string; seconds: number }>;
  readonly exitCodes: Record<string, number>;
  readonly wallSeconds: number;
}

/** A later verification adds to the retained controls; it never replaces earlier evidence. */
export function mergeControls(
  existing: RetainedControls | undefined,
  next: RetainedControls,
): RetainedControls {
  return {
    requested: [...new Set([...(existing?.requested ?? []), ...next.requested])].toSorted(),
    results: { ...existing?.results, ...next.results },
    exitCodes: { ...existing?.exitCodes, ...next.exitCodes },
    wallSeconds: (existing?.wallSeconds ?? 0) + next.wallSeconds,
  };
}

interface StoredCase {
  id: string;
  failing: string[];
  uncertain: string[];
  verifiedPassing?: string[];
  controlVerified?: boolean;
  measuredSeconds: Record<string, number>;
  candidates: Array<{ directory: string; file: string }>;
}

/**
 * Earlier cases recorded a failure as caused by the mutation whenever it did not fail on the pristine
 * source, which also counted a missing control result. This re-runs the pristine source once over every
 * recorded failing file and keeps a failure only on an explicit pass, retaining the control outcomes.
 */
function main() {
  const dir = NodePath.join(DIR, "corpus/cases");
  const cases = NodeFS.readdirSync(dir)
    .filter((f) => f.startsWith("seeded-"))
    .toSorted()
    .map((f) => ({
      f,
      c: JSON.parse(NodeFS.readFileSync(NodePath.join(dir, f), "utf8")) as StoredCase,
    }))
    .filter(({ c }) => !c.controlVerified);
  const wanted = new Map<string, { directory: string; file: string }>();
  for (const { c } of cases)
    for (const file of c.failing) {
      const entry = c.candidates.find((t) => t.file === file);
      if (entry) wanted.set(file, entry);
    }
  if (cases.length === 0) {
    console.log("every case already has a verified control; retained controls are untouched");
    return;
  }
  const control = runFiles([...wanted.values()], 6);
  const target = NodePath.join(DIR, "corpus/controls.json");
  const existing = NodeFS.existsSync(target)
    ? (JSON.parse(NodeFS.readFileSync(target, "utf8")) as RetainedControls)
    : undefined;
  NodeFS.writeFileSync(
    target,
    JSON.stringify(
      mergeControls(existing, {
        requested: [...wanted.keys()],
        results: control.results,
        exitCodes: control.exitCodes,
        wallSeconds: control.wallSeconds,
      }),
      null,
      1,
    ),
  );
  for (const { f, c } of cases) {
    const failed = new Set([...c.failing, ...c.uncertain]);
    const failing = c.failing.filter((file) => control.results[file]?.status === "passed");
    c.uncertain = [...failed].filter((file) => !failing.includes(file)).toSorted();
    c.verifiedPassing = Object.keys(c.measuredSeconds)
      .filter((file) => !failed.has(file))
      .toSorted();
    c.failing = failing;
    c.controlVerified = true;
    NodeFS.writeFileSync(NodePath.join(dir, f), JSON.stringify(c, null, 1));
    console.log(
      `${c.id}: failing=${failing.length} uncertain=${c.uncertain.length} verifiedPassing=${c.verifiedPassing.length}`,
    );
  }
}
if (import.meta.main) main();
