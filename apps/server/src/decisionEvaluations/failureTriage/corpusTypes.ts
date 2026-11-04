export const TRIAGE_LABELS = [
  "regression",
  "fixture",
  "environment",
  "known-flake",
  "unknown",
] as const;
export type TriageLabel = (typeof TRIAGE_LABELS)[number];
/** `uncertain` marks annotator disagreement, which is different from a legitimate `unknown`. */
export type Reference = TriageLabel | "uncertain";

export type Stratum = "authentic" | "reconstructed" | "synthetic";

export interface TriageEvidence {
  readonly check: string;
  readonly exitStatus: string;
  readonly failureKind?: string;
  readonly failingTests: ReadonlyArray<string>;
  readonly firstError: string;
  readonly outputTail: string;
  /** What the change under test did, when the failed check ran for a change. */
  readonly change?: string;
  readonly changedSincePreviousAudit?: unknown;
  readonly changedFiles?: ReadonlyArray<string>;
  /** Only facts that existed when the failure was observed. */
  readonly recentHistory: ReadonlyArray<string>;
  readonly knownFlakeRegistry: ReadonlyArray<string> | string;
}

export interface ResolvedCause {
  /** What later work showed the cause to be, or `unknown` when no cause was ever identified. */
  readonly label: TriageLabel;
  readonly basis: string;
  readonly confidence: "high" | "medium" | "low";
}

export interface TriageCase {
  readonly id: string;
  readonly split: "tune" | "heldout";
  /** Cases from one incident, fix or repeated failure share a family and a split. */
  readonly family: string;
  readonly stratum: Stratum;
  readonly evidence: TriageEvidence;
  /** The author's reading of what the evidence alone supports. Not the reference. */
  readonly authorSupported: Reference;
  /** Retrospective, kept out of every request. */
  readonly resolvedCause: ResolvedCause;
}
