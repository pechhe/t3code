import { describe, expect, it } from "vite-plus/test";
import {
  parseBlackholeExtensionStatus,
  blackholeCompactLineThreshold,
  providerHasBlackhole,
  resolveThreadCompactionSavings,
  summarizeThreadCompactionSavings,
} from "./blackholeStatus.logic";

describe("parseBlackholeExtensionStatus", () => {
  it("parses idle gauges with ANSI codes", () => {
    const parsed = parseBlackholeExtensionStatus([
      {
        key: "blackhole",
        text: "\u001b[32mbh\u001b[0m O▕████░░░░▏  P▕██░░░░░░▏  X▕█░░░░░░░▏",
      },
    ]);
    expect(parsed).toEqual({
      memoryEnabled: true,
      observerFraction: 0.5,
      poolFraction: 0.25,
      compactionFraction: 0.125,
      worker: null,
    });
  });

  it("parses active and settled worker states", () => {
    expect(
      parseBlackholeExtensionStatus([
        { key: "blackhole", text: "bh O▕████████▏  P▕░░░░░░░░▏  X▕██░░░░░░▏  ⠋ [observer]" },
      ])?.worker,
    ).toEqual({ kind: "running", phase: "observer" });

    expect(
      parseBlackholeExtensionStatus([
        { key: "blackhole", text: "bh O▕████████▏  P▕░░░░░░░░▏  X▕██░░░░░░▏  • [reflector]" },
      ])?.worker,
    ).toEqual({ kind: "running", phase: "reflector" });

    expect(
      parseBlackholeExtensionStatus([
        { key: "blackhole", text: "bh O▕░░░░░░░░▏  P▕███░░░░░▏  X▕██░░░░░░▏  ✓ [observer] +4" },
      ])?.worker,
    ).toEqual({ kind: "done", phase: "observer", delta: 4, note: null });
  });

  it("detects memory-disabled status when O and P are omitted", () => {
    const parsed = parseBlackholeExtensionStatus([{ key: "blackhole", text: "bh X▕███░░░░░▏" }]);
    expect(parsed).toEqual({
      memoryEnabled: false,
      observerFraction: null,
      poolFraction: null,
      compactionFraction: 0.375,
      worker: null,
    });
  });

  it("returns null when blackhole status is absent", () => {
    expect(parseBlackholeExtensionStatus([{ key: "other", text: "hello" }])).toBeNull();
  });
});

describe("providerHasBlackhole", () => {
  it("is installed on a Pi instance that lists the /blackhole command, whatever its session", () => {
    const commands = [{ name: "compact" }, { name: "blackhole" }];
    expect(providerHasBlackhole("pi", commands, true)).toBe(true);
    expect(providerHasBlackhole("pi", [{ name: "compact" }], true)).toBe(false);
    expect(providerHasBlackhole(null, commands, true)).toBe(false);
  });

  it("is installed on every other harness while T3 compacts with Blackhole", () => {
    expect(providerHasBlackhole("claudeAgent", [], true)).toBe(true);
    expect(providerHasBlackhole("antigravity", [], true)).toBe(true);
    expect(providerHasBlackhole("codex", [], false)).toBe(false);
  });
});

describe("blackholeCompactLineThreshold", () => {
  const at = (driver: string, compactAt: number | null, serverBlackhole = true) =>
    blackholeCompactLineThreshold({
      driver,
      serverBlackhole,
      compactAt,
      windowTokens: 200_000,
      reported: 190_000,
    });

  it("shows Blackhole's point, not the harness's backstop, where T3 compacts", () => {
    expect(at("codex", 120_000)).toBe(120_000);
    // pi-blackhole's default curve for a 200k window.
    expect(at("claudeAgent", null)).toBe(149_482);
  });

  it("keeps the harness's point on Pi and with Blackhole compaction off", () => {
    expect(at("pi", 120_000)).toBe(190_000);
    expect(at("codex", 120_000, false)).toBe(190_000);
  });
});

describe("summarizeThreadCompactionSavings", () => {
  it("sums context tokens freed across completed compactions in the thread", () => {
    expect(
      summarizeThreadCompactionSavings([
        { type: "message", status: "completed" },
        { type: "compaction", status: "running", beforeTokenCount: 90_000 },
        {
          type: "compaction",
          status: "completed",
          beforeTokenCount: 120_000,
          afterTokenCount: 25_000,
        },
        {
          type: "compaction",
          status: "completed",
          beforeTokenCount: 80_000,
          afterTokenCount: 29_000,
        },
      ]),
    ).toEqual({
      compactionCount: 2,
      freedTokens: 146_000,
    });
  });

  it("prefers the whole-thread compactionSummary over a bounded turnItems window", () => {
    expect(
      resolveThreadCompactionSavings({
        compactionSummary: { compactionCount: 3, freedTokens: 210_000 },
        turnItems: [
          {
            type: "compaction",
            status: "completed",
            beforeTokenCount: 80_000,
            afterTokenCount: 29_000,
          },
        ],
      }),
    ).toEqual({ compactionCount: 3, freedTokens: 210_000 });
  });
});
