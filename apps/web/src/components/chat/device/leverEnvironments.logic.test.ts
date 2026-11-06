import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentOption } from "../../BranchToolbar.logic";
import { leverEnvironments } from "./leverEnvironments.logic";

const option = (id: string, label: string, isPrimary = false): EnvironmentOption => ({
  environmentId: id as EnvironmentId,
  projectId: null,
  label,
  isPrimary,
  machine: isPrimary ? "laptop" : "server",
});

const mac = option("mac", "This Mac", true);
const box = option("box", "peach-box");
const live = option("live", "peach-live");
const ids = (pair: ReturnType<typeof leverEnvironments>) =>
  pair?.map((entry) => entry.environmentId);

describe("leverEnvironments", () => {
  it("offers both machines when the project lives on exactly two", () => {
    expect(ids(leverEnvironments([box, mac], "mac" as EnvironmentId, {}))).toEqual(["mac", "box"]);
  });

  it("offers no lever with a single machine", () => {
    expect(leverEnvironments([mac], "mac" as EnvironmentId, {})).toBeNull();
  });

  it("with three machines, pairs this device with the preferred remote, never a manual-only one", () => {
    const weights = { box: 100, live: 0 };
    expect(ids(leverEnvironments([mac, live, box], "mac" as EnvironmentId, weights))).toEqual([
      "mac",
      "box",
    ]);
    expect(ids(leverEnvironments([mac, live, box], "box" as EnvironmentId, weights))).toEqual([
      "mac",
      "box",
    ]);
  });

  it("keeps the thread's current machine on the lever even when it is not preferred", () => {
    expect(
      ids(leverEnvironments([mac, live, box], "live" as EnvironmentId, { box: 100, live: 0 })),
    ).toEqual(["mac", "live"]);
  });

  it("breaks equal preferences by name, so the lever is stable", () => {
    expect(ids(leverEnvironments([live, mac, box], null, {}))).toEqual(["mac", "box"]);
  });
});
