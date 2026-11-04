import { HELDOUT_CASES } from "./corpusHeldout.ts";
import { TUNE_CASES } from "./corpusTune.ts";
import type { Reference } from "./corpusTypes.ts";
import raw from "./results/heldout-labels.json" with { type: "json" };

type Labels = Readonly<Record<string, Reference>>;
const A = raw.A as Labels;
const B = raw.B as Labels;

/** Two blind labelers decide; the author's reading only breaks a split between them; a three-way split is uncertain. */
export const adjudicate = (author: Reference, a: Reference, b: Reference): Reference =>
  a === b ? a : author === a || author === b ? author : "uncertain";

/** The label the supplied evidence supports. Tuning cases carry only the author's reading. */
export const supportedLabel = (id: string): Reference => {
  const tune = TUNE_CASES.find((c) => c.id === id);
  if (tune) return tune.authorSupported;
  const held = HELDOUT_CASES.find((c) => c.id === id);
  const a = A[id];
  const b = B[id];
  if (held === undefined || a === undefined || b === undefined)
    throw new Error(`No supported label for ${id}`);
  return adjudicate(held.authorSupported, a, b);
};

export const labelAudit = () =>
  HELDOUT_CASES.map((c) => ({
    id: c.id,
    stratum: c.stratum,
    author: c.authorSupported,
    A: A[c.id]!,
    B: B[c.id]!,
    supported: supportedLabel(c.id),
    resolved: c.resolvedCause.label,
  }));

const heldoutLabel = (labels: Labels) => (id: string) => {
  const label = labels[id];
  if (label === undefined) throw new Error(`No held-out label for ${id}`);
  return label;
};

/** Alternative reference views over the held-out cases only; the adjudicated view is the primary one. */
export const labelViews: Readonly<Record<string, (id: string) => Reference>> = {
  adjudicated: supportedLabel,
  agreementOnly: (id) => {
    const a = heldoutLabel(A)(id);
    return a === heldoutLabel(B)(id) ? a : "uncertain";
  },
  labelerA: heldoutLabel(A),
  labelerB: heldoutLabel(B),
};
