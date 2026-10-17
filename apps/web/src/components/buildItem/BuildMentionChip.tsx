import { presentBuildWorkItem } from "@t3tools/client-runtime/state/build-work-items";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { buildWorkItems } from "~/state/buildWorkItems";
import { useEnvironmentQuery } from "~/state/query";
import { BuildStatusDot } from "./BuildWorkItemCard";
import { BuildWorkItemPreview } from "./BuildWorkItemPreview";

/**
 * A Build item mentioned in a message, as a chip with its live title and status and the item's
 * hover card. It reads Build only while mounted, and the timeline mounts only what is on screen.
 * Until Build answers, or when it doesn't know the number, the mention shows as `fallback`.
 */
export function BuildMentionChip(props: {
  threadRef: ScopedThreadRef;
  number: number;
  /** What copying the chip gives: the mention as written. */
  copy: string;
  fallback: ReactNode;
}) {
  const { threadRef, number } = props;
  const mentions = useEnvironmentQuery(
    buildWorkItems.mentions({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, numbers: [number] },
    }),
  );
  const link = mentions.data?.items.find((found) => found.number === number);
  if (link === undefined || link.item === null) return props.fallback;
  const shown = presentBuildWorkItem(link);
  return (
    <BuildWorkItemPreview
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
      {shown.title}
      <BuildStatusDot
        tone={shown.tone}
        className="ms-[0.35em] inline-block [vertical-align:0.05em]"
      />
    </BuildWorkItemPreview>
  );
}
