export const CATEGORIES = [
  "comment-accuracy",
  "name-side-effect",
  "error-actionability",
  "assertion-weakening",
  "code-smell",
] as const;
export type Category = (typeof CATEGORIES)[number];
export type Label = "defect" | "ok" | "uncertain";

export interface CorpusCase {
  readonly id: string;
  readonly split: "tune" | "heldout";
  readonly category: Category;
  readonly stratum: "clear-positive" | "tricky-negative" | "boundary";
  /** Synthetic change shown to the model. Never contains secrets or customer data. */
  readonly evidence: string;
  /** The author's label by construction. Not the reference label. */
  readonly authorLabel: Label;
  readonly authorNote: string;
}
