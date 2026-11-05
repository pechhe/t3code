import type { ExperimentAssignmentReport } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as AgentPolicySettings from "../agents/AgentPolicySettingsService.ts";
import * as ForgeSpecOfThread from "../weave/ForgeSpecOfThread.ts";
import * as WeaveAgentConnections from "../weave/WeaveAgentConnections.ts";
import * as ExperimentResults from "./ExperimentResults.ts";
import * as ExperimentService from "./ExperimentService.ts";
import {
  ENOUGH_PER_VARIANT,
  scoreForgeRecord,
  scoreSample,
  summariseVariants,
  type ForgeRecord,
} from "./ExperimentResults.ts";

const review = (
  id: string,
  recordedAt: string,
  findings: ReadonlyArray<{ readonly ref: string; readonly severity: string }>,
  dispositions: ReadonlyArray<{ readonly findingRef: string; readonly decision: string }> = [],
) => ({
  id,
  kind: "review",
  recordedAt,
  review: { scope: "spec", coverage: "complete", findings },
  dispositions: dispositions.map((d, i) => ({
    ...d,
    decidedAt: `2026-11-0${i + 1}T00:00:00.000Z`,
  })),
});
const landed = (
  operationId: string,
  occurredAt: string,
  repairsOperationId: string | null = null,
) => ({
  operationId,
  repairsOperationId,
  events: [{ event: "published", occurredAt }],
});
const empty: ForgeRecord = { runs: [], notes: [], attempts: [] };
const since = "2026-11-01T00:00:00.000Z";
const now = "2026-11-05T00:00:00.000Z";
const score = (
  record: ForgeRecord,
  overrides: Partial<Parameters<typeof scoreForgeRecord>[0]> = {},
) => scoreForgeRecord({ record, since, now, measuresReviews: true, ...overrides });

describe("scoreForgeRecord", () => {
  it("counts a blocker accepted for a fix and a finding rejected with a reason", () => {
    const result = score({
      ...empty,
      runs: [
        review(
          "run-1",
          "2026-11-02T00:00:00.000Z",
          [
            { ref: "F1", severity: "blocking" },
            { ref: "F2", severity: "blocking" },
            { ref: "F3", severity: "non_blocking" },
          ],
          [
            { findingRef: "F1", decision: "fix" },
            { findingRef: "F3", decision: "reject" },
          ],
        ),
      ],
    });
    expect(result).toMatchObject({ confirmedBlockers: 1, falsePositives: 1 });
    expect(result.sources).toContainEqual({
      measure: "confirmed-blocker",
      origin: "forge-finding",
      reference: "run-1",
      findingRef: "F1",
    });
  });

  it("replaces an earlier disposition with a later one instead of counting both", () => {
    const result = score({
      ...empty,
      runs: [
        review(
          "run-1",
          "2026-11-02T00:00:00.000Z",
          [{ ref: "F1", severity: "blocking" }],
          [
            { findingRef: "F1", decision: "fix" },
            { findingRef: "F1", decision: "reject" },
          ],
        ),
      ],
    });
    expect(result).toMatchObject({ confirmedBlockers: 0, falsePositives: 1 });
  });

  it("treats a complete review with no findings as zero, and no review as unknown", () => {
    expect(
      score({ ...empty, runs: [review("run-1", "2026-11-02T00:00:00.000Z", [])] }),
    ).toMatchObject({
      confirmedBlockers: 0,
      falsePositives: 0,
    });
    expect(score(empty)).toMatchObject({ confirmedBlockers: null, falsePositives: null });
  });

  it("never counts one finding as both found before landing and a problem after it", () => {
    const result = score({
      ...empty,
      attempts: [landed("op-1", "2026-11-03T00:00:00.000Z")],
      runs: [
        review(
          "before",
          "2026-11-02T00:00:00.000Z",
          [{ ref: "F1", severity: "blocking" }],
          [{ findingRef: "F1", decision: "fix" }],
        ),
        review("after", "2026-11-04T00:00:00.000Z", [{ ref: "F2", severity: "blocking" }]),
      ],
    });
    expect(result).toMatchObject({
      confirmedBlockers: 1,
      problemsAfterLanding: 1,
      landingWindowComplete: false,
    });
  });

  it("counts repair landings as problems, ignores those past the window, and marks a full window", () => {
    const result = score(
      {
        ...empty,
        attempts: [
          landed("op-1", "2026-11-03T00:00:00.000Z"),
          landed("op-2", "2026-11-04T00:00:00.000Z", "op-1"),
          landed("op-3", "2026-12-20T00:00:00.000Z", "op-1"),
        ],
      },
      { now: "2026-12-25T00:00:00.000Z" },
    );
    expect(result).toMatchObject({ problemsAfterLanding: 1, landingWindowComplete: true });
  });

  it("leaves problems after landing unknown before the work lands", () => {
    expect(score(empty)).toMatchObject({ problemsAfterLanding: null, landingWindowComplete: null });
  });

  it("ignores reviews of another scope and evidence from before the sample enrolled", () => {
    const record: ForgeRecord = {
      ...empty,
      runs: [review("old", "2026-10-30T00:00:00.000Z", [{ ref: "F1", severity: "blocking" }])],
      notes: [{ id: "n", specId: "s", kind: "send_back", raisedAt: "2026-10-30T00:00:00.000Z" }],
    };
    expect(score(record)).toMatchObject({ confirmedBlockers: null, sentBack: 0 });
    expect(
      score(
        { ...empty, runs: [review("run", "2026-11-02T00:00:00.000Z", [])] },
        { reviewScope: "change" },
      ),
    ).toMatchObject({ confirmedBlockers: null });
  });

  it("counts Henry's send-backs but not other notes", () => {
    const result = score({
      ...empty,
      notes: [
        { id: "n1", specId: "s", kind: "send_back", raisedAt: "2026-11-02T00:00:00.000Z" },
        { id: "n2", specId: "s", kind: "decision", raisedAt: "2026-11-02T00:00:00.000Z" },
      ],
    });
    expect(result.sentBack).toBe(1);
  });
});

