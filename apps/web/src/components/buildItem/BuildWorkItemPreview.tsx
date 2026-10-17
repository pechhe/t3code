import { presentBuildWorkItem } from "@t3tools/client-runtime/state/build-work-items";
import type { BuildWorkItemView, ScopedThreadRef } from "@t3tools/contracts";
import { type ReactElement, type ReactNode, useState } from "react";

import { randomUUID } from "~/lib/utils";
import { buildWorkItems } from "~/state/buildWorkItems";
import { useEnvironmentQuery } from "~/state/query";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "../ui/preview-card";
import { BuildWorkItemCard } from "./BuildWorkItemCard";

/**
 * A Build item's hover card around the element that names it: the header segment or a chat
 * chip. Each opening reads Build at once, and a closed card costs nothing.
 */
export function BuildWorkItemPreview(props: {
  threadRef: ScopedThreadRef;
  link: BuildWorkItemView;
  trigger: ReactElement;
  children: ReactNode;
}) {
  const { threadRef, link } = props;
  const shown = presentBuildWorkItem(link);
  const [opening, setOpening] = useState<string | null>(null);
  const cardQuery = useEnvironmentQuery(
    opening === null
      ? null
      : buildWorkItems.card({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, itemId: link.itemId, open: opening },
        }),
  );
  return (
    <PreviewCard
      open={opening !== null}
      onOpenChange={(open) => setOpening(open ? randomUUID() : null)}
    >
      <PreviewCardTrigger delay={350} closeDelay={120} render={props.trigger}>
        {props.children}
      </PreviewCardTrigger>
      <PreviewCardPopup side="bottom" align="start" className="w-80 max-w-[calc(100vw-2rem)]">
        <div className="p-3">
          {cardQuery.data ? (
            <BuildWorkItemCard card={cardQuery.data} />
          ) : (
            <div className="text-xs">
              <p className="font-medium text-foreground">{shown.title}</p>
              <p className="text-muted-foreground">
                {[`#${link.number}`, shown.statusLabel].filter(Boolean).join(" · ")}
              </p>
              {cardQuery.error !== null || shown.unavailable ? (
                <p className="mt-1 text-muted-foreground">
                  Build couldn't be reached
                  {link.readAt ? ` · updated ${formatRelativeTimeLabel(link.readAt)}` : ""}
                </p>
              ) : null}
            </div>
          )}
        </div>
      </PreviewCardPopup>
    </PreviewCard>
  );
}
