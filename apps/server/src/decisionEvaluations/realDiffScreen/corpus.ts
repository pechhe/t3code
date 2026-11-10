import { diffEvidence, sha256, type Repo } from "./diffs.ts";

export type Reference = "defect" | "ok" | "uncertain";
export type Stratum = "diff-only" | "needs-files" | "clean";

/** One real commit. No code is stored here: the evidence is rebuilt from the repository and checked against `digest`. */
export interface CaseRecord {
  readonly id: string;
  readonly split: "tune" | "heldout";
  readonly repo: Repo;
  readonly commit: string;
  /** `defect`: a record names this commit; `clean-candidate`: sampled, judged by two blind labelers. */
  readonly origin: "defect" | "clean-candidate";
  /** Why it is a defect (the later commits that name it) or how it was sampled. */
  readonly record: string;
  /** Defects only: whether a reader of the diff alone could spot it. */
  readonly needsFiles: boolean;
  readonly truncated: boolean;
  readonly digest: string;
  /** Blind labels A and B for the commit, in labeler order. */
  readonly labels: readonly ["defect" | "clean" | "unsure", "defect" | "clean" | "unsure"];
}

/** Defects keep their record; a sampled commit is clean only when both blind labelers say so, otherwise it is listed, not scored. */
export const referenceOf = (c: CaseRecord): Reference =>
  c.origin === "defect"
    ? "defect"
    : c.labels[0] === "clean" && c.labels[1] === "clean"
      ? "ok"
      : "uncertain";

export const strataOf = (c: CaseRecord): Stratum =>
  referenceOf(c) === "defect" ? (c.needsFiles ? "needs-files" : "diff-only") : "clean";

/** The text an engine sees. A commit whose evidence no longer matches the recorded digest is refused. */
export const evidenceOf = (c: CaseRecord): string => {
  const { text } = diffEvidence(c.repo, c.commit);
  if (sha256(text) !== c.digest)
    throw new Error(`Evidence for ${c.id} no longer matches its digest`);
  return text;
};

export const corpusDigest = (cases: ReadonlyArray<CaseRecord>): string =>
  sha256(
    JSON.stringify(
      cases.map((c) => [
        c.id,
        c.split,
        c.repo,
        c.commit,
        c.origin,
        c.needsFiles,
        c.digest,
        c.labels,
      ]),
    ),
  );