const usage = {
  status: "complete",
  inputTokens: 100,
  outputTokens: 50,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  reasoningTokens: 0,
  missingTurns: 0,
  partialTurns: 0,
  hasUnattributedSubagentUsage: false,
} as const;
const entry = (
  assignment: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): ExperimentAssignmentReport =>
  ({
    assignment: {
      id: "a",
      lever: "delegation",
      unitKind: "task",
      threadId: "child",
      assignedAt: since,
      assignmentMethod: "randomized",
      variant: { id: "A", label: "A" },
      ...assignment,
    },
    runs: [],
    outcomes: [],
    usage,
    projectionAvailable: true,
    missingThreadIds: [],
    telemetryTruncated: false,
    ...overrides,
  }) as unknown as ExperimentAssignmentReport;
const run = (threadId: string, runId: string, requestedAt: string) => ({
  threadId,
  runId,
  requestedAt,
});

describe("scoreSample", () => {
  it("charges a helper its own further rounds, and no Spec-level finding", () => {
    const result = scoreSample({
      entry: entry(
        {},
        {
          runs: [
            run("child", "r1", "2026-11-02T00:00:00.000Z"),
            run("child", "r2", "2026-11-02T01:00:00.000Z"),
            run("child", "r3", "2026-11-02T02:00:00.000Z"),
          ],
        },
      ),
      specId: "spec",
      record: {
        ...empty,
        runs: [review("run", "2026-11-03T00:00:00.000Z", [{ ref: "F1", severity: "blocking" }])],
      },
      now,
    });
    expect(result).toMatchObject({
      tokens: 150,
      sentBack: 2,
      confirmedBlockers: null,
      falsePositives: null,
      problemsAfterLanding: null,
    });
    expect(result.sources.map((source) => source.reference)).toEqual(["r2", "r3"]);
  });

  it("counts the helpers a delivery lead actually started", () => {
    const result = scoreSample({
      entry: entry(
        { lever: "orchestration-policy", unitKind: "thread", threadId: "lead" },
        {
          runs: [
            run("lead", "r1", "2026-11-02T00:00:00.000Z"),
            run("h1", "r2", "2026-11-02T01:00:00.000Z"),
            run("h1", "r3", "2026-11-02T02:00:00.000Z"),
            run("h2", "r4", "2026-11-02T03:00:00.000Z"),
          ],
        },
      ),
      specId: null,
      record: null,
      now,
    });
    expect(result.delegatedHelpers).toBe(2);
  });

  it("does not count a replacement lead of the same delivery as a helper", () => {
    const result = scoreSample({
      entry: entry(
        {
          lever: "orchestration-policy",
          unitKind: "thread",
          unitId: "delivery:7",
          threadId: "lead",
        },
        {
          rootThreadIds: ["lead", "replacement"],
          runs: [
            run("lead", "r1", "2026-11-02T00:00:00.000Z"),
            run("replacement", "r2", "2026-11-02T01:00:00.000Z"),
          ],
        },
      ),
      specId: null,
      record: null,
      now,
    });
    expect(result.delegatedHelpers).toBe(0);
  });

  it("labels hand-entered results when Forge cannot say", () => {
    const result = scoreSample({
      entry: entry({ lever: "reviewer" }, { outcomes: [{ id: "o1", kind: "validated-finding" }] }),
      specId: null,
      record: null,
      now,
    });
    expect(result.confirmedBlockers).toBe(1);
    expect(result.sources).toEqual([
      { measure: "confirmed-blocker", origin: "hand", reference: "o1" },
    ]);
  });

  it("leaves a helper's rounds and tokens unknown when its runs are incomplete", () => {
    const rounds = [
      run("child", "r1", "2026-11-02T00:00:00.000Z"),
      run("child", "r2", "2026-11-02T01:00:00.000Z"),
    ];
    for (const overrides of [
      { projectionAvailable: false },
      { missingThreadIds: ["replacement"] },
      { telemetryTruncated: true },
    ])
      expect(
        scoreSample({
          entry: entry({}, { runs: rounds, ...overrides }),
          specId: null,
          record: null,
          now,
        }).sentBack,
      ).toBeNull();
    expect(
      scoreSample({
        entry: entry({}, { usage: { ...usage, status: "partial" } }),
        specId: null,
        record: null,
        now,
      }).tokens,
    ).toBeNull();
  });

  it("shows unknown tokens when usage is unavailable", () => {
    const result = scoreSample({
      entry: entry({}, { usage: { ...usage, status: "unavailable" } }),
      specId: null,
      record: null,
      now,
    });
    expect(result.tokens).toBeNull();
  });
});

