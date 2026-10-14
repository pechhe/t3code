import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_ROLLOVER_PAUSE_MS,
  MAX_ROLLOVER_PAUSE_MS,
  activeRolloverHold,
  describeRolloverHold,
  parseRolloverCommand,
  parseRolloverDuration,
  rolloverHoldForCommand,
} from "./rolloverCommand";

const NOW = Date.parse("2026-10-14T12:00:00.000Z");

describe("parseRolloverDuration", () => {
  it("reads minutes, hours and days", () => {
    expect(parseRolloverDuration("30m")).toBe(30 * 60_000);
    expect(parseRolloverDuration("2h")).toBe(2 * 3_600_000);
    expect(parseRolloverDuration("1d")).toBe(86_400_000);
    expect(parseRolloverDuration("2H")).toBe(2 * 3_600_000);
  });

  it("reads a bare number as hours, fractions included", () => {
    expect(parseRolloverDuration("3")).toBe(3 * 3_600_000);
    expect(parseRolloverDuration("1.5")).toBe(5_400_000);
  });

  it("rejects anything else", () => {
    for (const text of ["", "h", "-1h", "1w", "1h30m", "soon"]) {
      expect(parseRolloverDuration(text)).toBeNull();
    }
  });
});

describe("parseRolloverCommand", () => {
  it("ignores text that is not a rollover command", () => {
    expect(parseRolloverCommand("rollover off")).toBeNull();
    expect(parseRolloverCommand("/rolloverx")).toBeNull();
    expect(parseRolloverCommand("please /rollover off")).toBeNull();
  });

  it("reads on, off and status, with a bare command meaning status", () => {
    expect(parseRolloverCommand(" /rollover off ")).toEqual({ ok: true, command: { kind: "off" } });
    expect(parseRolloverCommand("/ROLLOVER On")).toEqual({ ok: true, command: { kind: "on" } });
    expect(parseRolloverCommand("/rollover status")).toEqual({
      ok: true,
      command: { kind: "status" },
    });
    expect(parseRolloverCommand("/rollover")).toEqual({ ok: true, command: { kind: "status" } });
  });

  it("pauses for an hour by default and for the given time otherwise", () => {
    expect(parseRolloverCommand("/rollover pause")).toEqual({
      ok: true,
      command: { kind: "pause", durationMs: DEFAULT_ROLLOVER_PAUSE_MS },
    });
    expect(parseRolloverCommand("/rollover pause 30m")).toEqual({
      ok: true,
      command: { kind: "pause", durationMs: 1_800_000 },
    });
    expect(parseRolloverCommand("/rollover pause 2")).toEqual({
      ok: true,
      command: { kind: "pause", durationMs: 7_200_000 },
    });
  });

  it("allows up to seven days and no more", () => {
    expect(parseRolloverCommand("/rollover pause 7d")).toEqual({
      ok: true,
      command: { kind: "pause", durationMs: MAX_ROLLOVER_PAUSE_MS },
    });
    expect(parseRolloverCommand("/rollover pause 8d")).toMatchObject({ ok: false });
    expect(parseRolloverCommand("/rollover pause 0")).toMatchObject({ ok: false });
  });

  it("explains a command it cannot read", () => {
    expect(parseRolloverCommand("/rollover pause soon")).toMatchObject({ ok: false });
    expect(parseRolloverCommand("/rollover maybe")).toMatchObject({ ok: false });
    expect(parseRolloverCommand("/rollover off now")).toMatchObject({ ok: false });
  });
});

describe("rolloverHoldForCommand", () => {
  it("maps each command to the hold it stores", () => {
    expect(rolloverHoldForCommand({ kind: "status" }, NOW)).toBeUndefined();
    expect(rolloverHoldForCommand({ kind: "on" }, NOW)).toBeNull();
    expect(rolloverHoldForCommand({ kind: "off" }, NOW)).toEqual({ kind: "off" });
    expect(rolloverHoldForCommand({ kind: "pause", durationMs: 1_800_000 }, NOW)).toEqual({
      kind: "paused",
      until: "2026-10-14T12:30:00.000Z",
    });
  });
});

describe("describeRolloverHold", () => {
  const until = "2026-10-14T13:05:00.000Z";

  it("shows nothing unless rollover is held", () => {
    expect(describeRolloverHold(null, NOW)).toBeNull();
    expect(describeRolloverHold(undefined, NOW)).toBeNull();
    expect(describeRolloverHold({ kind: "paused", until }, Date.parse(until))).toBeNull();
  });

  it("labels an off thread and a running pause", () => {
    expect(describeRolloverHold({ kind: "off" }, NOW)).toBe("Rollover off");
    expect(describeRolloverHold({ kind: "paused", until }, NOW)).toMatch(
      /^Rollover paused until .*\d/,
    );
  });

  it("treats a lapsed pause as no hold", () => {
    expect(activeRolloverHold({ kind: "paused", until }, Date.parse(until) + 1)).toBeNull();
    expect(activeRolloverHold({ kind: "off" }, NOW)).toEqual({ kind: "off" });
  });
});
