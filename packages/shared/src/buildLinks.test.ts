import { describe, expect, it } from "vite-plus/test";

import { findBuildMentions, labelBuildMentions, parseBuildReference } from "./buildLinks.ts";

const origin = "https://hq.example";
const numbers = (markdown: string) =>
  findBuildMentions(markdown, origin).map(({ number, written }) => `${written}:${number}`);

describe("findBuildMentions", () => {
  it("finds #<number> of seven or more digits and Build links on the project's HQ", () => {
    expect(
      numbers(
        `See #1000123, [the Spec](${origin}/build/specs/1000124) and ${origin}/build/1000125.`,
      ),
    ).toEqual(["reference:1000123", "link:1000124", "link:1000125"]);
  });

  it("leaves GitHub references, code, other HQs and non-mentions alone", () => {
    expect(
      numbers(
        [
          "Fixes #78 and #999999.",
          "`#1000123` and",
          "```\n#1000124\n```",
          "https://other.example/build/1000125",
          `${origin}/build/abc`,
          "\\#1000126 a#1000127 &#1000128; /path#1000129 1000130",
          '<a href="x">#1000131</a> <code>#1000132</code>',
        ].join("\n\n"),
      ),
    ).toEqual([]);
  });
});

describe("labelBuildMentions", () => {
  it("relabels mentions of known items, escaped as plain text, and leaves unknown ones", () => {
    const label = String.raw`[◇ Fix \`x\` \[beta\] \*now\*]`;
    expect(
      labelBuildMentions(`#1000123, #1000999 and [link](${origin}/build/1000123)`, origin, (n) =>
        n === 1000123 ? "◇ Fix `x` [beta] *now*" : undefined,
      ),
    ).toBe(`${label}(${origin}/build/1000123), #1000999 and ${label}(${origin}/build/1000123)`);
  });
});

describe("parseBuildReference", () => {
  it("reads Build URLs, #<number> and bare numbers", () => {
    expect(parseBuildReference("#1000123")).toEqual({ number: 1000123, origin: null });
    expect(parseBuildReference(`${origin}/build/specs/1000123/`)).toEqual({
      number: 1000123,
      origin,
    });
    expect(parseBuildReference(`${origin}/build/abc`)).toBeNull();
  });
});
