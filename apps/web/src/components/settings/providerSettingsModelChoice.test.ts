import { describe, expect, it } from "vite-plus/test";

import { clearedModelChoiceConfig, nextModelChoiceConfig } from "./providerSettingsModelChoice";

describe("model choice config", () => {
  it("stores the model and the account that runs it, keeping the rest", () => {
    expect(
      nextModelChoiceConfig({
        base: { binaryPath: "/opt/claude" },
        modelKey: "compactModel",
        instanceKey: "compactModelInstanceId",
        model: "deepseek-v4.1-flash",
        instanceId: "instance-2",
      }),
    ).toEqual({
      binaryPath: "/opt/claude",
      compactModel: "deepseek-v4.1-flash",
      compactModelInstanceId: "instance-2",
    });
  });

  it("clears both keys for a field that inherits nothing", () => {
    expect(
      clearedModelChoiceConfig({
        base: { compactModel: "claude-sonnet", compactModelInstanceId: "instance-2" },
        modelKey: "compactModel",
        instanceKey: "compactModelInstanceId",
        storeEmptyChoice: false,
      }),
    ).toBeUndefined();
  });

  it("stores an explicit empty choice for a pool-shared field", () => {
    expect(
      clearedModelChoiceConfig({
        base: {},
        modelKey: "compactModel",
        instanceKey: "compactModelInstanceId",
        storeEmptyChoice: true,
      }),
    ).toEqual({ compactModel: "" });
  });
});
