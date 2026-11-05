import type { CallRecord, Engine } from "./harness.ts";

export interface RunIdentity {
  readonly split: string;
  readonly engines: ReadonlyArray<Engine>;
  readonly corpusDigest: string;
  /** sha256 of every file that decides what is asked or how it is called. */
  readonly files: Readonly<Record<string, string>>;
  readonly checkout: unknown;
  readonly runtime: unknown;
}

export const headerLine = (identity: RunIdentity): string =>
  `${JSON.stringify({ kind: "identity", identity })}\n`;

export const recordLine = (record: CallRecord): string => `${JSON.stringify(record)}\n`;

/**
 * A log is resumable only by the run that began it: the same split, engines, corpus and asking files.
 * Anything else would report old answers under a new identity, so it is refused before any record is reused.
 */
export const parseAttemptLog = (
  text: string,
  expected: Pick<RunIdentity, "split" | "engines" | "corpusDigest" | "files">,
): { readonly identity: RunIdentity; readonly records: ReadonlyArray<CallRecord> } => {
  const [first, ...rest] = text.split("\n").filter(Boolean);
  if (first === undefined) throw new Error("Cannot resume: the attempt log is empty");
  const head = JSON.parse(first) as { kind?: string; identity?: RunIdentity };
  if (head.kind !== "identity" || head.identity === undefined)
    throw new Error("Cannot resume: the attempt log has no identity header");
  const identity = head.identity;
  if (identity.split !== expected.split || identity.engines.join() !== expected.engines.join())
    throw new Error("Cannot resume: the attempt log is for a different split or engines");
  if (identity.corpusDigest !== expected.corpusDigest)
    throw new Error("Cannot resume: the corpus changed since the attempt log began");
  const changed = Object.keys({ ...identity.files, ...expected.files }).filter(
    (f) => identity.files[f] !== expected.files[f],
  );
  if (changed.length > 0)
    throw new Error(
      `Cannot resume: run files changed since the attempt log began: ${changed.join(", ")}`,
    );
  return { identity, records: rest.map((l) => JSON.parse(l) as CallRecord) };
};
