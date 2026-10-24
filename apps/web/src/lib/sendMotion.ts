/**
 * A sent message's trip from the composer into the thread. As it sends, the composer
 * records where its text sat; the user bubble that mounts within a moment plays its
 * arrival from there. `lift` flies the bubble from the composer text to its place;
 * `vacuum` pulls a copy of the text up and out of the composer while the bubble rises
 * in. A first send from a new thread always lifts, handing the text to the first
 * message while the composer glides down. Every motion runs once and moves only
 * transform and opacity.
 */
import type { SendMotion } from "@t3tools/contracts/settings";

import { getClientSettings } from "~/hooks/useSettings";

/** A bubble mounting later than this belongs to something else, such as a queued send. */
const ORIGIN_TTL_MS = 1_500;
const LIFT_MS = 520;
const HANDOFF_MS = 700;
const LIFT_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

type ActiveMotion = Exclude<SendMotion, "off">;

interface SendOrigin {
  readonly rect: DOMRect;
  readonly at: number;
  readonly motion: ActiveMotion;
  readonly handoff: boolean;
}

let pendingOrigin: SendOrigin | null = null;

/** The motion to play, or null while it is off or the system asks for reduced motion. */
function activeSendMotion(): ActiveMotion | null {
  const motion = getClientSettings().sendMotion;
  if (motion === "off") return null;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return null;
  return motion;
}

/**
 * Called by the composer just before it clears. `editor` is the text surface; a send
 * from the new-thread view (inside `[data-draft-hero]`) hands its text to the first message.
 */
export function recordSendOrigin(editor: HTMLElement | null): void {
  const motion = activeSendMotion();
  if (!motion || !editor) return;
  const rect = editor.getBoundingClientRect();
  const handoff = editor.closest("[data-draft-hero]") !== null;
  pendingOrigin = { rect, at: performance.now(), motion: handoff ? "lift" : motion, handoff };
  if (!handoff && motion === "vacuum") vacuumCopy(editor, rect);
}

/** Pulls a copy of the composer text up and away, as peach-pi's composer did on send. */
function vacuumCopy(editor: HTMLElement, rect: DOMRect): void {
  const style = getComputedStyle(editor);
  const copy = editor.cloneNode(true) as HTMLElement;
  copy.removeAttribute("contenteditable");
  copy.removeAttribute("id");
  copy.setAttribute("aria-hidden", "true");
  copy.inert = true;
  Object.assign(copy.style, {
    position: "fixed",
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    margin: "0",
    overflow: "hidden",
    pointerEvents: "none",
    zIndex: "60",
    color: style.color,
    font: style.font,
    lineHeight: style.lineHeight,
    padding: style.padding,
    transformOrigin: "50% 0%",
  });
  document.body.appendChild(copy);
  copy
    .animate(
      [
        { transform: "none", opacity: 1, filter: "blur(0)" },
        { transform: "translateY(3px) scale(1.012)", opacity: 1, offset: 0.16 },
        { transform: "translateY(-34px) scale(0.05)", opacity: 0, filter: "blur(4px)" },
      ],
      { duration: 380, easing: "cubic-bezier(0.5, 0, 0.75, 0)", fill: "forwards" },
    )
    .finished.catch(() => undefined)
    .finally(() => copy.remove());
}

/**
 * Plays the arrival on a user bubble that has just mounted, when a send is pending.
 * Call from a layout effect: the bubble hides at once, then animates once the timeline
 * has settled its scroll, so it lands where it finally sits.
 */
export function playSendArrival(bubble: HTMLElement): void {
  const origin = pendingOrigin;
  if (!origin || performance.now() - origin.at > ORIGIN_TTL_MS) return;
  pendingOrigin = null;
  bubble.style.opacity = "0";
  requestAnimationFrame(() => {
    bubble.style.opacity = "";
    if (origin.motion === "vacuum") {
      bubble.animate(
        [
          { opacity: 0, transform: "translateY(10px) scale(0.96)" },
          { opacity: 1, transform: "none" },
        ],
        {
          duration: 280,
          delay: 200,
          easing: "cubic-bezier(0.34, 1.3, 0.64, 1)",
          fill: "backwards",
        },
      );
      return;
    }
    const to = bubble.getBoundingClientRect();
    const background = getComputedStyle(bubble).backgroundColor;
    // The text travels bare and the bubble forms around it as it lands.
    bubble.animate(
      [
        {
          transform: `translate(${origin.rect.left - to.left}px, ${origin.rect.top - to.top}px)`,
          backgroundColor: "transparent",
        },
        { backgroundColor: "transparent", offset: 0.55 },
        { transform: "none", backgroundColor: background },
      ],
      { duration: origin.handoff ? HANDOFF_MS : LIFT_MS, easing: LIFT_EASING },
    );
  });
}
