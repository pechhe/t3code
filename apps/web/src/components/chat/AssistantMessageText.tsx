import { shouldPreserveAssistantLineBreaks } from "@t3tools/shared/markdownPipeline";
import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from "react";

import { cn } from "~/lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { observeResize } from "~/lib/observeResize";
import { revealEnd } from "./AssistantMessageText.logic";

// Screen readers skim a transcript by heading, so every message announces its
// author as one. The thread title in ChatHeader is an <h2>; headings written
// inside a message are exposed below this level. Visually hidden and excluded
// from selection so sighted users and copied text are unaffected.
export const MESSAGE_HEADING_LEVEL = 3;

// A streaming reply is revealed by a clock rather than as text arrives, because
// providers send text in uneven bursts. The playhead trails the received text by
// about LAG and eases its speed, so bursts and stalls become gentle speed changes.
const REVEAL_LAG_S = 0.45;
const REVEAL_MIN_CPS = 45;
const REVEAL_MAX_CPS = 1200;
const REVEAL_EASE_S = 0.18;
/**
 * The prefix of a streaming reply to show, revealed a sentence at a time by a
 * steady clock. Keeps revealing after the stream ends until it has caught up. Text
 * present when the message mounts shows at once, so opening a thread never replays.
 */
function useSentenceReveal(text: string, streaming: boolean) {
  const [shown, setShown] = useState(text.length);
  const clock = useRef({ shown: text.length, playhead: text.length, speed: 0 });
  const latest = useRef({ text, streaming });
  useLayoutEffect(() => {
    latest.current = { text, streaming };
  }, [text, streaming]);
  const behind = shown < text.length;

  useEffect(() => {
    if (!behind) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      const state = clock.current;
      const { text: target, streaming: live } = latest.current;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const backlog = target.length - state.playhead;
      const desired =
        backlog > 0.5
          ? Math.min(REVEAL_MAX_CPS, Math.max(backlog / REVEAL_LAG_S, REVEAL_MIN_CPS))
          : 0;
      state.speed += (desired - state.speed) * (1 - Math.exp(-dt / REVEAL_EASE_S));
      state.playhead = Math.min(target.length, state.playhead + state.speed * dt);
      const end = revealEnd(target, state.shown, state.playhead, live);
      if (end > state.shown) {
        state.shown = end;
        setShown(end);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [behind]);

  // A rewritten, shorter message shows as it is.
  useEffect(() => {
    const state = clock.current;
    if (state.shown <= text.length) return;
    state.shown = state.playhead = text.length;
    setShown(text.length);
  }, [text.length]);

  return { text: behind ? text.slice(0, shown) : text, revealing: behind };
}

/**
 * Eases the height of streaming content as it grows, so a new sentence opens its
 * space smoothly and the rows below glide down instead of jumping a line at a time.
 */
function useEasedHeight(active: boolean) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;
    if (!active) {
      outer.style.height = "";
      return;
    }
    const fit = () => {
      outer.style.height = `${inner.offsetHeight}px`;
    };
    return observeResize(inner, fit);
  }, [active]);
  return { outerRef, innerRef };
}

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
  const reveal = useSentenceReveal(text, streaming);
  const active = streaming || reveal.revealing;
  const { outerRef, innerRef } = useEasedHeight(active);
  return (
    <div ref={outerRef} className={active ? "chat-stream-height" : undefined}>
      <div ref={innerRef} className="flow-root">
        <ChatMarkdown
          {...markdown}
          className={cn("font-response", className)}
          text={reveal.text}
          isStreaming={active}
          lineBreaks={shouldPreserveAssistantLineBreaks(reveal.text)}
          headingLevelOffset={MESSAGE_HEADING_LEVEL}
        />
      </div>
    </div>
  );
}
