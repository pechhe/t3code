import { CLAIM_LABELS, DECISION_LABELS } from "./corpusTypes.ts";

export const CLAIM_DEFINITIONS: Readonly<Record<(typeof CLAIM_LABELS)[number], string>> = {
  supported:
    "The evidence directly shows every part of the claim to be true, including its numbers, scope, revision and what was actually run.",
  contradicted:
    "The evidence shows some part of the claim to be false: a different number, a failure the claim ignores, another revision, or something not done that the claim says was done.",
  insufficient:
    "The evidence is silent about, partial for, truncated before, or about something other than part of the claim, so it cannot be confirmed or refuted from this evidence.",
};

export const DECISION_DEFINITIONS: Readonly<Record<(typeof DECISION_LABELS)[number], string>> = {
  "settled-consequential":
    "States a choice that has been made, not proposed, and that constrains later work, risk, permissions, data, release, architecture or behaviour others rely on.",
  tentative:
    "A proposal, suggestion, option, recommendation, open question or conditional next step that nobody has agreed.",
  routine:
    "A settled but local or low-consequence detail, or a report of what was done, that no later decision depends on.",
  duplicate:
    "Restates a decision that already appears in the supplied existing decisions, with nothing material added.",
};
