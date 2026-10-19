import { describe, expect, it } from "vite-plus/test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";

import { splitMarkdownBlocks } from "./markdownBlocks.ts";
import { CHAT_MARKDOWN_REHYPE_PLUGINS, CHAT_MARKDOWN_REMARK_PLUGINS } from "./markdownPipeline.ts";

type Tree = { position?: unknown; children?: Tree[]; [key: string]: unknown };

function render(text: string): Tree[] {
  const processor = unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
  const strip = (node: Tree): Tree => {
    const { position: _position, children, ...rest } = node;
    return children ? { ...rest, children: children.map(strip) } : rest;
  };
  const root = processor.runSync(processor.parse(text)) as Tree;
  // Whitespace between top-level elements is not rendered content.
  return (root.children ?? [])
    .filter((child) => !(child.type === "text" && String(child.value).trim() === ""))
    .map(strip);
}

const MESSAGE = `# Plan

Some **prose** with a [link](https://example.com) and \`code\`.

3. third
4. fourth

   continued paragraph in the item

- [ ] task
- [x] done

> [!NOTE]
> An alert.

| a | b |
| - | - |
| 1 | 2 |

\`\`\`ts
const x = 1;

const y = 2;
\`\`\`

    indented code

Setext heading
--------------

---

Last paragraph`;

describe("splitMarkdownBlocks", () => {
  it("renders a message block by block exactly as it renders whole", () => {
    const blocks = splitMarkdownBlocks(MESSAGE);
    expect(blocks.length).toBeGreaterThan(8);
    expect(blocks.map((block) => block.source).join("")).toBe(MESSAGE);
    for (const block of blocks) {
      expect(MESSAGE.slice(block.offset, block.offset + block.source.length)).toBe(block.source);
    }
    expect(blocks.flatMap((block) => render(block.source))).toEqual(render(MESSAGE));
  });

  it("keeps every prefix of a streaming message equivalent", () => {
    for (let end = 1; end <= MESSAGE.length; end += 7) {
      const text = MESSAGE.slice(0, end);
      const blocks = splitMarkdownBlocks(text);
      expect(blocks.flatMap((block) => render(block.source))).toEqual(render(text));
    }
  });

  it("leaves finished blocks unchanged as text is appended", () => {
    const before = splitMarkdownBlocks("First paragraph.\n\nSecond para");
    const after = splitMarkdownBlocks("First paragraph.\n\nSecond paragraph grows.\n\nThird");
    expect(after[0]).toEqual(before[0]);
    expect(after).toHaveLength(3);
  });

  it.each([
    ["a link definition", "See [docs][d].\n\nMore.\n\n[d]: https://example.com"],
    ["a footnote", "Claim.[^1]\n\nMore.\n\n[^1]: Source."],
    ["raw HTML across blocks", "<details>\n\n**Inside**\n\n</details>\n\nAfter"],
    ["repeated headings", "## Notes\n\none\n\n## Notes\n\ntwo"],
    ["headings sharing an id", "## Notes!\n\none\n\n## notes\n\ntwo"],
    ["inline HTML across paragraphs", "<b>bold\n\nstill bold</b>\n\nAfter"],
    ["CRLF line endings", "One\r\n\r\nTwo"],
  ])("keeps a message with %s whole", (_case, text) => {
    expect(splitMarkdownBlocks(text)).toEqual([{ source: text, offset: 0 }]);
  });
});
