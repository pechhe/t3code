import { describe, expect, it } from "vite-plus/test";

import {
  championFolderPath,
  parseChampionFolder,
  renderChampionFolder,
  type ChampionFolder,
  type ChampionFolderReading,
} from "./championFolderCodec.ts";

const reading = (overrides: Partial<ChampionFolderReading> = {}): ChampionFolderReading => ({
  metricId: "days-worse-than-dayjob",
  version: 1,
  unit: "days",
  status: "measured",
  value: 8,
  observedAt: "2026-11-20T20:01:14.382Z",
  collectedAt: "2026-11-20T20:02:00.000Z",
  source: "SCORECARD.md",
  evidence: "8 of 38",
  revision: null,
  provenance: "server-collected",
  ...overrides,
});

const folder = (): ChampionFolder => ({
  definition: {
    id: "roster-plan-quality" as never,
    name: "Plan Quality" as never,
    purpose: "Keep plans good" as never,
    repository: "pechhe/yardsmith",
    runner: { environmentId: "5f6dcc76-b8ca-45bc-8fe1-973823ba5b60", label: "peach-box-old" },
    lifecycle: "active",
    schedule: { type: "fixed_time", timeOfDay: "07:20" } as never,
    charter: {
      maxConcurrentRepairs: 1,
      maxRepairsPerDay: 1,
      instructions: "Henry wants improvement.\n\nMeasure honestly: unknown, never zero.",
    } as never,
    whenInTarget: "rest",
  },
  metrics: [
    {
      id: "days-worse-than-dayjob",
      name: "Days worse",
      description: "How many days Generate loses",
      unit: "days",
      source: "SCORECARD.md",
      context: "Starting reading 8 of 38",
      direction: "lower",
      minimum: null,
      maximum: 8,
      collect: ["cat", "SCORECARD.md"],
      version: 1,
      seriesId: "days-worse-than-dayjob",
      reason: "setup",
    } as never,
  ],
  learnings: [
    {
      learningId: "engine-noise",
      recordedAt: "2026-11-19T10:00:00.000Z",
      reason: "first record",
      topic: "Engine noise",
      question: "How noisy is a re-run?",
      conclusion: "About two days either way.\n\n- keep the control run",
      attempts: [{ attemptId: "a1", outcome: "improved", evidence: "ran twice: same: result" }],
      evidence: [
        { source: "SCORECARD.md", evidence: "8 of 38", observedAt: "2026-11-19T09:00:00.000Z" },
      ],
      components: [],
      environment: "peach-box",
      applicability: "planning-engine 0.3.x",
      tradeoffs: "cost: 4 minutes",
      reviewAt: null,
      reviewConditions: ["engine bump"],
      versionConditions: [],
    },
  ],
  findings: [
    {
      id: "engine-knowledge:behind:0.3.91",
      metricId: "days-worse-than-dayjob",
      seriesId: null,
      title: "Engine knowledge is behind",
      evidence: "CURRENT_STATE.md is older than the bump.",
      status: "open",
      workId: "w1",
      attemptId: "att1",
      revision: null,
      specUrl: null,
      updatedAt: "2026-11-20T20:01:14.382Z",
      carriedOver: { from: "old-id", at: "2026-11-21T00:00:00.000Z" },
    } as never,
  ],
  readings: [reading(), reading({ observedAt: "2026-11-21T20:01:14.382Z", value: 7 })],
});

const fileMap = (files: ReadonlyArray<{ path: string; content: string }>) =>
  new Map(files.map((file) => [file.path, file.content]));

