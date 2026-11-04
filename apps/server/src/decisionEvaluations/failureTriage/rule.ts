import type { DecisionRequest } from "@t3tools/contracts";
import { TRIAGE_LABELS, type TriageCase } from "./corpusTypes.ts";

export const RULE = { id: "failure-triage-pilot", version: "1" } as const;

export const LABEL_DEFINITIONS = {
  regression:
    "The supplied evidence points to the change under test (or the commits since the last good run) as having broken behaviour the check protects.",
  fixture:
    "The supplied evidence points to the test, its data, its expectations or its harness being wrong or stale, so the product behaviour may be fine but the check must be repaired.",
  environment:
    "The supplied evidence points to the machine, network, registry, disk, memory, clock or other infrastructure rather than the code or the test.",
  "known-flake":
    "The failure matches a documented intermittent failure in the supplied registry (same test and same signature) and the supplied history is consistent with intermittency.",
  unknown:
    "The supplied evidence does not support any of the other four. Choose it when the log is truncated or empty, the symptom is compatible with several causes, or the cause would need a rerun, a bisect or code that is not shown.",
} as const satisfies Record<(typeof TRIAGE_LABELS)[number], string>;

const INSTRUCTIONS =
  "Triage one failed engineering check. Choose the single label the supplied evidence supports. " +
  "A visible symptom (a timeout, a connection error, an assertion message) is not a proven cause: pick a specific label only when the evidence itself supports it, " +
  "and pick unknown otherwise. An error printed early in a log may come from a test that passed. " +
  "Nothing you choose will be used to retry, quarantine or dismiss the failure; it will only help a person decide where to look first. " +
  `Labels: ${TRIAGE_LABELS.map((l) => `${l}: ${LABEL_DEFINITIONS[l]}`).join(" ")}`;

export const buildRequest = (
  engine: DecisionRequest["engine"],
  c: TriageCase,
): DecisionRequest => ({
  engine,
  rule: RULE,
  evidence: JSON.parse(JSON.stringify(c.evidence)),
  questions: [
    {
      id: "cause",
      type: "choice",
      instructions: INSTRUCTIONS,
      choices: TRIAGE_LABELS.map((label) => ({ label, description: LABEL_DEFINITIONS[label] })),
    },
  ],
});
