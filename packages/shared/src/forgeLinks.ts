/**
 * How T3 recognises a YardSmith HQ Forge item (pechhe/t3code#78): a Forge URL, `#<number>` or a friendly ref such as `YS-12`.
 * The server resolves references with these rules and both clients recognise chat mentions with
 * them, so a mention the client shows is one the server can read.
 */
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { sameHqAddress } from "./hqOrigins.ts";

/**
 * `#<number>` in prose. Forge numbers start at 1,000,000, so GitHub references such as `#78` never
 * match; an escaped `\#`, an HTML entity or a path fragment is not a mention.
 */
const FORGE_MENTION_PATTERN = /(?<![\w/\\&#])#([1-9]\d{6,})(?!\w)/gu;

/** What a reference names: the canonical item number, or a friendly ref such as `YS-12`. */
export type ForgeReference =
  | { readonly kind: "number"; readonly number: number; readonly origin: string | null }
  | { readonly kind: "ref"; readonly ref: string };

/** HQ's bound on Forge numbers, sequences and ordinals (a Postgres `integer`), so a larger one is malformed, not unknown. */
const MAX_FORGE_INTEGER = 2_147_483_647;

const positiveInteger = (digits: string) => {
  const value = Number(digits);
  return Number.isInteger(value) && value > 0 && value <= MAX_FORGE_INTEGER ? value : null;
};

/** `YS-12` or `YS-12.1`, in any case: a letter, then letters or digits, `-`, then 1-based ordinals. */
const FRIENDLY_REF = /^([a-z][a-z\d]*)-(\d+)(?:\.(\d+))?$/iu;

/** A Forge URL on any HQ, `#<number>`, a bare number or a friendly ref (normalised to upper case). */
export function parseForgeReference(reference: string): ForgeReference | null {
  const trimmed = reference.trim();
  const bare = /^#?(\d+)$/u.exec(trimmed);
  if (bare) {
    const number = positiveInteger(bare[1]!);
    return number === null ? null : { kind: "number", number, origin: null };
  }
  const friendly = FRIENDLY_REF.exec(trimmed);
  if (friendly) {
    const [, , sequence, ordinal] = friendly;
    return positiveInteger(sequence!) === null ||
      (ordinal !== undefined && positiveInteger(ordinal) === null)
      ? null
      : { kind: "ref", ref: trimmed.toUpperCase() };
  }
  try {
    const url = new URL(trimmed);
    // Weave answers `/forge/…` and sends `/build/…` there, so a link written either way is read.
    const path = /^\/(?:forge|build)\/(?:specs\/)?(\d+)\/?$/u.exec(url.pathname);
    const number = path ? positiveInteger(path[1]!) : null;
    return number === null ? null : { kind: "number", number, origin: url.origin };
  } catch {
    return null;
  }
}

export const forgeItemUrl = (origin: string, number: number) => `${origin}/forge/${number}`;

/**
 * The item a link names, only when it is a Forge URL on `origin`: another HQ's link stays a link.
 * A link written at an address Weave has moved on from belongs to the Weave at `origin`.
 */
export function forgeItemNumberFromUrl(href: string, origin: string): number | null {
  // Cheaper than parsing every ordinary link in a message; a Forge URL always has this path.
  // `/build/` still names one: Weave redirects it (YS-185).
  if (!href.includes("/forge/") && !href.includes("/build/")) return null;
  const parsed = parseForgeReference(href);
  return parsed?.kind === "number" && parsed.origin !== null && sameHqAddress(parsed.origin, origin)
    ? parsed.number
    : null;
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
export interface ForgeMention {
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

/** The Forge mentions in markdown, outside code, against T3's Weave `origin`. */
export function findForgeMentions(markdown: string, origin: string): ForgeMention[] {
  if (!markdown.includes("#") && !markdown.includes("/forge/") && !markdown.includes("/build/"))
    return [];
  const mentions: ForgeMention[] = [];
  const visit = (node: MarkdownNode) => {
    if (SKIPPED_NODES.has(node.type)) return;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (node.type === "link") {
      const number = node.url === undefined ? null : forgeItemNumberFromUrl(node.url, origin);
      if (number !== null && start !== undefined && end !== undefined)
        mentions.push({ number, start, end, written: "link" });
      return;
    }
    if (node.type === "text") {
      if (start === undefined || end === undefined) return;
      for (const match of markdown.slice(start, end).matchAll(FORGE_MENTION_PATTERN)) {
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
export function labelForgeMentions(
  markdown: string,
  origin: string,
  label: (number: number) => string | undefined,
): string {
  const mentions = findForgeMentions(markdown, origin);
  for (let index = mentions.length - 1; index >= 0; index--) {
    const mention = mentions[index]!;
    const text = label(mention.number);
    if (text === undefined) continue;
    // A Forge title is plain text: escape anything markdown would read as syntax.
    const escaped = text.replace(/[\\`*_{}[\]()#+\-.!<>|~]/gu, "\\$&");
    markdown =
      markdown.slice(0, mention.start) +
      `[${escaped}](${forgeItemUrl(origin, mention.number)})` +
      markdown.slice(mention.end);
  }
  return markdown;
}

type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

/** A mention never shows as a chip in code, a link or text the browser doesn't render. */
const IGNORED_TAGS = new Set(["a", "code", "pre", "script", "style"]);

/**
 * Turns `#<number>` into a link to the item on T3's HQ, marked so the anchor can show
 * it as written when Forge doesn't know the number. It runs on the HTML tree after raw HTML is
 * parsed, so `<code>` and `<a>` written as HTML leave mentions as written, like markdown code
 * and links. Forge links already written stay as they are.
 */
export function rehypeForgeMentions(options: { readonly origin: string }) {
  const visit = (node: HastNode) => {
    if (!node.children) return;
    node.children = node.children.flatMap((child): HastNode[] => {
      if (child.type === "element") {
        if (!IGNORED_TAGS.has(child.tagName ?? "")) visit(child);
        return [child];
      }
      if (child.type !== "text" || child.value === undefined) return [child];
      const parts: HastNode[] = [];
      let last = 0;
      for (const match of child.value.matchAll(FORGE_MENTION_PATTERN)) {
        if (match.index > last)
          parts.push({ type: "text", value: child.value.slice(last, match.index) });
        parts.push({
          type: "element",
          tagName: "a",
          properties: {
            href: forgeItemUrl(options.origin, Number(match[1])),
            dataForgeMention: "reference",
          },
          children: [{ type: "text", value: match[0] }],
        });
        last = match.index + match[0].length;
      }
      if (parts.length === 0) return [child];
      if (last < child.value.length) parts.push({ type: "text", value: child.value.slice(last) });
      return parts;
    });
  };
  return visit;
}
