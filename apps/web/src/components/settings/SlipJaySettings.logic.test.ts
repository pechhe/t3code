import type { SlipJayLandingCheck, VcsSlipJayProjectSettings } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  describePolicyOutcome,
  describePolicyProgress,
  formatLandingCheck,
  parseLandingChecks,
  policyDraft,
  policyPatch,
} from "./SlipJaySettings.logic";

const settings = (checks: SlipJayLandingCheck[]): VcsSlipJayProjectSettings => ({
  integrationBranch: "main",
  revision: "a".repeat(40),
  spares: 2,
  process: "standard",
  requiredLandingVerification: checks,
  releaseBranch: null,
  sharedPaths: [],
  generatedPaths: [],
  tracker: "github",
  machineSpares: { machineLimit: null, effective: 2 },
});

describe("landing checks as shell lines", () => {
  it.each<{ label: string; check: SlipJayLandingCheck; line: string }>([
    {
      label: "a plain command",
      check: { executable: "pnpm", args: ["exec", "vp", "check"] },
      line: "pnpm exec vp check",
    },
    {
      label: "a directory and concurrency",
      check: { executable: "pnpm", args: ["test"], cwd: "apps/server", concurrent: true },
      line: "cd apps/server && pnpm test &",
    },
    {
      label: "arguments needing quotes",
      check: { executable: "sh", args: ["-c", "echo it's done"] },
      line: `sh -c 'echo it'\\''s done'`,
    },
    {
      label: "a line break in an argument",
      check: { executable: "sh", args: ["-c", "echo a\nprintf 'b'"] },
      line: `sh -c $'echo a\\nprintf \\'b\\''`,
    },
    {
      label: "an argument that looks like an operator",
      check: { executable: "grep", args: ["-E", "a|b", "|"] },
      line: `grep -E 'a|b' '|'`,
    },
  ])("round-trips $label", ({ check, line }) => {
    expect(formatLandingCheck(check)).toBe(line);
    expect(parseLandingChecks(line)).toEqual({ checks: [check] });
  });

  it("reads double quotes, escapes and blank lines", () => {
    expect(parseLandingChecks('\n  echo "a \\"b\\"" c\\ d  \n\n')).toEqual({
      checks: [{ executable: "echo", args: ['a "b"', "c d"] }],
    });
  });

  it.each([
    ["echo 'open", "Line 1 has an unclosed quote."],
    ["cd apps", "Line 1: write a directory as `cd <dir> && <command>`."],
    ["pnpm a | grep b", "Line 1: each line is one command run without a shell"],
    ["true\n&", "Line 2 has no command."],
  ])("explains why %j cannot be saved", (text, message) => {
    const parsed = parseLandingChecks(text);
    expect("error" in parsed && parsed.error).toContain(message);
  });
});

describe("policyPatch", () => {
  const current = settings([{ executable: "pnpm", args: ["test"] }]);

  it("holds only the fields the draft changed", () => {
    expect(policyPatch(current, policyDraft(current))).toEqual({ patch: {} });
    expect(policyPatch(current, { ...policyDraft(current), process: "light" })).toEqual({
      patch: { process: "light" },
    });
    expect(
      policyPatch(current, { ...policyDraft(current), spares: 4, checksText: "pnpm lint" }),
    ).toEqual({
      patch: { spares: 4, requiredLandingVerification: [{ executable: "pnpm", args: ["lint"] }] },
    });
  });

  it("keeps settings a line cannot show when another check changes", () => {
    const gated = {
      executable: "pnpm",
      args: ["e2e"],
      baseline: { inputs: ["apps/web"] },
      capability: { id: "browser" },
    };
    const withSettings = settings([gated, { executable: "pnpm", args: ["test"] }]);
    const lines = policyDraft(withSettings).checksText.split("\n");
    expect(
      policyPatch(withSettings, {
        ...policyDraft(withSettings),
        checksText: ["pnpm lint", lines[0]].join("\n"),
      }),
    ).toEqual({
      patch: { requiredLandingVerification: [{ executable: "pnpm", args: ["lint"] }, gated] },
    });
  });

  it("reports an unreadable check instead of a patch", () => {
    expect(policyPatch(current, { ...policyDraft(current), checksText: "x 'y" })).toEqual({
      error: "Line 1 has an unclosed quote.",
    });
  });
});

describe("describePolicyOutcome", () => {
  it("treats a refusal as an error and an unknown phase as one to follow", () => {
    expect(describePolicyOutcome({ phase: "refused", revision: null, reason: "stale" })).toEqual({
      tone: "error",
      message: "Not saved: stale",
    });
    expect(describePolicyOutcome({ phase: "uncertain", revision: null, reason: null }).tone).toBe(
      "warning",
    );
  });
});

describe("describePolicyProgress", () => {
  const operation = {
    operationId: "op_1",
    kind: "landing",
    repo: "pechhe/splay",
    submittedBy: "mac:sp-3",
  };

  it("follows the operation from the queue to landing", () => {
    expect(describePolicyProgress(undefined)).toBe("Waiting for the runner to land it…");
    expect(
      describePolicyProgress({ ...operation, status: "queued", stage: "queued", position: 3 }),
    ).toBe("Queued: 2 ahead of it in the runner.");
    expect(
      describePolicyProgress({ ...operation, status: "queued", stage: "queued", position: 1 }),
    ).toBe("Queued: the runner takes it next.");
    expect(describePolicyProgress({ ...operation, status: "queued", stage: "paused" })).toBe(
      "Queued: the runner is paused for every machine.",
    );
    expect(describePolicyProgress({ ...operation, status: "running", stage: "integrating" })).toBe(
      "Landing: integrating…",
    );
  });
});