describe("championFolderCodec", () => {
  it("computes the folder path", () => {
    expect(championFolderPath("roster", "plan")).toBe("champions/roster/plan");
  });

  it("round-trips a full folder and renders it byte-identically", () => {
    const input = folder();
    const files = renderChampionFolder(input);
    expect(renderChampionFolder(input)).toEqual(files);
    for (const file of files) expect(file.content.endsWith("\n")).toBe(true);

    const parsed = parseChampionFolder(files);
    expect(parsed.problems).toEqual([]);
    expect(parsed.definition).toEqual(input.definition);
    expect(parsed.metrics).toEqual(input.metrics);
    expect(parsed.learnings).toEqual(input.learnings);
    expect(parsed.findings).toEqual(input.findings);
    expect(parsed.readings).toEqual(input.readings);
  });

  it("reads a hand-edited learning's body and frontmatter", () => {
    const files = renderChampionFolder(folder()).map((file) =>
      file.path === "learnings/engine-noise.md"
        ? {
            path: file.path,
            content: file.content
              .replace("About two days either way.", "Three days either way.")
              .replace("peach-box", "boat-vm"),
          }
        : file,
    );
    const [learning] = parseChampionFolder(files).learnings;
    expect(learning?.conclusion).toContain("Three days either way.");
    expect(learning?.environment).toBe("boat-vm");
  });

  it("reports a broken learning and still parses the rest", () => {
    const files = [
      ...renderChampionFolder(folder()),
      { path: "learnings/broken.md", content: "no frontmatter here" },
      {
        path: "learnings/mismatch.md",
        content: renderChampionFolder(folder()).find((f) => f.path.startsWith("learnings/"))!
          .content,
      },
    ];
    const parsed = parseChampionFolder(files);
    expect(parsed.problems.some((p) => p.startsWith("learnings/broken.md: "))).toBe(true);
    expect(parsed.problems.some((p) => p.startsWith("learnings/mismatch.md: "))).toBe(true);
    expect(parsed.learnings.map((l) => l.learningId)).toEqual(["engine-noise"]);
    expect(parsed.definition).not.toBeNull();
    expect(parsed.findings).toHaveLength(1);
  });

  it("gives a null definition and a problem for a missing or invalid champion.md", () => {
    const rest = renderChampionFolder(folder()).filter((file) => file.path !== "champion.md");
    const missing = parseChampionFolder(rest);
    expect(missing.definition).toBeNull();
    expect(missing.problems.some((p) => p.startsWith("champion.md"))).toBe(true);

    const invalid = parseChampionFolder([
      { path: "champion.md", content: "---\nid: x\nlifecycle: nope\n---\n\nbody\n" },
      ...rest,
    ]);
    expect(invalid.definition).toBeNull();
    expect(invalid.problems.some((p) => p.startsWith("champion.md: "))).toBe(true);
    expect(invalid.metrics).not.toBeNull();
  });

  it("gives null metrics for a broken metrics.json", () => {
    const parsed = parseChampionFolder([{ path: "metrics.json", content: "{" }]);
    expect(parsed.metrics).toBeNull();
    expect(parsed.problems.some((p) => p.startsWith("metrics.json: "))).toBe(true);
  });

  it("dedupes and sorts readings", () => {
    const later = reading({ observedAt: "2026-11-22T00:00:00.000Z" });
    const earlier = reading({ observedAt: "2026-11-19T00:00:00.000Z" });
    const input = { ...folder(), readings: [later, earlier, later, { ...later }] };
    const files = fileMap(renderChampionFolder(input));
    const lines = files.get("readings/days-worse-than-dayjob.jsonl")!.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).observedAt).toBe(earlier.observedAt);
    expect(parseChampionFolder(renderChampionFolder(input)).readings).toEqual([earlier, later]);
  });

  it("keeps a finding id with a colon through its file name", () => {
    const files = renderChampionFolder(folder());
    const path = files.find((file) => file.path.startsWith("findings/"))!.path;
    expect(path).not.toContain(":");
    expect(parseChampionFolder(files).findings[0]?.id).toBe("engine-knowledge:behind:0.3.91");
  });

  it("ignores the Champion's own notes", () => {
    const parsed = parseChampionFolder([
      ...renderChampionFolder(folder()),
      { path: "notes/ideas.md", content: "anything" },
    ]);
    expect(parsed.problems).toEqual([]);
  });
});
