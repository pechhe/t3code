import type { ResolvedCause, TriageCase, TriageEvidence } from "./corpusTypes.ts";
import raw from "./corpusAuthentic.json" with { type: "json" };

const evidence = raw as unknown as Readonly<Record<string, TriageEvidence>>;

const authentic = (
  slot: string,
  split: TriageCase["split"],
  family: string,
  authorSupported: TriageCase["authorSupported"],
  resolvedCause: ResolvedCause,
): TriageCase => ({
  id: `${split === "tune" ? "t" : "h"}-audit-${slot.slice(5)}`,
  split,
  family,
  stratum: "authentic",
  evidence: evidence[slot]!,
  authorSupported,
  resolvedCause,
});

/** Retained nightly-audit failure records of this repository, extracted by one fixed rule (README). */
export const AUTHENTIC_TUNE: ReadonlyArray<TriageCase> = [
  "2026-10-29",
  "2026-10-30",
  "2026-10-31",
].map((slot) =>
  authentic(slot, "tune", "audit-web-unit-contention", "unknown", {
    label: "environment",
    basis:
      "95571da4a3 (T3-319): web unit files timed out at 15 s behind the browser project's contention on the loaded runner; fixed by ordering the vitest groups, no test changed.",
    confidence: "medium",
  }),
);

export const AUTHENTIC_HELDOUT: ReadonlyArray<TriageCase> = [
  authentic("2026-10-26", "heldout", "audit-merge-and-dependency", "unknown", {
    label: "regression",
    basis:
      "66ffdaf5e5 (SJ-5.19): the 25 Oct upstream merge restored a dropped criterion and failed two migrate-dev-db retention tests (a real regression); the same audit also carried the Playwright 1.64 row-naming break and unrelated runner timeouts, so the failure was multi-cause.",
    confidence: "medium",
  }),
  authentic("2026-10-27", "heldout", "audit-merge-and-dependency", "unknown", {
    label: "regression",
    basis:
      "66ffdaf5e5: two retention tests were a real regression from the upstream merge; the dotted-field test broke on Playwright 1.64 (a fixture assumption). Multi-cause.",
    confidence: "medium",
  }),
  authentic("2026-10-28", "heldout", "audit-mcp-oauth", "unknown", {
    label: "unknown",
    basis:
      "No fix commit or recorded cause was found for the McpOAuth and pairing sign-in failures; they did not recur from 29 Oct. cddac0ccdb (DPoP behind the tunnel) is nearby but unproven to be the cause.",
    confidence: "low",
  }),
  authentic("2026-11-02", "heldout", "audit-saved-usage-clock", "unknown", {
    label: "fixture",
    basis:
      "8c12bfaf41: the test wrote its transcript at a fixed 2026-08-01 and the scan cache drops records older than 92 days, so it failed on every commit from 2026-11-02.",
    confidence: "high",
  }),
  authentic("2026-11-03", "heldout", "audit-saved-usage-clock", "unknown", {
    label: "fixture",
    basis: "8c12bfaf41, as for 2026-11-02. A person recorded this audit's cause as flake.",
    confidence: "high",
  }),
  authentic("2026-11-04", "heldout", "audit-browser-mock-rejection", "unknown", {
    label: "unknown",
    basis:
      "Recorded unresolved by the maintainer; only a server test file changed since the previous audit and no cause has been identified.",
    confidence: "medium",
  }),
];
