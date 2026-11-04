export type ItemKind = "skill" | "file" | "finding";

/** One thing that could be put in an agent's context. The ranker sees `title` and `description`; `bodyBytes` is what including it would cost. */
export interface PoolItem {
  readonly id: string;
  readonly kind: ItemKind;
  readonly title: string;
  readonly description: string;
  readonly bodyBytes: number;
}

export type Stratum = "authentic" | "reconstructed" | "synthetic";

/** What one labeler says of one candidate. `unknown` means the labeler could not judge it. */
export type LabelerNeed = "needed" | "helpful" | "unneeded" | "unknown";
/**
 * The agreed reference for one candidate. `needed` and `unneeded` need both labelers to say so; `helpful` is agreement that it is not
 * useless without both calling it needed; `uncertain` is a split between needed/helpful and unneeded, or any `unknown`. The author breaks no ties.
 */
export type Reference = "needed" | "helpful" | "unneeded" | "uncertain";

export interface RankingCase {
  readonly id: string;
  readonly split: "tune" | "heldout";
  /** Cases from one incident, commit or topic share a family and a split. */
  readonly family: string;
  readonly stratum: Stratum;
  readonly task: string;
  /** Always included, never ranked: governing instructions the task runs under. */
  readonly mandatory: ReadonlyArray<string>;
  /** Always included, never ranked: skills the requester named. */
  readonly requested: ReadonlyArray<string>;
  /** Items offered for ranking, including tempting irrelevant ones. */
  readonly candidates: ReadonlyArray<string>;
  /** The author's expectation, written before labelling. Not the reference. */
  readonly authorNeeded: ReadonlyArray<string>;
  /** Files a real commit changed for this task, when the case comes from one. Objective, and independent of every labeler. */
  readonly changedFiles?: ReadonlyArray<string>;
}
