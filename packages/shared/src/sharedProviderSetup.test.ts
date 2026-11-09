import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  applySharedSetupPlan,
  planSharedSetupSync,
  type SharedSetupMember,
} from "./sharedProviderSetup.ts";

const member = (
  id: string,
  version: number,
  baseVersion: number,
  changedAt: string,
): SharedSetupMember => ({
  environmentId: id as EnvironmentId,
  state: { shared: true, version, baseVersion, changedAt, digest: id },
});

const T1 = "2026-11-09T10:00:00.000Z";
const T2 = "2026-11-09T11:00:00.000Z";
const summary = (members: ReadonlyArray<SharedSetupMember>) => {
  const plan = planSharedSetupSync(members);
  return (
    plan && {
      source: plan.sourceEnvironmentId,
      version: plan.version,
      targets: plan.targets.map((target) => target.environmentId as string).toSorted(),
    }
  );
};

describe("planSharedSetupSync", () => {
  it("does nothing when everyone agrees or nobody else shares", () => {
    expect(summary([member("a", 5, 5, T1), member("b", 5, 5, T1)])).toBeNull();
    expect(summary([member("a", 6, 5, T1)])).toBeNull();
  });

  it("spreads an edit and has its source record that", () => {
    expect(summary([member("a", 6, 5, T2), member("b", 5, 5, T1)])).toEqual({
      source: "a",
      version: 6,
      targets: ["a", "b"],
    });
  });

  it("lets the only edit win even when its clock is behind", () => {
    expect(summary([member("a", 6, 5, "2020-01-01T00:00:00.000Z"), member("b", 5, 5, T2)])).toEqual(
      { source: "a", version: 6, targets: ["a", "b"] },
    );
  });

  it("brings a machine that was away up to the spread version", () => {
    expect(summary([member("a", 9, 9, T2), member("b", 9, 9, T2), member("c", 3, 3, T1)])).toEqual({
      source: "b",
      version: 9,
      targets: ["c"],
    });
  });

  it("takes the later edit when two machines edited apart, at a fresh version", () => {
    expect(summary([member("a", 6, 5, T1), member("b", 7, 5, T2)])).toEqual({
      source: "b",
      version: 7,
      targets: ["a", "b"],
    });
    expect(summary([member("a", 7, 5, T2), member("b", 9, 5, T1)])).toEqual({
      source: "a",
      version: 10,
      targets: ["a", "b"],
    });
  });

  it("compares by time when an away machine edited past what others agreed", () => {
    expect(summary([member("a", 9, 9, T1), member("c", 4, 3, T2)])).toEqual({
      source: "c",
      version: 10,
      targets: ["a", "c"],
    });
  });

  it("breaks an exact tie the same way whichever order it sees members", () => {
    const a = member("a", 6, 5, T1);
    const b = member("b", 6, 5, T1);
    expect(summary([a, b])?.source).toBe("b");
    expect(summary([b, a])?.source).toBe("b");
  });
});

describe("applySharedSetupPlan", () => {
  const source = member("source", 7, 6, T1);
  const other = member("other", 6, 6, T1);
  const plan = {
    sourceEnvironmentId: source.environmentId,
    version: 7,
    changedAt: T1,
    targets: [source, other],
  };

  it("leaves the source's edit unspread when another machine refuses it", async () => {
    const applied: string[] = [];
    const failures = await applySharedSetupPlan(plan, async (target) => {
      applied.push(target.environmentId);
      return target === other ? "refused" : null;
    });
    expect(applied).toEqual(["other"]);
    expect(failures.get(other.environmentId)).toBe("refused");
  });

  it("records the source last, once everyone else took the edit", async () => {
    const applied: string[] = [];
    const failures = await applySharedSetupPlan(plan, async (target) => {
      applied.push(target.environmentId);
      return null;
    });
    expect(applied).toEqual(["other", "source"]);
    expect(failures.size).toBe(0);
  });
});
