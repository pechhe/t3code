import { assert, describe, it } from "@effect/vitest";
import { ContextRolloverSettings, RunId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  lowestSoftThreshold,
  makeRolloverNotes,
  resolveRolloverThresholds,
  rolloverHeld,
  rolloverUsageAction,
  threadRolloverThresholds,
} from "./ContextRollover.ts";

const settings = (patch: Partial<typeof ContextRolloverSettings.Encoded> = {}) =>
  Schema.decodeSync(ContextRolloverSettings)({ enabled: true, ...patch });

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
    assert.isNull(resolveRolloverThresholds(Schema.decodeSync(ContextRolloverSettings)({}), "x"));
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

describe("rolloverUsageAction", () => {
  const thresholds = { soft: 100, hard: 200 };

  it("nudges once at the soft threshold and once at the hard one", () => {
    assert.equal(rolloverUsageAction("idle", 99, thresholds), "none");
    assert.equal(rolloverUsageAction("idle", 100, thresholds), "soft");
    assert.equal(rolloverUsageAction("softNudged", 150, thresholds), "none");
    assert.equal(rolloverUsageAction("softNudged", 200, thresholds), "hard");
    assert.equal(rolloverUsageAction("hardNudged", 250, thresholds), "none");
  });

  it("goes straight to the hard nudge when usage jumps past both", () => {
    assert.equal(rolloverUsageAction("idle", 250, thresholds), "hard");
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

describe("makeRolloverNotes", () => {
  it("holds a delegated result only for the run that wrote the note", () => {
    const notes = makeRolloverNotes();
    const threadId = ThreadId.make("thread:notes");
    const runId = RunId.make("run:notes:1");
    notes.save(threadId, { runId, note: "n" });
    assert.isTrue(notes.holdsResult({ id: runId, threadId }));
    assert.isFalse(notes.holdsResult({ id: RunId.make("run:notes:2"), threadId }));
    notes.delete(threadId);
    assert.isFalse(notes.holdsResult({ id: runId, threadId }));
  });
});
