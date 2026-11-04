import { orderedCandidates } from "./caseBuilder.ts";
import { HELDOUT_CASES } from "./corpusHeldout.ts";
import { TUNE_CASES } from "./corpusTune.ts";
import type { LabelerNeed, RankingCase, Reference } from "./corpusTypes.ts";
import rawA from "./results/labels-A.json" with { type: "json" };
import rawB from "./results/labels-B.json" with { type: "json" };

type PerRef = Readonly<Record<string, LabelerNeed>>;
type Labels = Readonly<Record<string, PerRef>>;
const A = rawA.labels as Labels;
const B = rawB.labels as Labels;

/**
 * Two independent labelers decide; the author breaks nothing. Needed and unneeded require both to say so; a split between needed/helpful
 * and unneeded, or any `unknown`, stays uncertain and is reported, not resolved.
 */
export const agree = (a: LabelerNeed | undefined, b: LabelerNeed | undefined): Reference => {
  if (a === undefined || b === undefined || a === "unknown" || b === "unknown") return "uncertain";
  if (a === "needed" && b === "needed") return "needed";
  if (a === "unneeded" && b === "unneeded") return "unneeded";
  if (a === "unneeded" || b === "unneeded") return "uncertain";
  return "helpful";
};
const single = (a: LabelerNeed | undefined): Reference =>
  a === undefined || a === "unknown" ? "uncertain" : a;

const idOf = (c: RankingCase, ref: string) => orderedCandidates(c).find((o) => o.ref === ref)!.id;
const refOf = (c: RankingCase, id: string) => orderedCandidates(c).find((o) => o.id === id)!.ref;

export type View = (c: RankingCase, id: string) => Reference;

/** The primary view first. Alternative views show how much the findings depend on who labelled. */
export const labelViews: Readonly<Record<string, View>> = {
  agreed: (c, id) => agree(A[c.id]?.[refOf(c, id)], B[c.id]?.[refOf(c, id)]),
  /** A candidate one labeler called needed and the other called helpful counts as needed. */
  relaxed: (c, id) => {
    const r = agree(A[c.id]?.[refOf(c, id)], B[c.id]?.[refOf(c, id)]);
    const a = A[c.id]?.[refOf(c, id)];
    const b = B[c.id]?.[refOf(c, id)];
    return r === "helpful" && (a === "needed" || b === "needed") ? "needed" : r;
  },
  labelerA: (c, id) => single(A[c.id]?.[refOf(c, id)]),
  labelerB: (c, id) => single(B[c.id]?.[refOf(c, id)]),
};
export const primaryView = labelViews.agreed!;

export const labelAudit = (cases: ReadonlyArray<RankingCase>) =>
  cases.map((c) => ({
    caseId: c.id,
    stratum: c.stratum,
    candidates: orderedCandidates(c).map(({ ref, id }) => ({
      id,
      A: A[c.id]?.[ref] ?? null,
      B: B[c.id]?.[ref] ?? null,
      agreed: primaryView(c, id),
      authorExpectedNeeded: c.authorNeeded.includes(id),
    })),
  }));

export const hasAllLabels = (cases: ReadonlyArray<RankingCase>): boolean =>
  cases.every((c) =>
    orderedCandidates(c).every(
      ({ ref }) => A[c.id]?.[ref] !== undefined && B[c.id]?.[ref] !== undefined,
    ),
  );

export const ALL_CASES = [...TUNE_CASES, ...HELDOUT_CASES];
export const labelSources = { A: rawA.source, B: rawB.source };
export { idOf };
