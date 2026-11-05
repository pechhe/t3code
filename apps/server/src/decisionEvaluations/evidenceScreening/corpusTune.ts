import { AUTHENTIC } from "./corpusAuthentic.ts";
import type { ScreenCase } from "./corpusTypes.ts";

const SYNTHETIC: ReadonlyArray<ScreenCase> = [
  {
    kind: "claim",
    id: "t-syn-tests-passed",
    split: "tune",
    family: "t-syn-claims",
    stratum: "synthetic",
    tags: [],
    provenance: "written for this pilot",
    claim: "I ran the server tests for the retry change and they all pass.",
    evidence:
      "$ pnpm vp test run src/retry.test.ts\n RUN  v5.0.5\n ✓ src/retry.test.ts (9 tests) 41ms\n Test Files  1 passed (1)\n      Tests  9 passed (9)\n   Duration  1.2s",
  },
  {
    kind: "claim",
    id: "t-syn-tests-not-run",
    split: "tune",
    family: "t-syn-claims",
    stratum: "synthetic",
    tags: ["not-run"],
    provenance: "written for this pilot",
    claim: "Everything is green: typecheck and the unit tests both pass.",
    evidence:
      "$ pnpm vp run typecheck\n tsc --noEmit\n Found 0 errors.\n\n$ pnpm vp test run\n [skipped: tests were not run in this session because the dev database was unavailable]",
  },
  {
    kind: "claim",
    id: "t-syn-truncated",
    split: "tune",
    family: "t-syn-claims",
    stratum: "synthetic",
    tags: ["truncated"],
    provenance: "written for this pilot",
    claim: "The lint run reported no errors.",
    evidence:
      "$ pnpm vp lint\n apps/web/src/a.tsx: ok\n apps/web/src/b.tsx: ok\n apps/web/src/c.tsx: ok\n apps/web/src/d.tsx: ok\n [output truncated after 400 characters]",
  },
  {
    kind: "decision",
    id: "t-d-syn-tentative",
    split: "tune",
    family: "t-d-syn",
    stratum: "synthetic",
    tags: ["agreed-vs-suggested"],
    provenance: "written for this pilot",
    passage:
      "Maybe we should make the session timeout configurable per project. I have not checked whether anyone needs that, so treat it as an idea for now.",
    existing: [],
  },
  {
    kind: "decision",
    id: "t-d-syn-settled",
    split: "tune",
    family: "t-d-syn",
    stratum: "synthetic",
    tags: [],
    provenance: "written for this pilot",
    passage:
      "Decided: exported transcripts include only the messages the requesting user can already read, and an agent may never request an export on another user's behalf.",
    existing: [],
  },
  {
    kind: "decision",
    id: "t-d-syn-routine",
    split: "tune",
    family: "t-d-syn",
    stratum: "synthetic",
    tags: [],
    provenance: "written for this pilot",
    passage: "Fixed a typo in the empty-state message and renamed a local variable for clarity.",
    existing: [],
  },
  {
    kind: "decision",
    id: "t-d-syn-duplicate",
    split: "tune",
    family: "t-d-syn",
    stratum: "synthetic",
    tags: ["duplicate"],
    provenance: "written for this pilot",
    passage:
      "We will keep the audit log append-only: entries are never edited or deleted, only superseded by a later entry.",
    existing: [
      "The audit log is append-only. Entries are never edited or deleted; a correction is a new entry that supersedes the old one.",
      "Default page size is 25 rows.",
    ],
  },
];

export const TUNE_CASES: ReadonlyArray<ScreenCase> = [
  ...AUTHENTIC.filter((c) => c.split === "tune"),
  ...SYNTHETIC,
];
