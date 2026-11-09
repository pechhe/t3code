import { describe, expect, it } from "vite-plus/test";

import * as Rules from "./journeyRules.ts";

const at = (seconds: number) => `2026-11-08T00:00:${String(seconds).padStart(2, "0")}.000Z`;

const manifest = (overrides: Record<string, unknown> = {}) =>
  ({
    synthetic: true,
    shards: [
      {
        id: "s1",
        origin: "http://localhost:3300",
        signInPath: "/dev/agent-login",
        database: "scratch_0123abcd",
        container: "shard-1",
      },
    ],
    ...overrides,
  }) as never;

const container = (overrides: Record<string, unknown> = {}) => ({
  name: "shard-1",
  running: true,
  networks: [{ name: "attack", internal: true }],
  databaseName: "scratch_0123abcd",
  environmentNames: ["NODE_ENV", "DATABASE_URL"],
  ...overrides,
});

describe("peakConcurrency", () => {
  it("counts overlaps by recorded times, and an end meeting a start does not overlap", () => {
    expect(
      Rules.peakConcurrency(
        [
          { startedAt: at(0), endedAt: at(10) },
          { startedAt: at(1), endedAt: at(9) },
          { startedAt: at(10), endedAt: at(20) },
        ],
        0,
      ),
    ).toBe(2);
    expect(
      Rules.peakConcurrency(
        [
          { startedAt: at(0), endedAt: at(1) },
          { startedAt: at(1), endedAt: at(2) },
        ],
        0,
      ),
    ).toBe(1);
  });

  it("treats a journey still running as open until now", () => {
    expect(
      Rules.peakConcurrency(
        [
          { startedAt: at(0), endedAt: null },
          { startedAt: at(5), endedAt: at(6) },
        ],
        Date.parse(at(10)),
      ),
    ).toBe(2);
  });
});

describe("targetRefusal", () => {
  it("accepts a contained synthetic shard", () => {
    expect(Rules.targetRefusal(manifest(), [container()])).toBeNull();
  });

  it.each([
    ["undeclared data", manifest({ synthetic: false }), [container()], "synthetic"],
    ["a stopped shard", manifest(), [container({ running: false })], "not running"],
    [
      "a route out",
      manifest(),
      [container({ networks: [{ name: "bridge", internal: false }] })],
      "route out",
    ],
    ["another database", manifest(), [container({ databaseName: "ys_prod" })], "ys_prod"],
    [
      "a credential",
      manifest(),
      [container({ environmentNames: ["OPENAI_API_KEY"] })],
      "OPENAI_API_KEY",
    ],
    [
      "a public origin",
      manifest({
        shards: [
          {
            id: "s1",
            origin: "https://weave.example.com",
            signInPath: "/",
            database: "scratch_0123abcd",
            container: "shard-1",
          },
        ],
      }),
      [container()],
      "loopback",
    ],
    [
      "a shared database name",
      manifest({
        shards: [
          {
            id: "s1",
            origin: "http://localhost:1",
            signInPath: "/",
            database: "preview",
            container: "shard-1",
          },
        ],
      }),
      [container()],
      "disposable",
    ],
  ] as const)("refuses %s", (_name: string, target: never, containers: unknown, reason: string) => {
    expect(Rules.targetRefusal(target, containers as never)).toContain(reason);
  });
});

describe("incompleteReason", () => {
  const served = { started: 2, passed: 1, failed: 1, stopped: 0, running: 0 };
  const base = {
    served,
    owner: { started: 2, passed: 1, failed: 1, stopped: 0 },
    journeyLimit: 8,
    downShards: [] as string[],
    pendingCandidates: 0,
    capture: { outside: [] } as { outside: string[] } | null,
  };

  it("is complete when the server and owner agree", () => {
    expect(Rules.incompleteReason(base)).toBeNull();
  });

  it("names a stopped shard even when the owner reports clean", () => {
    expect(Rules.incompleteReason({ ...base, downShards: ["s2"] })).toContain("s2");
  });

  it("is incomplete when the capture is missing or saw traffic leave", () => {
    expect(Rules.incompleteReason({ ...base, capture: null })).toContain("could not be read");
    expect(Rules.incompleteReason({ ...base, capture: { outside: ["1.2.3.4"] } })).toContain(
      "outside addresses",
    );
  });

  it("does not take the owner's word for its counts", () => {
    expect(
      Rules.incompleteReason({
        ...base,
        owner: { started: 32, passed: 32, failed: 0, stopped: 0 },
      }),
    ).toContain("32 started");
  });

  it("is incomplete with an unsettled candidate, a running journey or no journeys", () => {
    expect(Rules.incompleteReason({ ...base, pendingCandidates: 1 })).toContain("never confirmed");
    expect(Rules.incompleteReason({ ...base, served: { ...served, running: 1 } })).toContain(
      "never finished",
    );
    expect(
      Rules.incompleteReason({
        ...base,
        served: { started: 0, passed: 0, failed: 0, stopped: 0, running: 0 },
      }),
    ).toBe("No journey ran.");
  });
});

