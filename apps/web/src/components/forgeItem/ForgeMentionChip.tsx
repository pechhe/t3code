import { presentForgeWorkItem } from "@t3tools/client-runtime/state/forge-work-items";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { forgeWorkItems } from "~/state/forgeWorkItems";
import { useEnvironmentQuery } from "~/state/query";
import { ForgeItemLabel } from "./ForgeItemLabel";
import { ForgeStatusDot } from "./ForgeWorkItemCard";
import { ForgeWorkItemPreview } from "./ForgeWorkItemPreview";

/**
 * A Forge item mentioned in a message, as a chip with its live title and status and the item's
 * hover card. It reads Forge only while mounted, and the timeline mounts only what is on screen.
 * Until Forge answers, or when it doesn't know the number, the mention shows as `fallback`.
 */
export function ForgeMentionChip(props: {
  threadRef: ScopedThreadRef;
  number: number;
  /** What copying the chip gives: the mention as written. */
  copy: string;
  fallback: ReactNode;
}) {
  const { threadRef, number } = props;
  const mentions = useEnvironmentQuery(
    forgeWorkItems.mentions({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, numbers: [number] },
    }),
  );
  const link = mentions.data?.items.find((found) => found.number === number);
  if (link === undefined || link.item === null) return props.fallback;
  const shown = presentForgeWorkItem(link);
  return (
    <ForgeWorkItemPreview
      threadRef={threadRef}
      link={link}
      trigger={
        <a
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          data-markdown-copy={props.copy}
        />
      }
    >
      <span aria-hidden className="ms-[0.15em] me-[0.25em] text-xs">
        {shown.glyph}
      </span>
      {shown.numberHint === undefined ? null : (
        <ForgeItemLabel
          item={{ number: link.number, ref: link.item.ref }}
          className="me-[0.25em] font-medium"
        />
      )}
      {shown.title}
      <ForgeStatusDot
        tone={shown.tone}
        className="ms-[0.35em] inline-block [vertical-align:0.05em]"
      />
    </ForgeWorkItemPreview>
  );
}
