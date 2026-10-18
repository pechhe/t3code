import { describe, expect, it } from "vite-plus/test";
import type { ProviderOptionDescriptor } from "@t3tools/contracts";
import { buildProviderOptionSelectionsFromDescriptors } from "@t3tools/shared/model";

import { resolveFastSwitch } from "./TraitsSpeed";

const effort: ProviderOptionDescriptor = {
  id: "effort",
  label: "Effort",
  type: "select",
  options: [
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
  ],
  currentValue: "high",
};

function serviceTier(currentValue: string): ProviderOptionDescriptor {
  return {
    id: "serviceTier",
    label: "Service Tier",
    type: "select",
    options: [
      { id: "default", label: "Standard", isDefault: true },
      { id: "priority", label: "Fast" },
      { id: "flex-ultra", label: "Ultrafast" },
    ],
    currentValue,
  };
}

describe("resolveFastSwitch", () => {
  it("toggles Claude's fastMode boolean and keeps other traits", () => {
    const descriptors: ReadonlyArray<ProviderOptionDescriptor> = [
      effort,
      { id: "fastMode", label: "Fast Mode", type: "boolean", currentValue: false },
    ];
    const fastSwitch = resolveFastSwitch(descriptors);
    expect(fastSwitch?.active).toBe(false);
    expect(buildProviderOptionSelectionsFromDescriptors(fastSwitch!.setActive(true))).toEqual([
      { id: "effort", value: "high" },
      { id: "fastMode", value: true },
    ]);
  });

  it("switches Codex between the Fast and Standard service tiers", () => {
    const off = resolveFastSwitch([serviceTier("default")]);
    expect(off?.active).toBe(false);
    expect(buildProviderOptionSelectionsFromDescriptors(off!.setActive(true))).toEqual([
      { id: "serviceTier", value: "priority" },
    ]);

    const on = resolveFastSwitch([serviceTier("priority")]);
    expect(on?.active).toBe(true);
    expect(buildProviderOptionSelectionsFromDescriptors(on!.setActive(false))).toEqual([
      { id: "serviceTier", value: "default" },
    ]);
  });

  it("counts Ultrafast as on, and turning it off returns to Standard", () => {
    const ultrafast = resolveFastSwitch([serviceTier("flex-ultra")]);
    expect(ultrafast?.active).toBe(true);
    expect(buildProviderOptionSelectionsFromDescriptors(ultrafast!.setActive(false))).toEqual([
      { id: "serviceTier", value: "default" },
    ]);
  });

  it("is unavailable for a model without a Fast option", () => {
    expect(resolveFastSwitch([effort])).toBeNull();
    expect(
      resolveFastSwitch([
        {
          id: "serviceTier",
          label: "Service Tier",
          type: "select",
          options: [{ id: "default", label: "Standard" }],
          currentValue: "default",
        },
      ]),
    ).toBeNull();
  });
});
