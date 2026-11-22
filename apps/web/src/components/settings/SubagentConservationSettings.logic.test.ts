import { describe, expect, it } from "vite-plus/test";
import {
  ENABLE_MESSAGE,
  MODELS_MESSAGE,
  THRESHOLD_MESSAGE,
  planConservationSave,
  type ConservationDraft,
} from "./SubagentConservationSettings.logic";

const saved = { enabled: true, remainingPercent: 20, window: "any", models: ["a"] };
const draft = (patch: Partial<ConservationDraft> = {}): ConservationDraft => ({
  enabled: true,
  threshold: "20",
  window: "any",
  models: ["a"],
  ...patch,
});

describe("planConservationSave", () => {
  it("does not save an unchanged rule", () => {
    expect(planConservationSave(draft(), saved)).toEqual({ kind: "none" });
  });

  it("turns off with the saved threshold when the input is empty or invalid", () => {
    expect(planConservationSave(draft({ enabled: false, threshold: "" }), saved)).toEqual({
      kind: "save",
      rule: { ...saved, enabled: false },
    });
    expect(planConservationSave(draft({ enabled: false, threshold: "500" }), saved)).toMatchObject({
      kind: "save",
      rule: { remainingPercent: 20 },
    });
  });

  it("turns off with a valid typed threshold when no rule exists", () => {
    expect(
      planConservationSave(draft({ enabled: false, threshold: "30", models: [] }), undefined),
    ).toMatchObject({ kind: "save", rule: { enabled: false, remainingPercent: 30 } });
  });

  it("holds enabling until a threshold and a model exist", () => {
    const off = { ...saved, enabled: false };
    expect(planConservationSave(draft({ threshold: "" }), off)).toEqual({
      kind: "hold",
      message: ENABLE_MESSAGE,
    });
    expect(planConservationSave(draft({ models: [] }), off)).toEqual({
      kind: "hold",
      message: ENABLE_MESSAGE,
    });
    expect(planConservationSave(draft(), off)).toMatchObject({ kind: "save" });
  });

  it("holds an enabled rule edit that has no model or a bad threshold", () => {
    expect(planConservationSave(draft({ models: [] }), saved)).toEqual({
      kind: "hold",
      message: MODELS_MESSAGE,
    });
    for (const threshold of ["", "0", "100", "2.5"])
      expect(planConservationSave(draft({ threshold }), saved)).toEqual({
        kind: "hold",
        message: THRESHOLD_MESSAGE,
      });
  });

  it("saves a window change", () => {
    expect(planConservationSave(draft({ window: "weekly" }), saved)).toMatchObject({
      kind: "save",
      rule: { window: "weekly" },
    });
  });

  it("stays quiet for an untouched new rule", () => {
    expect(
      planConservationSave(draft({ enabled: false, threshold: "", models: [] }), undefined),
    ).toEqual({ kind: "none" });
  });
});
