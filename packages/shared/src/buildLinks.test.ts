import { describe, expect, it } from "vite-plus/test";

import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

import {
  findBuildMentions,
  labelBuildMentions,
  parseBuildReference,
  rehypeBuildMentions,
} from "./buildLinks.ts";
import {
  CHAT_MARKDOWN_REMARK_PLUGINS,
  createChatMarkdownRehypePlugins,
} from "./markdownPipeline.ts";

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
    expect(parseBuildReference("#4059")).toEqual({ kind: "number", number: 4059, origin: null });
    expect(parseBuildReference("4059")).toEqual({ kind: "number", number: 4059, origin: null });
    expect(parseBuildReference(`${origin}/build/specs/1000123/`)).toEqual({
      kind: "number",
      number: 1000123,
      origin,
    });
    expect(parseBuildReference(`${origin}/build/abc`)).toBeNull();
  });

  it("reads friendly refs in any case and normalises them to upper case", () => {
    for (const [written, ref] of [
      ["YS-12", "YS-12"],
      ["ys-12", "YS-12"],
      ["T3-30", "T3-30"],
      ["t3-30", "T3-30"],
      [" YS-12.1 ", "YS-12.1"],
    ] as const)
      expect(parseBuildReference(written)).toEqual({ kind: "ref", ref });
  });

  it("refuses malformed refs and unsafe numbers", () => {
    for (const written of ["YS-12.x", "YS-0", "YS-", "YS-12.0", "3T-1", "YS-12.1.2", "0", "#0"])
      expect(parseBuildReference(written)).toBeNull();
    expect(parseBuildReference("9".repeat(20))).toBeNull();
    // HQ's numbers are Postgres integers: one past the bound is malformed, not an unknown item.
    for (const written of [
      "#2147483648",
      "2147483648",
      "YS-2147483648",
      "YS-1.2147483648",
      "https://hq.example/build/2147483648",
    ])
      expect(parseBuildReference(written)).toBeNull();
    expect(parseBuildReference("#2147483647")).toEqual({
      kind: "number",
      number: 2147483647,
      origin: null,
    });
  });
});

describe("rehypeBuildMentions", () => {
  const origin = "https://hq.example";
  type Node = {
    type: string;
    tagName?: string;
    properties?: Record<string, unknown>;
    children?: Node[];
  };
  const processor = unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(createChatMarkdownRehypePlugins([[rehypeBuildMentions, { origin }]]));
  /** The mention anchors the chat pipeline produces for `markdown`. */
  const chips = (markdown: string) => {
    const found: Node[] = [];
    const visit = (node: Node) => {
      if (node.tagName === "a" && node.properties?.dataBuildMention) found.push(node);
      node.children?.forEach(visit);
    };
    visit(processor.runSync(processor.parse(markdown)) as Node);
    return found;
  };

  it("links #<number> to the project's HQ and keeps the mark through sanitize", () => {
    expect(chips("Fixes #1000123 and #78.")).toMatchObject([
      {
        properties: { href: `${origin}/build/1000123`, dataBuildMention: "reference" },
        children: [{ type: "text", value: "#1000123" }],
      },
    ]);
  });

  it("leaves markdown and raw HTML code and links as written", () => {
    for (const markdown of [
      "`#1000123`",
      "```\n#1000123\n```",
      "[about #1000123](https://example.com)",
      "<code>#1000123</code>",
      "<pre>#1000123</pre>",
      '<a href="https://example.com">#1000123</a>',
    ])
      expect(chips(markdown), markdown).toEqual([]);
  });

  it("still links a mention beside raw HTML code", () => {
    expect(chips("#1000135 <code>#1000136</code> #1000137").map((a) => a.properties?.href)).toEqual(
      [`${origin}/build/1000135`, `${origin}/build/1000137`],
    );
  });
});
