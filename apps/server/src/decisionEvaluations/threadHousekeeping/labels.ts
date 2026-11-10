/** Two blind labelers decide. They must agree on a concrete answer; a split or any `unknown` stays `uncertain`, is reported and is left out of headline figures. */
export const agreed = (a: string | undefined, b: string | undefined): string =>
  a !== undefined && a === b && a !== "unknown" ? a : "uncertain";

export interface LabelFile {
  readonly source: Readonly<Record<string, unknown>>;
  readonly labels: Readonly<Record<string, string>>;
}

export const agreedLabels = (
  a: LabelFile,
  b: LabelFile,
  ids: ReadonlyArray<string>,
): Readonly<Record<string, string>> =>
  Object.fromEntries(ids.map((id) => [id, agreed(a.labels[id], b.labels[id])]));

export const hasAllLabels = (a: LabelFile, b: LabelFile, ids: ReadonlyArray<string>): boolean =>
  ids.every((id) => a.labels[id] !== undefined && b.labels[id] !== undefined);
