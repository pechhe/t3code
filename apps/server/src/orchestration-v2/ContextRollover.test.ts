import { assert, describe, it } from "@effect/vitest";
import { ContextRolloverSettings, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  boundRolloverThresholds,
  compactionBoundary,
  compactsNatively,
  assignedRolloverThresholds,
  lowestSoftThreshold,
  resolveRolloverThresholds,
  rolloverHeld,
  rolloverUsageAction,
  threadRolloverThresholds,
} from "./ContextRollover.ts";

const decodeSettings = Schema.decodeSync(ContextRolloverSettings);
const settings = (patch: Partial<typeof ContextRolloverSettings.Encoded> = {}) =>
  decodeSettings({ enabled: true, ...patch });

const root = ThreadId.make("thread:root");
const topLevel = {
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: root },
  creationSource: "web",
} as const;
const child = {
  parentThreadId: root,
  relationshipToParent: "subagent",
  rootThreadId: root,
} as const;
const delegated = { lineage: child, creationSource: "mcp" } as const;
const native = { lineage: child, creationSource: "provider" } as const;

describe("resolveRolloverThresholds", () => {
  it("is off by default", () => {
    assert.isNull(resolveRolloverThresholds(decodeSettings({}), "x"));
  });

  it("uses the defaults when no rule matches", () => {
    assert.deepEqual(resolveRolloverThresholds(settings(), "claude-opus-4-1"), {
      soft: 220_000,
      hard: 280_000,
    });
  });

  it("applies the first rule whose pattern the model contains, ignoring case", () => {
    const configured = settings({
      modelRules: [
        { modelPattern: "Haiku", enabled: true, softThreshold: 80_000, hardThreshold: 90_000 },
        { modelPattern: "haiku-4", enabled: true, softThreshold: 1, hardThreshold: 2 },
      ],
    });
    assert.deepEqual(resolveRolloverThresholds(configured, "claude-haiku-4-5"), {
      soft: 80_000,
      hard: 90_000,
    });
  });

  it("turns rollover off for a model whose rule is disabled", () => {
    const configured = settings({
      modelRules: [{ modelPattern: "gpt", enabled: false, softThreshold: 1, hardThreshold: 2 }],
    });
    assert.isNull(resolveRolloverThresholds(configured, "gpt-5.1-codex"));
  });
});

describe("boundRolloverThresholds", () => {
  const configured = { soft: 220_000, hard: 280_000 };

  it("keeps explicit thresholds when the provider limit is unknown or invalid", () => {
    for (const max of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.deepEqual(boundRolloverThresholds(configured, max), configured);
    }
  });

  it("reserves headroom for a handoff within a known context window", () => {
    assert.deepEqual(boundRolloverThresholds(configured, 200_000), {
      soft: 144_000,
      hard: 180_000,
      safetyHard: 180_000,
    });
    assert.deepEqual(boundRolloverThresholds(configured, 1_000_000), {
      ...configured,
      safetyHard: 980_000,
    });
    assert.deepEqual(boundRolloverThresholds({ soft: 90, hard: 100 }, 1_000), {
      soft: 90,
      hard: 100,
      safetyHard: 900,
    });
  });

  it("scales the reserve for smaller windows and still waits for growth after a compaction", () => {
    const bounded = boundRolloverThresholds({ soft: 80_000, hard: 95_000 }, 100_000);
    assert.equal(bounded.hard, 90_000);
    assert.equal(rolloverUsageAction("idle", 89_999, bounded, 60_000), "soft");
    assert.equal(rolloverUsageAction("idle", 90_000, bounded, 60_000), "hard");
    assert.equal(rolloverUsageAction("hardNudged", 90_000, bounded, 60_000), "none");
    assert.equal(rolloverUsageAction("idle", 90_000, bounded, 84_000), "none");
    const explicit = boundRolloverThresholds({ soft: 80_000, hard: 95_000 }, 200_000);
    assert.equal(rolloverUsageAction("idle", 95_000, explicit, 84_000), "none");
  });
});

describe("compactionBoundary", () => {
  const instances = {
    codex: { driver: "codex", config: { autoCompactWindow: "150000" } },
    claude: { driver: "claudeAgent", config: {} },
    cursor: { driver: "cursor" },
  };
  it("takes the smaller of the context window and the auto-compact window", () => {
    assert.equal(compactionBoundary(400_000, { providerInstances: instances }, "codex"), 150_000);
    assert.equal(compactionBoundary(100_000, { providerInstances: instances }, "codex"), 100_000);
    assert.equal(compactionBoundary(200_000, { providerInstances: instances }, "claude"), 200_000);
    assert.isNull(compactionBoundary(null, { providerInstances: instances }, "claude"));
  });
  it("pulls the nudges ahead of a window smaller than the thresholds", () => {
    const bounded = boundRolloverThresholds(
      { soft: 220_000, hard: 280_000 },
      compactionBoundary(400_000, { providerInstances: instances }, "codex"),
    );
    assert.isBelow(bounded.hard, 150_000);
  });
  it("nudges only providers that compact natively", () => {
    assert.isTrue(compactsNatively({ providerInstances: instances }, "codex"));
    assert.isTrue(compactsNatively({ providerInstances: instances }, "claude"));
    assert.isFalse(compactsNatively({ providerInstances: instances }, "cursor"));
    assert.isTrue(compactsNatively({ providerInstances: {} }, "codex"));
  });
});

