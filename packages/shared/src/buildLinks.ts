/**
 * How T3 recognises a YardSmith HQ Build item (pechhe/t3code#78): a Build URL, or `#<number>`.
 * The server resolves references with these rules and both clients recognise chat mentions with
 * them, so a mention the client shows is one the server can read.
 */
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

/**
 * `#<number>` in prose. Build numbers start at 1,000,000, so GitHub references such as `#78` never
 * match; an escaped `\#`, an HTML entity or a path fragment is not a mention.
 */
export const BUILD_MENTION_PATTERN = /(?<![\w/\\&#])#([1-9]\d{6,})(?!\w)/gu;

/** A Build URL on any HQ, `#<number>` or a bare number. */
export function parseBuildReference(
  reference: string,
): { readonly number: number; readonly origin: string | null } | null {
  const trimmed = reference.trim();
  const bare = /^#?(\d+)$/u.exec(trimmed);
  if (bare) return { number: Number(bare[1]), origin: null };
  try {
    const url = new URL(trimmed);
    const path = /^\/build\/(?:specs\/)?(\d+)\/?$/u.exec(url.pathname);
    return path ? { number: Number(path[1]), origin: url.origin } : null;
  } catch {
    return null;
  }
}

export const buildItemUrl = (origin: string, number: number) => `${origin}/build/${number}`;

/** The item a link names, only when it is a Build URL on `origin`: another HQ's link stays a link. */
export function buildItemNumberFromUrl(href: string, origin: string): number | null {
  if (!href.startsWith(origin)) return null;
  const parsed = parseBuildReference(href);
  return parsed?.origin === origin ? parsed.number : null;
}

type MarkdownNode = {
  readonly type: string;
  readonly url?: string;
  readonly position?:
    | {
        readonly start: { readonly offset?: number | undefined };
        readonly end: { readonly offset?: number | undefined };
      }
    | undefined;
  readonly children?: readonly MarkdownNode[] | undefined;
};

/** Where a mention sits in the markdown source: a `#<number>` in prose, or a whole link. */
export interface BuildMention {
  readonly number: number;
  readonly start: number;
  readonly end: number;
  readonly written: "reference" | "link";
}

const parser = unified().use(remarkParse).use(remarkGfm);
const SKIPPED_NODES = new Set([
  "linkReference",
  "image",
  "imageReference",
  "code",
  "inlineCode",
  "html",
  "definition",
]);

/** The Build mentions in markdown, outside code, against the project's HQ `origin`. */
export function findBuildMentions(markdown: string, origin: string): BuildMention[] {
  if (!markdown.includes("#") && !markdown.includes(`${origin}/build/`)) return [];
  const mentions: BuildMention[] = [];
  const visit = (node: MarkdownNode) => {
    if (SKIPPED_NODES.has(node.type)) return;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (node.type === "link") {
      const number = node.url === undefined ? null : buildItemNumberFromUrl(node.url, origin);
      if (number !== null && start !== undefined && end !== undefined)
        mentions.push({ number, start, end, written: "link" });
      return;
    }
    if (node.type === "text") {
      if (start === undefined || end === undefined) return;
      for (const match of markdown.slice(start, end).matchAll(BUILD_MENTION_PATTERN)) {
        mentions.push({
          number: Number(match[1]),
          start: start + match.index,
          end: start + match.index + match[0].length,
          written: "reference",
        });
      }
      return;
    }
    let protectedHtmlDepth = 0;
    for (const child of node.children ?? []) {
      if (child.type === "html") {
        const childStart = child.position?.start.offset;
        const childEnd = child.position?.end.offset;
        const tag =
          childStart === undefined || childEnd === undefined
            ? ""
            : markdown.slice(childStart, childEnd);
        for (const match of tag.matchAll(/<(\/)?(?:a|code|pre|script|style)(?=[\s>])[^>]*>/giu)) {
          protectedHtmlDepth = Math.max(0, protectedHtmlDepth + (match[1] ? -1 : 1));
        }
      } else if (protectedHtmlDepth === 0) visit(child);
    }
  };
  visit(parser.parse(markdown) as MarkdownNode);
  return mentions;
}

/**
 * Rewrites each mention of an item `label` knows as a link to it carrying that label; a mention
 * of an unknown item stays exactly as written.
 */
export function labelBuildMentions(
  markdown: string,
  origin: string,
  label: (number: number) => string | undefined,
): string {
  const mentions = findBuildMentions(markdown, origin);
  for (let index = mentions.length - 1; index >= 0; index--) {
    const mention = mentions[index]!;
    const text = label(mention.number);
    if (text === undefined) continue;
    // A Build title is plain text: escape anything markdown would read as syntax.
    const escaped = text.replace(/[\\`*_{}[\]()#+\-.!<>|~]/gu, "\\$&");
    markdown =
      markdown.slice(0, mention.start) +
      `[${escaped}](${buildItemUrl(origin, mention.number)})` +
      markdown.slice(mention.end);
  }
  return markdown;
}
