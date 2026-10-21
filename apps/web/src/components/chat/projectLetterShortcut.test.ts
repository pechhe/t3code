import { describe, expect, it } from "vite-plus/test";

import { nextProjectForLetter, projectShortcutLetter } from "./projectLetterShortcut";

const entries = [
  { key: "y", name: "YardSmith", value: 1 },
  { key: "s1", name: "SlipJay", value: 2 },
  { key: "s2", name: "Splay", value: 3 },
  { key: "a", name: ".agents", value: 4 },
];

describe("nextProjectForLetter", () => {
  it("selects the first project starting with the letter", () => {
    expect(nextProjectForLetter(entries, "y", "s1")).toBe(1);
    expect(nextProjectForLetter(entries, "s", "y")).toBe(2);
  });

  it("rotates through projects sharing the letter, wrapping around", () => {
    expect(nextProjectForLetter(entries, "s", "s1")).toBe(3);
    expect(nextProjectForLetter(entries, "s", "s2")).toBe(2);
  });

  it("is null when nothing starts with the letter", () => {
    expect(nextProjectForLetter(entries, "q", "y")).toBeNull();
  });

  it("skips leading punctuation", () => {
    expect(projectShortcutLetter(".agents")).toBe("a");
  });
});
