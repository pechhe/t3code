export const CLAIM_LABELS = ["supported", "contradicted", "insufficient"] as const;
export type ClaimLabel = (typeof CLAIM_LABELS)[number];

export const DECISION_LABELS = [
  "settled-consequential",
  "tentative",
  "routine",
  "duplicate",
] as const;
export type DecisionLabel = (typeof DECISION_LABELS)[number];

/** authentic: text and evidence as they existed; reconstructed: authentic evidence with a claim or passage rewritten; synthetic: written for this pilot. */
export type Stratum = "authentic" | "reconstructed" | "synthetic";

export type Tag =
  | "truncated"
  | "caveat"
  | "not-run"
  | "stale-revision"
  | "landed-vs-installed"
  | "partial-claim"
  | "agreed-vs-suggested"
  | "duplicate"
  | "hard-negative";

interface Base {
  readonly id: string;
  readonly split: "tune" | "heldout";
  /** Cases of one family never straddle the tune/held-out split. */
  readonly family: string;
  readonly stratum: Stratum;
  readonly tags: ReadonlyArray<Tag>;
  /** Where the text came from: a retained record, commit, report or the author. */
  readonly provenance: string;
}

/** Question 1: does the evidence support a completion or verification claim? */
export interface ClaimCase extends Base {
  readonly kind: "claim";
  readonly claim: string;
  readonly evidence: string;
}

/** Question 2: does the passage settle a consequential decision worth a thinking-model adjudicator? */
export interface DecisionCase extends Base {
  readonly kind: "decision";
  readonly passage: string;
  /** Decisions already recorded, visible to the engine so a restatement can be called a duplicate. */
  readonly existing: ReadonlyArray<string>;
}

export type ScreenCase = ClaimCase | DecisionCase;
