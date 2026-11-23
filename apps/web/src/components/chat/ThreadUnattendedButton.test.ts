import { describe, expect, it } from "vite-plus/test";

import { threadModeOps } from "./ThreadUnattendedButton";

describe("threadModeOps", () => {
  it("keeps a thread attended under Away and lets it follow Away again", () => {
    expect(threadModeOps({ from: "away", to: "attended", optedOut: false })).toEqual(["away-off"]);
    expect(threadModeOps({ from: "attended", to: "away", optedOut: true })).toEqual(["away-on"]);
  });

  it("starts a run from any mode, and ends it before changing Away", () => {
    expect(threadModeOps({ from: "attended", to: "run", optedOut: true })).toEqual(["start"]);
    expect(threadModeOps({ from: "run", to: "attended", optedOut: false })).toEqual([
      "end",
      "away-off",
    ]);
    expect(threadModeOps({ from: "run", to: "away", optedOut: false })).toEqual(["end"]);
  });

  it("does nothing when the mode is unchanged", () => {
    expect(threadModeOps({ from: "away", to: "away", optedOut: false })).toEqual([]);
  });
});