describe("rolloverHeld", () => {
  const now = Date.parse("2026-10-14T12:00:00.000Z");

  it("holds nothing without a hold", () => {
    assert.isFalse(rolloverHeld(undefined, now));
    assert.isFalse(rolloverHeld(null, now));
  });

  it("holds an off thread until it is lifted", () => {
    assert.isTrue(rolloverHeld({ kind: "off" }, now));
  });

  it("holds a pause until its time, and not after", () => {
    const until = "2026-10-14T13:00:00.000Z";
    assert.isTrue(rolloverHeld({ kind: "paused", until }, now));
    assert.isTrue(rolloverHeld({ kind: "paused", until }, Date.parse(until) - 1));
    assert.isFalse(rolloverHeld({ kind: "paused", until }, Date.parse(until)));
    assert.isFalse(rolloverHeld({ kind: "paused", until }, Date.parse(until) + 1));
  });
});

describe("threadRolloverThresholds", () => {
  it("never rolls over provider-native subagents", () => {
    assert.isNull(threadRolloverThresholds(settings(), native, "claude-opus"));
  });

  it("rolls over delegated children only when the setting allows it", () => {
    assert.isNotNull(threadRolloverThresholds(settings(), delegated, "claude-opus"));
    assert.isNull(
      threadRolloverThresholds(settings({ delegatedThreads: false }), delegated, "claude-opus"),
    );
    assert.isNotNull(
      threadRolloverThresholds(settings({ delegatedThreads: false }), topLevel, "claude-opus"),
    );
  });
});

describe("assignedRolloverThresholds", () => {
  const variant = { softLimit: 80_000, hardLimit: 100_000 };
  it("enables an explicit experiment despite globally disabled rollover", () => {
    assert.deepEqual(
      assignedRolloverThresholds(settings({ enabled: false }), topLevel, "model", variant),
      {
        soft: 80_000,
        hard: 100_000,
      },
    );
    assert.isNull(
      assignedRolloverThresholds(settings({ enabled: false }), topLevel, "model", undefined),
    );
  });
  it("keeps native subagents and disabled delegated children outside experiment rollover", () => {
    assert.isNull(assignedRolloverThresholds(settings(), native, "model", variant));
    assert.isNull(
      assignedRolloverThresholds(
        settings({ delegatedThreads: false }),
        delegated,
        "model",
        variant,
      ),
    );
  });
  it("lets a thread's own thresholds win over disabled settings and an experiment", () => {
    const own = { soft: 50_000, hard: 70_000 };
    const ownTopLevel = { ...topLevel, rolloverThresholds: own };
    assert.deepEqual(
      assignedRolloverThresholds(settings({ enabled: false }), ownTopLevel, "model", undefined),
      own,
    );
    assert.deepEqual(assignedRolloverThresholds(settings(), ownTopLevel, "model", variant), own);
    assert.deepEqual(
      assignedRolloverThresholds(
        settings({ delegatedThreads: false }),
        { ...delegated, rolloverThresholds: own },
        "model",
        undefined,
      ),
      own,
    );
    assert.isNull(
      assignedRolloverThresholds(
        settings(),
        { ...native, rolloverThresholds: own },
        "model",
        variant,
      ),
    );
  });
});

describe("rolloverUsageAction", () => {
  const thresholds = { soft: 100, hard: 200 };

  it("nudges once at the soft threshold and once at the hard one", () => {
    assert.equal(rolloverUsageAction("idle", 99, thresholds, null), "none");
    assert.equal(rolloverUsageAction("idle", 100, thresholds, null), "soft");
    assert.equal(rolloverUsageAction("softNudged", 150, thresholds, null), "none");
    assert.equal(rolloverUsageAction("softNudged", 200, thresholds, null), "hard");
    assert.equal(rolloverUsageAction("hardNudged", 250, thresholds, null), "none");
  });

  it("goes straight to the hard nudge when usage jumps past both", () => {
    assert.equal(rolloverUsageAction("idle", 250, thresholds, null), "hard");
  });

  it("waits for a compacted conversation that is still above the threshold to grow before asking again", () => {
    // Haiku 80k/95k against a compacted context that already holds 84k.
    const haiku = { soft: 80_000, hard: 95_000 };
    assert.equal(rolloverUsageAction("idle", 84_000, haiku, 84_000), "none");
    assert.equal(rolloverUsageAction("idle", 103_999, haiku, 84_000), "none");
    assert.equal(rolloverUsageAction("idle", 104_000, haiku, 84_000), "hard");
    // A conversation that compacted well below the threshold nudges as usual.
    assert.equal(rolloverUsageAction("idle", 80_000, haiku, 30_000), "soft");
  });
});

describe("lowestSoftThreshold", () => {
  it("takes the lowest soft threshold of the defaults and enabled rules", () => {
    const configured = settings({
      modelRules: [
        { modelPattern: "haiku", enabled: true, softThreshold: 80_000, hardThreshold: 90_000 },
        { modelPattern: "mini", enabled: false, softThreshold: 10, hardThreshold: 20 },
      ],
    });
    assert.equal(lowestSoftThreshold(configured), 80_000);
    assert.isNull(lowestSoftThreshold(settings({ enabled: false })));
  });
});
