import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildNextModelSlotLabels, getCustomModelLabel } from "./modelLabels";

describe("modelLabels", () => {
  const instanceId = ProviderInstanceId.make("pi");
  const slug = "openai/gpt-6-luna";

  it("sets, reads, resets on default match, and clears custom labels", () => {
    const first = buildNextModelSlotLabels({
      slotLabels: {},
      instanceId,
      slug,
      nextName: "  Luna Fast  ",
      defaultNames: ["GPT-6 Luna"],
    });
    expect(first).toEqual({ "pi:openai/gpt-6-luna": "Luna Fast" });
    expect(getCustomModelLabel(first!, instanceId, slug)).toBe("Luna Fast");

    // Same trimmed value is a no-op.
    expect(
      buildNextModelSlotLabels({
        slotLabels: first!,
        instanceId,
        slug,
        nextName: "Luna Fast",
        defaultNames: ["GPT-6 Luna"],
      }),
    ).toBeNull();

    // Entering the default name clears the override.
    expect(
      buildNextModelSlotLabels({
        slotLabels: first!,
        instanceId,
        slug,
        nextName: "GPT-6 Luna",
        defaultNames: ["GPT-6 Luna"],
      }),
    ).toEqual({});

    // Clearing the text removes the override.
    expect(
      buildNextModelSlotLabels({
        slotLabels: first!,
        instanceId,
        slug,
        nextName: "   ",
        defaultNames: ["GPT-6 Luna"],
      }),
    ).toEqual({});
  });
});
