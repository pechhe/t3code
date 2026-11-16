import { describe, expect, it } from "vite-plus/test";
import {
  DELEGATION_STANCE_OPTIONS,
  resolveDraftStance,
  resolveServerThreadStance,
  shouldClearPendingStance,
  stepDelegationStance,
  touchDraftStance,
} from "./stance.logic";

describe("stance.logic", () => {
  it("follows the selected model while untouched, then holds the owner's manual choice across model changes", () => {
    expect(
      resolveDraftStance({
        manualChoice: null,
        modelResolved: { stance: "orchestrate", source: "model" },
      }),
    ).toBe("orchestrate");

    expect(
      resolveDraftStance({
        manualChoice: null,
        modelResolved: { stance: "implement", source: "model" },
      }),
    ).toBe("implement");

    expect(
      resolveDraftStance({
        manualChoice: null,
        modelResolved: null,
      }),
    ).toBe("flexible");

    const manual = touchDraftStance("orchestrate");
    expect(manual).toEqual({ stance: "orchestrate", chosenBy: "owner" });

    expect(
      resolveDraftStance({
        manualChoice: manual,
        modelResolved: { stance: "implement", source: "model" },
      }),
    ).toBe("orchestrate");
  });

  it("shows an optimistic pick on a server thread until the server reconciles it", () => {
    const pending = { threadKey: "env-1:thread-1", stance: "orchestrate" as const };

    expect(
      resolveServerThreadStance({
        pending,
        threadKey: "env-1:thread-1",
        serverResolved: { stance: "flexible", source: "role" },
        serverChoice: undefined,
      }),
    ).toBe("orchestrate");

    expect(
      resolveServerThreadStance({
        pending,
        threadKey: "env-1:thread-2",
        serverResolved: { stance: "implement", source: "model" },
        serverChoice: undefined,
      }),
    ).toBe("implement");

    expect(
      shouldClearPendingStance({
        pending,
        threadKey: "env-1:thread-1",
        serverChoice: { stance: "flexible", chosenBy: "parent" },
      }),
    ).toBe(false);

    expect(
      shouldClearPendingStance({
        pending,
        threadKey: "env-1:thread-1",
        serverChoice: { stance: "orchestrate", chosenBy: "owner" },
      }),
    ).toBe(true);

    expect(
      shouldClearPendingStance({
        pending,
        threadKey: "env-1:thread-2",
        serverChoice: undefined,
      }),
    ).toBe(true);
  });

  it("steps through Orchestrate, Flexible, Implement in order", () => {
    expect(DELEGATION_STANCE_OPTIONS.map((option) => option.label)).toEqual([
      "Orchestrate",
      "Flexible",
      "Implement",
    ]);
    expect(stepDelegationStance("orchestrate", 1)).toBe("flexible");
    expect(stepDelegationStance("flexible", 1)).toBe("implement");
    expect(stepDelegationStance("implement", 1)).toBe("orchestrate");
    expect(stepDelegationStance("orchestrate", -1)).toBe("implement");
  });
});