describe("summariseVariants", () => {
  const sample = (variantId: string, confirmedBlockers: number | null) =>
    ({
      assignmentId: `a-${variantId}-${confirmedBlockers}`,
      variantId,
      threadId: null,
      specId: null,
      tokens: null,
      confirmedBlockers,
      falsePositives: null,
      sentBack: null,
      problemsAfterLanding: null,
      landingWindowComplete: null,
      delegatedHelpers: null,
      sources: [],
    }) as const;
  const experiment = {
    variants: [
      { id: "A", label: "A" },
      { id: "B", label: "B" },
    ],
  };

  it("keeps every enrolled sample in the denominator and sums only what it knows", () => {
    const [a, b] = summariseVariants(experiment, [
      sample("A", 2),
      sample("A", null),
      sample("A", 1),
      sample("B", null),
    ]);
    expect(a).toMatchObject({ enrolled: 3, confirmedBlockers: { value: 3, covered: 2 } });
    expect(b).toMatchObject({ enrolled: 1, confirmedBlockers: { value: null, covered: 0 } });
  });

  it("stops warning once a variant has enough results", () => {
    const enough = Array.from({ length: ENOUGH_PER_VARIANT }, () => sample("A", 0));
    const [a, b] = summariseVariants(experiment, [...enough, sample("B", 0)]);
    expect(a?.tooFewResults).toBe(false);
    expect(b?.tooFewResults).toBe(true);
  });
});

const experimentOf = (variants: ReadonlyArray<Record<string, unknown>>, overrides = {}) =>
  ({
    id: "trial",
    lever: "reviewer",
    status: "running",
    variants,
    eligibility: {
      projectIds: [],
      models: [],
      taskCategories: [],
      agentRoles: ["reviewer"],
      reviewScopes: ["spec"],
    },
    ...overrides,
  }) as never;
const sol = {
  instanceId: "codex",
  model: "gpt-6-sol",
  options: [{ id: "reasoningEffort", value: "high" }],
};

const servicesLayer = (input: {
  readonly observe: (tool: string, args: Record<string, unknown>) => unknown;
  readonly saved: Array<unknown>;
  readonly adopted: Array<unknown>;
  readonly experiment?: unknown;
}) =>
  ExperimentResults.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ExperimentService.ExperimentService)({
          report: () =>
            Effect.succeed({
              experiment: input.experiment ?? experimentOf([{ id: "A", label: "A" }]),
              assignments: [entry({ lever: "reviewer", agentTask: { review: { scope: "spec" } } })],
              hasMore: false,
            } as never),
          list: () => Effect.succeed([input.experiment] as never),
          recordAdoption: (adoption) => {
            input.adopted.push(adoption);
            return Effect.succeed(input.experiment as never);
          },
        }),
        Layer.mock(ForgeSpecOfThread.ForgeSpecOfThread)({
          of: () =>
            Effect.succeedSome({
              specId: "spec",
              project: null,
              origin: "weave",
              leadThreadId: "lead" as never,
            }),
        }),
        Layer.mock(WeaveAgentConnections.WeaveAgentConnections)({
          observe: (tool, args) =>
            Effect.try({
              try: () => ({ origin: "weave", connection: "c", value: input.observe(tool, args) }),
              catch: () => new WeaveAgentConnections.WeaveObserveError({ reason: "unavailable" }),
            }),
        }),
        Layer.mock(AgentPolicySettings.AgentPolicySettingsService)({
          read: () =>
            Effect.succeed({
              snapshot: {
                hash: "h",
                manifest: {
                  models: {
                    sol: { model: "gpt-6-sol", effortOption: "reasoningEffort" },
                    luna: { model: "gpt-6-luna", effortOption: "reasoningEffort" },
                  },
                  lists: {
                    spec: [
                      { model: "luna", effort: "medium" },
                      { model: "sol", effort: "low" },
                    ],
                  },
                  roles: { reviewer: { list: "change", specList: "spec" } },
                },
              },
            } as never),
          save: (edit) => {
            input.saved.push(edit);
            return Effect.succeed({} as never);
          },
        }),
      ),
    ),
  );
