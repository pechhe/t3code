import { AlarmClockCheck, ArrowDown01, Layers3 } from "lucide-react";
import { describe, expect, it } from "vite-plus/test";
import { lucideIconByName } from "./lib/lucideIconByName";
import { filterProjectIconNames, firstEmoji, isValidProjectMonogram } from "./projectIconOptions";

describe("projectIconOptions", () => {
  it("offers project icons with a legacy spelling, not the installed package's whole set", () => {
    const offered = filterProjectIconNames("");
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.length).toBeLessThan(100);
    for (const name of offered) expect(lucideIconByName(name), name).toBeDefined();
  });

  it("resolves a saved legacy spelling, and leaves an unknown name to the picker's own glyph", () => {
    expect(lucideIconByName("layers-3")).toBe(Layers3);
    expect(lucideIconByName("arrow-down-01")).toBe(ArrowDown01);
    expect(lucideIconByName("arrow-down-0-1")).toBe(ArrowDown01);
    expect(lucideIconByName("alarm-check")).toBe(AlarmClockCheck);
    expect(lucideIconByName("create-lucide-icon")).toBeUndefined();
  });

  it("extracts one complete emoji grapheme", () => {
    expect(firstEmoji("  👩🏽‍💻 hello")).toBe("👩🏽‍💻");
    expect(firstEmoji("🇺🇸 project")).toBe("🇺🇸");
    expect(firstEmoji("1️⃣ project")).toBe("1️⃣");
    expect(firstEmoji("plain text")).toBeNull();
  });

  it("allows monograms of at most two characters", () => {
    for (const [text, valid] of [
      ["T", true],
      ["T3", true],
      ["E\u0301E\u0301", true],
      ["ABC", false],
    ] as const) {
      expect(isValidProjectMonogram(text), text).toBe(valid);
    }
  });
});
