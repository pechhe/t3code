import { msg } from "gt-react";
import { use, type MouseEvent as ReactMouseEvent } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import { MarkdownLinkContext } from "./ChatMarkdownMedia";

function bounceCopiedInlineCode(element: HTMLElement) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (element.getClientRects().length !== 1) return;
  for (const animation of element.getAnimations()) animation.cancel();
  element.dataset.copyBounce = "";
  element.animate([{ scale: 1 }, { scale: 0.93, offset: 0.35 }, { scale: 1.02 }, { scale: 1 }], {
    duration: 260,
    easing: "ease-out",
  }).onfinish = () => {
    delete element.dataset.copyBounce;
  };
}

// Native word selection stops at hyphens and dots, so a double-click takes the whole span.
function selectInlineCode(event: ReactMouseEvent<HTMLElement>) {
  window.getSelection()?.selectAllChildren(event.currentTarget);
}

function CopyOnClickCode({
  text,
  children,
  ...props
}: React.ComponentProps<"code"> & { text: string }) {
  const { copyToClipboard } = useCopyToClipboard({
    target: {
      target: "code",
      unavailableMessage: msg("Clipboard API is unavailable while copying code."),
      failureMessage: msg("Failed to copy code to the clipboard."),
    },
    timeout: 1200,
  });
  return (
    <code
      {...props}
      className={cn(props.className, "cursor-pointer")}
      onClick={(event) => {
        if (window.getSelection()?.toString()) return;
        copyToClipboard(text);
        bounceCopiedInlineCode(event.currentTarget);
      }}
    >
      {children}
    </code>
  );
}

/** Inline code copies its text on click; a text selection is left alone. Inside a link it only selects. */
export function CopyableInlineCode({
  text,
  children,
  ...props
}: React.ComponentProps<"code"> & { text: string }) {
  const insideLink = use(MarkdownLinkContext);
  if (insideLink) {
    return (
      <code {...props} onDoubleClick={selectInlineCode}>
        {children}
      </code>
    );
  }
  return (
    <CopyOnClickCode {...props} text={text} onDoubleClick={selectInlineCode}>
      {children}
    </CopyOnClickCode>
  );
}
