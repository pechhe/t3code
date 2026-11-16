import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ProjectId } from "./baseSchemas.ts";
import {
  championProposalResult,
  championProposalRetiring,
  ChampionLearningRevision,
} from "./champions.ts";

const encodeRevision = Schema.encodeSync(Schema.fromJsonString(ChampionLearningRevision));
const decodeRevision = Schema.decodeSync(Schema.fromJsonString(ChampionLearningRevision));

describe("championProposalRetiring", () => {
  const accepted = [{ id: "errors" }, { id: "latency" }, { id: "crashes" }];

  it("names only the accepted metrics a proposal retires, never the ones it omits", () => {
    const proposal = { metrics: [{ id: "errors" }, { id: "uptime" }], retires: ["latency"] };
    expect(championProposalRetiring(accepted, proposal)).toEqual([{ id: "latency" }]);
    expect(championProposalResult(accepted, proposal).map((m) => m.id)).toEqual([
      "errors",
      "crashes",
      "uptime",
    ]);
    expect(championProposalRetiring(accepted, { metrics: [{ id: "uptime" }] })).toEqual([]);
  });
});

describe("ChampionLearningRevision", () => {
  it("reads a contribution recorded under a writer role that has since merged", () => {
    const recorded = encodeRevision({
      id: "3f7d1c1e-0f5c-4c6f-9d1e-0b2a8c4e5d61",
      learningId: "t3-532-tool-name-listing-cost",
      championId: "roster-process-effectiveness",
      projectId: ProjectId.make("5da0e0ee-b76a-42c3-87bd-71fca5ed070c"),
      recordedAt: "2026-11-09T19:45:55.927Z",
      supersedes: null,
      reason: "A delegated worker measured it.",
      topic: "Delegated worker first-turn tool listing",
      plainSummary: "A delegated worker lists every editor tool by name.",
      question: "How large is a delegated worker's first turn?",
      conclusion: "About 2,100 tokens go on tool names.",
      attempts: [],
      evidence: [
        {
          source: "worker thread",
          evidence: "138 tool names, about 2,100 tokens",
          observedAt: "2026-11-09T19:46:00Z",
        },
      ],
      components: [],
      environment: "T3 server with two agent permission classes.",
      applicability: "Delegated Claude workers.",
      tradeoffs: "About 13% more on the first turn.",
      reviewAt: null,
      reviewConditions: ["The editor tool count changes."],
      versionConditions: [],
      applicabilityState: "current",
      isCurrent: true,
    });
    // Written before the writing roles merged into `implementer`; the row is still stored that way.
    const stored = {
      ...(JSON.parse(recorded) as Record<string, unknown>),
      contribution: {
        environmentId: null,
        environmentLabel: null,
        linkSessionId: null,
        threadId: "thread:delegated-task:t3-532-live-claude-worker-2",
        threadTitle: "UI worker · Live permission check for Forge T3-532",
        role: "ui-worker",
      },
    };
    expect(decodeRevision(JSON.stringify(stored)).contribution?.role).toBe("implementer");
  });
});