const pageOf = (items: ReadonlyArray<unknown>) => ({ items, hasMore: false, nextOffset: null });

describe("ExperimentResults", () => {
  it.effect("reads a run too large for a page in chunks, and scores it", () => {
    const whole = review(
      "big",
      "2026-11-02T00:00:00.000Z",
      [{ ref: "F1", severity: "blocking" }],
      [{ findingRef: "F1", decision: "fix" }],
    );
    const text = JSON.stringify(whole);
    return Effect.gen(function* () {
      const service = yield* ExperimentResults.ExperimentResults;
      const results = yield* service.results({ experimentId: "trial" });
      expect(results.forgeReadable).toBe(true);
      expect(results.variants[0]?.confirmedBlockers).toEqual({ value: 1, covered: 1 });
      expect(results.samples[0]?.specId).toBe("spec");
    }).pipe(
      Effect.provide(
        servicesLayer({
          saved: [],
          adopted: [],
          observe: (tool, args) => {
            if (tool === "weave_forge_attempts") return [];
            if (tool === "weave_forge_agent_notes") return { items: [] };
            if (args.entry === undefined) return pageOf([{ index: 0, bytes: 99999, id: "big" }]);
            return args.cursor === undefined
              ? { content: text.slice(0, 10), nextCursor: "next" }
              : { content: text.slice(10), nextCursor: null };
          },
        }),
      ),
    );
  });

  it.effect("shows results as unknown when Forge cannot be read", () =>
    Effect.gen(function* () {
      const service = yield* ExperimentResults.ExperimentResults;
      const results = yield* service.results({ experimentId: "trial" });
      expect(results.forgeReadable).toBe(false);
      expect(results.variants[0]?.confirmedBlockers).toEqual({ value: null, covered: 0 });
      expect(results.variants[0]?.enrolled).toBe(1);
    }).pipe(
      Effect.provide(
        servicesLayer({
          saved: [],
          adopted: [],
          observe: () => {
            throw new Error("down");
          },
        }),
      ),
    ),
  );

  it.effect("makes a model variant first on the job's list, then stops the trial", () => {
    const saved: Array<{ manifest: { lists: Record<string, unknown> } }> = [];
    const adopted: Array<unknown> = [];
    const experiment = experimentOf([
      { id: "A", label: "A" },
      { id: "B", label: "B", modelSelection: sol },
    ]);
    return Effect.gen(function* () {
      const service = yield* ExperimentResults.ExperimentResults;
      const adoption = yield* service.adopt({ experimentId: "trial", variantId: "B" });
      expect(adoption.applied).toBe("delegation-setting");
      expect(saved[0]?.manifest.lists.spec).toEqual([
        { model: "sol", effort: "high" },
        { model: "luna", effort: "medium" },
      ]);
      expect(adopted).toEqual([{ experimentId: "trial", variantId: "B" }]);
    }).pipe(
      Effect.provide(
        servicesLayer({ saved: saved as never, adopted, observe: () => null, experiment }),
      ),
    );
  });

  it.effect("records added text as the winner and says what to land, changing no setting", () => {
    const saved: Array<unknown> = [];
    const experiment = experimentOf(
      [
        {
          id: "B",
          label: "B",
          instructions: { sourcePath: "skills/lead/SKILL.md", text: "x" },
        },
      ],
      { lever: "instruction" },
    );
    return Effect.gen(function* () {
      const service = yield* ExperimentResults.ExperimentResults;
      const adoption = yield* service.adopt({ experimentId: "trial", variantId: "B" });
      expect(adoption.applied).toBe("recorded");
      expect(adoption.nextStep).toContain("skills/lead/SKILL.md");
      expect(saved).toEqual([]);
    }).pipe(Effect.provide(servicesLayer({ saved, adopted: [], observe: () => null, experiment })));
  });

  it.effect("leaves the trial running when the setting cannot change", () => {
    const adopted: Array<unknown> = [];
    const experiment = experimentOf([
      { id: "B", label: "B", modelSelection: { ...sol, model: "not-in-delegation" } },
    ]);
    return Effect.gen(function* () {
      const service = yield* ExperimentResults.ExperimentResults;
      const refused = yield* Effect.flip(service.adopt({ experimentId: "trial", variantId: "B" }));
      expect(refused.detail).toContain("not-in-delegation");
      expect(adopted).toEqual([]);
    }).pipe(Effect.provide(servicesLayer({ saved: [], adopted, observe: () => null, experiment })));
  });
});
