import { expect, it } from "vite-plus/test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { CHAT_MARKDOWN_REHYPE_PLUGINS, CHAT_MARKDOWN_REMARK_PLUGINS } from "./markdownPipeline.ts";

it("preserves in-app thread links through the shared Markdown sanitizer", () => {
  const processor = unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
  const tree = processor.runSync(
    processor.parse(
      '[Open thread](t3-thread://v1/environment/thread)\n\n<a href="javascript:alert(1)">Unsafe</a>',
    ),
  );
  expect(tree.children[0]).toMatchObject({
    tagName: "p",
    children: [
      {
        tagName: "a",
        properties: { href: "t3-thread://v1/environment/thread" },
        children: [{ type: "text", value: "Open thread" }],
      },
    ],
  });
  expect(JSON.stringify(tree)).not.toContain("javascript:");
});

it("links inline code that is exactly a web URL", () => {
  const processor = unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(CHAT_MARKDOWN_REHYPE_PLUGINS);
  const tree = processor.runSync(
    processor.parse(
      "Open `https://app.executor.sh` then run `curl https://example.com` or `ftp://host`.",
    ),
  );
  const paragraph = tree.children[0];
  expect(paragraph).toMatchObject({
    tagName: "p",
    children: [
      { type: "text", value: "Open " },
      {
        tagName: "a",
        properties: { href: "https://app.executor.sh" },
        children: [
          {
            tagName: "code",
            properties: {},
            children: [{ type: "text", value: "https://app.executor.sh" }],
          },
        ],
      },
      { type: "text", value: " then run " },
      { tagName: "code", properties: { dataInlineCode: "" } },
      { type: "text", value: " or " },
      { tagName: "code", properties: { dataInlineCode: "" } },
      { type: "text", value: "." },
    ],
  });
});
