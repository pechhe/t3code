import { describe, expect, it, vi } from "vite-plus/test";

import { AWAY_PRESS_GRACE_MS, createAwayPress, summarizeAway } from "./away.ts";

describe("summarizeAway", () => {
  it("is off with nothing to change or nothing on", () => {
    expect(summarizeAway([])).toMatchObject({ state: "off", next: true });
    expect(summarizeAway([false, false])).toMatchObject({ state: "off", on: 0, total: 2 });
  });

  it("is on only when every environment is", () => {
    expect(summarizeAway([true, true])).toMatchObject({ state: "on", next: false });
  });

  it("is mixed when they disagree, and pressing it turns them all on", () => {
    expect(summarizeAway([true, false])).toEqual({ state: "mixed", on: 1, total: 2, next: true });
  });
});

describe("createAwayPress", () => {
  const setup = (set: (environment: string, away: boolean) => Promise<{ _tag: string }>) => {
    const shown: Array<boolean | null> = [];
    const failures: Array<ReadonlyArray<string>> = [];
    const press = createAwayPress({
      set,
      changed: (pending) => shown.push(pending),
      failed: (environments) => failures.push(environments),
    });
    return { press, shown, failures };
  };

  it("shows each press at once and collapses presses made during a call into the last", async () => {
    const sent: Array<boolean> = [];
    const calls: Array<() => void> = [];
    const { press, shown } = setup(
      (_, away) =>
        new Promise((resolve) => {
          sent.push(away);
          calls.push(() => resolve({ _tag: "Success" }));
        }),
    );
    press.press(true, ["Mac", "VPS"]);
    press.press(false, ["Mac", "VPS"]);
    press.press(true, ["Mac", "VPS"]);
    expect(shown).toEqual([true, false, true]);
    expect(sent).toEqual([true, true]);
    calls.splice(0).forEach((resolve) => resolve());
    await vi.waitFor(() => expect(sent).toEqual([true, true, true, true]));
    press.observe("on");
    expect(shown).toEqual([true, false, true]);
    calls.splice(0).forEach((resolve) => resolve());
    await vi.waitFor(() => expect(shown).toEqual([true, false, true, null]));
  });

  it("gives way to the servers shortly after a press they never report", async () => {
    vi.useFakeTimers();
    try {
      const { press, shown } = setup(async () => ({ _tag: "Success" }));
      press.press(true, ["Mac", "VPS"]);
      await vi.advanceTimersByTimeAsync(AWAY_PRESS_GRACE_MS - 1);
      expect(shown).toEqual([true]);
      await vi.advanceTimersByTimeAsync(1);
      expect(shown).toEqual([true, null]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("names environments whose call failed or threw, and still sends the next press", async () => {
    const sent: Array<boolean> = [];
    const { press, shown, failures } = setup(async (environment, away) => {
      sent.push(away);
      if (environment === "VPS" && away) throw new Error("socket closed");
      return { _tag: environment === "Mac" && !away ? "Failure" : "Success" };
    });
    press.press(true, ["Mac", "VPS"]);
    await vi.waitFor(() => expect(failures).toEqual([["VPS"]]));
    expect(shown).toEqual([true, null]);
    press.press(false, ["Mac", "VPS"]);
    await vi.waitFor(() => expect(failures).toEqual([["VPS"], ["Mac"]]));
    expect(sent).toEqual([true, true, false, false]);
  });
});
