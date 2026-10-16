import { shouldPreserveAssistantLineBreaks } from "@t3tools/shared/markdownPipeline";
import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";
import ChatMarkdown from "../ChatMarkdown";

// Screen readers skim a transcript by heading, so every message announces its
// author as one. The thread title in ChatHeader is an <h2>; headings written
// inside a message are exposed below this level. Visually hidden and excluded
// from selection so sighted users and copied text are unaffected.
export const MESSAGE_HEADING_LEVEL = 3;

/**
 * An assistant message's text, rendered the same way wherever one appears: the
 * main timeline and the side chat card. Changes to how assistant text streams
 * in or is formatted belong here or in `ChatMarkdown`, not in either caller.
 * Agent prose takes the Response font, not the interface font.
 */
export function AssistantMessageText({
  text,
  streaming,
  className,
  ...markdown
}: Omit<
  ComponentProps<typeof ChatMarkdown>,
  "isStreaming" | "lineBreaks" | "headingLevelOffset"
> & {
  readonly streaming: boolean;
}) {
  return (
    <ChatMarkdown
      {...markdown}
      className={cn("font-response", className)}
      text={text}
      isStreaming={streaming}
      lineBreaks={shouldPreserveAssistantLineBreaks(text)}
      headingLevelOffset={MESSAGE_HEADING_LEVEL}
    />
  );
}
