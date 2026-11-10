import type { DecisionRequest } from "@t3tools/contracts";

export const RULE = { id: "real-diff-screen", version: "1" } as const;
/** Fixed before any held-out call, not tuned per engine. */
export const FLAG_THRESHOLD = 0.5;

const QUESTION =
  "The evidence is one git commit: its subject line and its unified diff (generated files removed, long diffs cut " +
  "and marked). Does this change contain a defect that someone would have to fix after it is published: behaviour " +
  "that is wrong, a case it misses, a test or fixture it leaves out of step with the change, a caller or consumer " +
  "it breaks, or a regression? Answer true only when the diff gives you a specific reason. Answer false for a " +
  "change that looks correct as shown, including large, unusual or unfinished-looking ones, and for style, " +
  "naming or taste.";

export const buildRequest = (
  engine: DecisionRequest["engine"],
  evidence: string,
): DecisionRequest => ({
  engine,
  rule: RULE,
  evidence,
  questions: [{ id: "defect", type: "predicate", instructions: QUESTION }],
});
