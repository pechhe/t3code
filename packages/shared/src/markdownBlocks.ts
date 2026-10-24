import remarkParse from "remark-parse";
import { unified, type PluggableList } from "unified";

import { CHAT_MARKDOWN_REMARK_PLUGINS } from "./markdownPipeline.ts";

type BlockAstNode = {
  readonly type: string;
  readonly value?: string;
  readonly position?: { readonly start: { readonly offset?: number } };
  readonly children?: ReadonlyArray<BlockAstNode>;
};

export interface MarkdownBlock {
  readonly source: string;
  /** Where `source` starts in the whole message, for offsets read back from a block. */
  readonly offset: number;
}

/** GitHub's heading anchor: lowercased, punctuation dropped, spaces as hyphens. */
function githubHeadingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

const plainText = (node: BlockAstNode): string =>
  node.value ?? node.children?.map(plainText).join("") ?? "";

/**
 * True when meaning crosses top-level blocks: a definition, raw HTML (a tag can
 * close in a later block), or two headings whose ids would be numbered apart.
 */
function crossesBlocks(root: BlockAstNode): boolean {
  const slugs = new Set<string>();
  const visit = (node: BlockAstNode): boolean => {
    if (node.type === "definition" || node.type === "footnoteDefinition") return true;
    if (node.type === "html") return true;
    if (node.type === "heading") {
      const slug = githubHeadingSlug(plainText(node));
      if (slugs.has(slug)) return true;
      slugs.add(slug);
      return false;
    }
    return node.children?.some(visit) ?? false;
  };
  return visit(root);
}

/**
 * Splits a chat message at its top-level markdown blocks, so a renderer can parse
 * and render each block on its own and skip the blocks a streamed token left
 * unchanged. Each block parses to the same tree alone as in the whole message,
 * except where meaning crosses blocks; those messages stay one block:
 * - link and footnote definitions resolve document-wide;
 * - raw HTML can open in one block and close in a later one (`<details>`, `<b>`);
 * - headings that share an id take numbered ids in document order.
 *
 * `parsePlugins` join the parse that finds the blocks, such as an incremental
 * parser; they must not change the block structure.
 */
export function splitMarkdownBlocks(
  text: string,
  parsePlugins: PluggableList = [],
): ReadonlyArray<MarkdownBlock> {
  const whole = [{ source: text, offset: 0 }];
  // Offsets are into the parser's normalised text when it rewrites line endings or a BOM.
  if (text.includes("\r") || text.includes("\uFEFF")) return whole;
  const root = unified()
    .use(remarkParse)
    .use(CHAT_MARKDOWN_REMARK_PLUGINS)
    .use(parsePlugins)
    .parse(text) as BlockAstNode;
  const children = root.children ?? [];
  if (children.length < 2 || crossesBlocks(root)) return whole;

  const starts: number[] = [];
  for (const child of children) {
    const start = child.position?.start.offset;
    if (start === undefined) return whole;
    starts.push(start);
  }
  starts[0] = 0;
  return starts.map((offset, index) => ({
    source: text.slice(offset, starts[index + 1] ?? text.length),
    offset,
  }));
}
