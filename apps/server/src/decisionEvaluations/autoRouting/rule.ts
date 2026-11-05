import type { DecisionRequest } from "@t3tools/contracts";
import type { AutoCase, Decision } from "./corpusTypes.ts";
import { CHOICES, DECISION_QUESTIONS } from "./definitions.ts";

export const RULE = { id: "auto-routing-pilot", version: "1" } as const;

/** The engine is shown the request text and nothing else: not the starting project, the baseline, constraints, labels, outcomes or other decisions. */
export const buildRequest = (
  engine: DecisionRequest["engine"],
  decision: Decision,
  c: AutoCase,
): DecisionRequest => ({
  engine,
  rule: { id: `${RULE.id}-${decision}`, version: RULE.version },
  evidence: { request: c.task },
  questions: [
    {
      id: decision,
      type: "choice",
      instructions:
        `${DECISION_QUESTIONS[decision]} Judge only from the request text. An unusual or very short request is not automatically hard or easy; ` +
        `a small-looking change to access control, sign-in, permissions or data is costly if wrong. Nothing you answer overrides what the user said explicitly.`,
      choices: [
        ...CHOICES[decision],
        { label: "unknown", description: "The request does not support a confident choice." },
      ],
    },
  ],
});
