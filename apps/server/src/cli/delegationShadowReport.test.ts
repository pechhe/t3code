import { describe, expect, it } from "@effect/vitest";

import {
  formatShadowReport,
  scoreShadow,
  type ShadowRow,
  type TaskOutcome,
} from "./delegationShadowReport.ts";

const row = (threadId: string, fields: Partial<ShadowRow> = {}): ShadowRow => ({
  threadId,
  role: "implementer",
  status: "recommended",
  eligible: ["cheap", "mid", "dear"],
  chosen: "mid",
  pick: "mid",
  reassigned: false,
  ...fields,
});
const price: Record<string, number> = { cheap: 1, mid: 2, dear: 3 };
const priceOf = (model: string) => price[model] ?? null;

describe("scoreShadow", () => {
  it("separates agreement, cheaper and dearer picks and measures each group's tasks", () => {
    const outcomes: Record<string, TaskOutcome> = {
      a: { runs: 1, lastRunStatus: "completed", tokens: 100 },
      b: { runs: 2, lastRunStatus: "failed", tokens: 300 },
      c: { runs: 1, lastRunStatus: "completed", tokens: 50 },
      d: { runs: 1, lastRunStatus: "running", tokens: null },
    };
    const [score] = scoreShadow(
      [
        row("a"),
        row("b", { pick: "cheap" }),
        row("c", { pick: "dear" }),
        row("d", { pick: "cheap" }),
        row("e", { status: "abstained", pick: "cheap" }),
        row("f", { status: "failed", pick: null }),
        row("g", { status: "sole-model", eligible: ["mid"] }),
        row("h", { reassigned: true, pick: "cheap" }),
      ],
      (id) => outcomes[id],
      priceOf,
    );
    expect(score).toMatchObject({
      delegations: 8,
      reassigned: 1,
      recommended: 4,
      abstained: 1,
      failed: 1,
      soleModel: 1,
      agreed: 1,
    });
    expect(score!.groups.cheaper).toMatchObject({
      delegations: 2,
      meanTokens: 300,
      tokensUnknown: 1,
      furtherRuns: 1,
      failedOrCancelled: 1,
      stillOpen: 1,
    });
    expect(score!.groups.dearer.meanTokens).toBe(50);
  });

  it("reports unknown outcomes and prices as unknown, never zero", () => {
    const [score] = scoreShadow(
      [row("a", { pick: "cheap" }), row("b", { pick: "unlisted" })],
      () => undefined,
      priceOf,
    );
    expect(score!.groups.cheaper).toMatchObject({
      delegations: 1,
      meanTokens: null,
      tokensUnknown: 1,
      furtherRuns: 0,
      furtherRunsUnknown: 1,
      failedOrCancelled: 0,
      endingUnknown: 1,
    });
    expect(score!.groups.unpriced.delegations).toBe(1);
    const text = formatShadowReport([score!], "since then");
    expect(text).toContain("mean tokens unknown (1 unknown)");
    expect(text).toContain("further runs 0 (1 unknown)");
  });
});
