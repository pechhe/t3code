import { AUTHENTIC_TUNE } from "./corpusAuthentic.ts";
import type { TriageCase } from "./corpusTypes.ts";

const none = "none supplied";

/** Tuning cases: used to fix the rule and baseline, never scored as evidence. Synthetic ones are deliberately plain. */
export const TUNE_CASES: ReadonlyArray<TriageCase> = [
  ...AUTHENTIC_TUNE,
  {
    id: "t-syn-regression-1",
    split: "tune",
    family: "syn-tune-1",
    stratum: "synthetic",
    authorSupported: "regression",
    resolvedCause: { label: "regression", basis: "Synthetic by construction.", confidence: "high" },
    evidence: {
      check: "vp test run src/orchestration/threadTitle.test.ts",
      exitStatus: "exit 1",
      failingTests: ["threadTitle > trims a title to 80 characters"],
      firstError:
        "AssertionError: expected 'A very long title that keeps going and going until it is cut at the sec' to have length 80, received 72",
      outputTail:
        " FAIL  src/orchestration/threadTitle.test.ts > threadTitle > trims a title to 80 characters\n ❯ src/orchestration/threadTitle.test.ts:41:30\n Test Files  1 failed (1)\n      Tests  1 failed | 6 passed (7)",
      change: "Rewrites trimTitle() in src/orchestration/threadTitle.ts to cut on a word boundary.",
      changedFiles: ["src/orchestration/threadTitle.ts"],
      recentHistory: ["threadTitle.test.ts passed on the previous 30 runs of main"],
      knownFlakeRegistry: none,
    },
  },
  {
    id: "t-syn-fixture-1",
    split: "tune",
    family: "syn-tune-2",
    stratum: "synthetic",
    authorSupported: "fixture",
    resolvedCause: { label: "fixture", basis: "Synthetic by construction.", confidence: "high" },
    evidence: {
      check: "vp test run apps/web/src/components/Sidebar.test.tsx",
      exitStatus: "exit 1",
      failingTests: ["Sidebar > renders the archive entry"],
      firstError:
        'TestingLibraryElementError: Unable to find an accessible element with the role "button" and name "Archive"',
      outputTail:
        'Here are the accessible roles:\n  button:\n  Name "Archived threads":\n  <button aria-label="Archived threads" />\n ❯ Sidebar.test.tsx:58:27',
      change:
        'Intentionally renames the sidebar button label from "Archive" to "Archived threads" in Sidebar.tsx; Sidebar.test.tsx is not in the change.',
      changedFiles: ["apps/web/src/components/Sidebar.tsx"],
      recentHistory: ["Sidebar.test.tsx passed on the previous 30 runs of main"],
      knownFlakeRegistry: none,
    },
  },
  {
    id: "t-syn-environment-1",
    split: "tune",
    family: "syn-tune-3",
    stratum: "synthetic",
    authorSupported: "environment",
    resolvedCause: {
      label: "environment",
      basis: "Synthetic by construction.",
      confidence: "high",
    },
    evidence: {
      check: "pnpm install --frozen-lockfile",
      exitStatus: "exit 1",
      failingTests: [],
      firstError:
        "ERR_PNPM_FETCH_503 GET https://registry.npmjs.org/zod/-/zod-4.1.2.tgz: Service Unavailable - 503 (retried 3 times)",
      outputTail:
        "Progress: resolved 1311, reused 1240, downloaded 61, added 0\nERR_PNPM_FETCH_503 ...\nUpstream registry returned 503 for 4 packages.",
      change: "Edits README.md only.",
      changedFiles: ["README.md"],
      recentHistory: [
        "install passed on the previous run, 40 minutes earlier",
        "a rerun of the identical commit 6 minutes later passed",
      ],
      knownFlakeRegistry: none,
    },
  },
  {
    id: "t-syn-flake-1",
    split: "tune",
    family: "syn-tune-4",
    stratum: "synthetic",
    authorSupported: "known-flake",
    resolvedCause: {
      label: "known-flake",
      basis: "Synthetic by construction.",
      confidence: "high",
    },
    evidence: {
      check: "vp test run src/terminal/TerminalManager.test.ts",
      exitStatus: "exit 1",
      failingTests: ["TerminalManager > emits exit after kill"],
      firstError:
        "Error: Test timed out in 15000ms. If this is a long-running test, pass a timeout value as the last argument or configure it globally with testTimeout.",
      outputTail:
        " FAIL  src/terminal/TerminalManager.test.ts > TerminalManager > emits exit after kill\n Test Files  1 failed (1)\n      Tests  1 failed | 11 passed (12)",
      change: "Changes the wording of an error message in src/web/errors.ts.",
      changedFiles: ["src/web/errors.ts"],
      recentHistory: [
        "a rerun of the identical commit passed",
        "the same test failed identically on 2 of the last 40 runs of main, at different commits",
      ],
      knownFlakeRegistry: [
        "TerminalManager > emits exit after kill: recorded intermittent timeout, Forge #4411, same signature (Test timed out in 15000ms), still open",
      ],
    },
  },
  {
    id: "t-syn-unknown-1",
    split: "tune",
    family: "syn-tune-5",
    stratum: "synthetic",
    authorSupported: "unknown",
    resolvedCause: { label: "unknown", basis: "Synthetic by construction.", confidence: "high" },
    evidence: {
      check: "pnpm run test:landing",
      exitStatus: "exit 1",
      failingTests: [],
      firstError: "",
      outputTail: "[ELIFECYCLE] Command failed with exit code 1.",
      recentHistory: ["no history supplied"],
      knownFlakeRegistry: none,
    },
  },
];