describe("parseVerdict", () => {
  it("reads the replay's final message", () => {
    expect(
      Rules.parseVerdict("I tried.\nVERDICT: reproduced\nREASON: Error page.\nSCREENSHOT: /a.png"),
    ).toEqual({ verdict: "reproduced", reason: "Error page.", screenshot: "/a.png" });
  });

  it("gives no verdict for a message without a recognised one", () => {
    expect(Rules.parseVerdict("It seems to work, I think.")).toBeNull();
    expect(Rules.parseVerdict("VERDICT: maybe\nREASON: unsure")).toBeNull();
    expect(Rules.parseVerdict(null)).toBeNull();
  });
});

describe("parseStat", () => {
  it("reads nice and policy from a stat line whose process name has spaces", () => {
    const rest = Array.from({ length: 50 }, (_, index) => String(index));
    rest[1] = "77";
    rest[16] = "19";
    rest[38] = "5";
    expect(Rules.parseStat(`123 (chrome (main) x) ${rest.join(" ")}`)).toEqual({
      ppid: "77",
      nice: 19,
      policy: "5",
    });
  });
});

describe("isCapacityStop", () => {
  it("tells a machine running short from a journey spending its own budget", () => {
    expect(Rules.isCapacityStop("deadline")).toBe(true);
    expect(Rules.isCapacityStop("decision-rate-limited")).toBe(true);
    expect(Rules.isCapacityStop("decision-busy")).toBe(true);
    expect(Rules.isCapacityStop("decision-limit")).toBe(false);
    expect(Rules.isCapacityStop("action-limit")).toBe(false);
    expect(Rules.isCapacityStop(null)).toBe(false);
  });
});

describe("findingEvidence", () => {
  it("stays within a finding's limit and keeps what confirms the bug", () => {
    const evidence = Rules.findingEvidence({
      observed: "No detail appears.",
      expected: "The agreement opens.",
      commit: "abc",
      steps: "step\n".repeat(4000),
      clicks: "click".repeat(4000),
      model: "strong",
      reason: "Seen on a fresh database.",
      screenshot: "/shots/one.png",
    });
    expect(evidence.length).toBeLessThanOrEqual(8000);
    expect(evidence).toContain("No detail appears.");
    expect(evidence).toContain("Confirmed in isolation by strong");
    expect(evidence).toContain("Screenshot: /shots/one.png");
  });
});

describe("sameFailure", () => {
  const ending = (url: string, name: string, finalUrl: string) => ({
    finalUrl,
    steps: [
      {
        id: "P1",
        kind: "page",
        operation: "click",
        target: { role: "button", name },
        description: null,
        option: null,
        value: null,
        url,
        state: "completed",
        at: "2026-11-08T20:00:00.000Z",
        ms: 1,
      } as const,
    ],
  });

  it("joins two journeys that end on the same step and page, on any shard", () => {
    expect(
      Rules.sameFailure(
        ending("http://localhost:3301/notes", "Search", "http://localhost:3301/notes?q=x"),
        ending("http://localhost:3302/notes", "Search", "http://localhost:3302/notes?q=x"),
      ),
    ).toBe(true);
  });

  it("joins them whatever the search typed", () => {
    expect(
      Rules.sameFailure(
        ending("http://localhost:3301/notes", "Search", "http://localhost:3301/notes?q=x"),
        ending("http://localhost:3301/notes", "Search", "http://localhost:3301/notes?q="),
      ),
    ).toBe(true);
  });

  it("keeps apart two routes that end on the same click", () => {
    const direct = ending("http://localhost:3301/notes", "Save", "http://localhost:3301/notes");
    const last = direct.steps[0]!;
    const viaGuidelines = {
      ...direct,
      steps: [{ ...last, url: "http://localhost:3301/notes/guidelines" }, last],
    };
    expect(Rules.sameFailure(direct, viaGuidelines)).toBe(false);
    expect(Rules.sameFailure(viaGuidelines, viaGuidelines)).toBe(true);
  });

  it("keeps apart bugs that read alike but end elsewhere", () => {
    const search = ending(
      "http://localhost:3301/notes",
      "Search",
      "http://localhost:3301/notes?q=x",
    );
    expect(
      Rules.sameFailure(
        search,
        ending("http://localhost:3301/docs", "Search", "http://localhost:3301/docs?q=x"),
      ),
    ).toBe(false);
    expect(
      Rules.sameFailure(
        search,
        ending("http://localhost:3301/notes", "Save", "http://localhost:3301/notes?q=x"),
      ),
    ).toBe(false);
    expect(Rules.sameFailure({ finalUrl: null, steps: [] }, { finalUrl: null, steps: [] })).toBe(
      false,
    );
  });
});

describe("describeSteps", () => {
  it("says a repeated click once, with how many times", () => {
    const click = {
      id: "P1",
      kind: "page",
      operation: "click",
      target: { role: "link", name: "Open" },
      description: null,
      option: null,
      value: null,
      url: "http://localhost:3300/list",
      state: "completed",
      at: "2026-11-08T00:00:00.000Z",
      ms: 1,
    } as const;
    expect(Rules.describeSteps([click, click, click])).toBe(
      '1. On /list: click the link named "Open" (repeated 3 times)',
    );
  });
});
