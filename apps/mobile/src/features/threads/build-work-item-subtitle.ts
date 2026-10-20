import type { BuildWorkItemPresentation } from "@t3tools/client-runtime/state/build-work-items";

const STATUS_MARKS: Record<BuildWorkItemPresentation["tone"], string> = {
  "not-started": "○",
  "in-progress": "●",
  landed: "●",
  accepted: "◉",
  dropped: "●",
  unknown: "●",
};

/**
 * The linked item as the native header's plain-text subtitle: glyph, title, a status mark and
 * the Held and Blocked overlays, then the status in words, since text cannot carry the colour.
 */
export function buildWorkItemSubtitle(item: BuildWorkItemPresentation): string {
  return [
    `${item.glyph} ${item.numberHint === undefined ? "" : `${item.label} `}${item.title} ${STATUS_MARKS[item.tone]}`,
    item.statusLabel,
    item.held ? "⏸ Held" : null,
    item.blocked ? "⛓ Blocked" : null,
    item.unavailable ? "Build unreachable" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** A Build item mentioned in a message, inline in its text: glyph, title and status in words. */
export const buildMentionLabel = (item: BuildWorkItemPresentation): string =>
  [
    `${item.glyph} ${item.numberHint === undefined ? "" : `${item.label} `}${item.title}`,
    item.statusLabel,
  ]
    .filter(Boolean)
    .join(" · ");
