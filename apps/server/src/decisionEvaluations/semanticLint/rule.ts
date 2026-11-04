import type { DecisionRequest } from "@t3tools/contracts";
import type { Category, CorpusCase } from "./corpusTypes.ts";

export const RULE = { id: "semantic-lint-pilot", version: "1" } as const;
export const FLAG_THRESHOLD = 0.5;

const DEFINITIONS: Record<Category, string> = {
  "comment-accuracy":
    "Does this change leave a comment or doc claim that is now false or misleading about what the code does? " +
    "Answer true only for a stale or inaccurate claim. Answer false for a comment that is merely obvious, " +
    "redundant or verbose but still accurate, and for a comment updated together with the code it describes.",
  "name-side-effect":
    "Does the function's name (and any doc) hide a significant observable side effect or behaviour, such as a " +
    "write, deletion, network call or mutation of caller data, that a caller would not expect from the name? " +
    "Answer false when the name already admits the effect (for example fetch, create, ensure, getOrCreate) " +
    "and for purely internal memoisation.",
  "error-actionability":
    "Is the error message non-actionable: would a reader of the message alone be unable to tell what failed, " +
    "on what input, or what to do next? Answer false for a short message that names the cause or the fix, " +
    "and for a programmer-error invariant that names the impossible value.",
  "assertion-weakening":
    "Does the test change weaken verification, so that the new assertions would pass for behaviour the old " +
    "assertions rejected? Answer false when assertions are strengthened, restructured into an equivalent " +
    "check, or the expected value changes because the specified behaviour changed.",
  "code-smell":
    "Does this code take on several unrelated responsibilities so that a reviewer would reasonably ask to " +
    "split it? Answer false for a long but cohesive unit with one responsibility, such as a state machine, " +
    "a reducer, a parser, or a configuration constructor with many fields.",
};

export const buildRequest = (
  engine: DecisionRequest["engine"],
  c: CorpusCase,
): DecisionRequest => ({
  engine,
  rule: RULE,
  evidence: { category: c.category, change: c.evidence },
  questions: [{ id: "defect", type: "predicate", instructions: DEFINITIONS[c.category] }],
});
