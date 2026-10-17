import { describe, expect, it } from "vite-plus/test";

import type { MarkdownNode } from "~/vendor/mdast-find-and-replace";
import { remarkBuildMentions } from "./buildMentionMarkdown";

const origin = "https://hq.example";
const text = (value: string): MarkdownNode => ({ type: "text", value });
const paragraph = (...children: MarkdownNode[]): MarkdownNode => ({ type: "paragraph", children });
const run = (...children: MarkdownNode[]) => {
  const tree: MarkdownNode = { type: "root", children };
  remarkBuildMentions({ origin })(tree);
  return tree.children;
};

describe("remarkBuildMentions", () => {
  it("links #<number> mentions to the project's HQ, marked as written references", () => {
    expect(run(paragraph(text("Fixes #1000123 and #78.")))).toEqual([
      paragraph(
        text("Fixes "),
        {
          type: "link",
          url: `${origin}/build/1000123`,
          data: { hProperties: { dataBuildMention: "reference" } },
          children: [text("#1000123")],
        },
        text(" and #78."),
      ),
    ]);
  });

  it("leaves code and mentions inside links as written", () => {
    const untouched = [
      paragraph(
        { type: "inlineCode", value: "#1000123" },
        { type: "link", url: "https://example.com", children: [text("about #1000124")] },
      ),
      { type: "code", value: "#1000125" },
    ];
    expect(run(...structuredClone(untouched))).toEqual(untouched);
  });
});
