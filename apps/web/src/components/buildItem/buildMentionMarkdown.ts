import { BUILD_MENTION_PATTERN, buildItemUrl } from "@t3tools/shared/buildLinks";

import { findAndReplaceText, type MarkdownNode } from "~/vendor/mdast-find-and-replace";

/** Code is never a text node, so only links need skipping: a mention never nests in a link. */
const IGNORED_TYPES = new Set(["link", "linkReference"]);

/**
 * Turns `#<number>` into a link to the item on the project's HQ, marked so the anchor can show
 * it as written when Build doesn't know the number. Build links already written stay as they are.
 */
export function remarkBuildMentions(options: { readonly origin: string }) {
  return (tree: MarkdownNode) => {
    findAndReplaceText(
      tree,
      BUILD_MENTION_PATTERN,
      (matched) => ({
        type: "link",
        url: buildItemUrl(options.origin, Number(matched.slice(1))),
        data: { hProperties: { dataBuildMention: "reference" } },
        children: [{ type: "text", value: matched }],
      }),
      IGNORED_TYPES,
    );
  };
}
