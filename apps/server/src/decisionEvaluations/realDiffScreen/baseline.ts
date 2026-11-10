import { baselineFlag } from "../semanticLint/baseline.ts";
import { CATEGORIES } from "../semanticLint/corpusTypes.ts";

export const BASELINE_VERSION = "semantic-lint-1-or";

/**
 * The frozen T3-355 heuristics, unchanged, run over the whole diff: flagged when any of its five category checks
 * fires. They were written for short synthetic hunks, so this is a floor, not a tuned competitor.
 */
export const heuristicFlag = (evidence: string): boolean =>
  CATEGORIES.some((category) =>
    baselineFlag({
      id: "case",
      split: "heldout",
      category,
      stratum: "boundary",
      evidence,
      authorLabel: "uncertain",
      authorNote: "",
    }),
  );
