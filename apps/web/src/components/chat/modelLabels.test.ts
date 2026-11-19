import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildNextModelSlotLabels,
  getCustomModelLabel,
  withPooledModelLabels,
} from "./modelLabels";

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

  it("names a pooled model apart from the same model on one account", () => {
    const models = [
      { key: "claude-sonnet-5-5", displayName: "Claude Sonnet 5.5" },
      { key: "gpt-6-luna", displayName: "GPT-6 Luna" },
    ];
    const labels = { "@pooled:claude-sonnet-5-5": "Sonnet", "pi:openai/gpt-6-luna": "Luna Fast" };
    expect(withPooledModelLabels(models, labels).map((model) => model.displayName)).toEqual([
      "Sonnet",
      "GPT-6 Luna",
    ]);
  });
});
