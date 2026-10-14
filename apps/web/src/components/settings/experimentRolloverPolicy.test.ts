import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { experimentRolloverBaseline } from "./experimentRolloverPolicy";

const settings = {
  ...DEFAULT_SERVER_SETTINGS.contextRollover,
  enabled: true,
  softThreshold: 210000,
  hardThreshold: 270000,
  modelRules: [
    { modelPattern: "haiku", enabled: true, softThreshold: 80000, hardThreshold: 90000 },
  ],
};
describe("experiment rollover control", () => {
  it("uses environment thresholds for an eligible model without an override", () => {
    expect(experimentRolloverBaseline(settings, ["gpt-6"])).toEqual({ soft: 210000, hard: 270000 });
  });
  it("uses the first case-insensitive model rule", () => {
    expect(experimentRolloverBaseline(settings, ["CLAUDE-HAIKU"])).toEqual({
      soft: 80000,
      hard: 90000,
    });
  });
  it("rejects all-model and mixed-policy eligibility instead of changing the control", () => {
    expect(experimentRolloverBaseline(settings, [])).toBeNull();
    expect(experimentRolloverBaseline(settings, ["gpt-6", "haiku"])).toBeNull();
  });
  it("cannot call disabled rollover the current control", () => {
    expect(experimentRolloverBaseline({ ...settings, enabled: false }, ["gpt-6"])).toBeNull();
    expect(
      experimentRolloverBaseline(
        { ...settings, modelRules: [{ ...settings.modelRules[0]!, enabled: false }] },
        ["haiku"],
      ),
    ).toBeNull();
  });
  it("permits all models when every model rule has the same enabled policy", () => {
    expect(experimentRolloverBaseline({ ...settings, modelRules: [] }, [])).toEqual({
      soft: 210000,
      hard: 270000,
    });
  });
});
