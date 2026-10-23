import { presentForgeWorkItem } from "@t3tools/client-runtime/state/forge-work-items";
import type { ForgeWorkItemView, ScopedThreadRef } from "@t3tools/contracts";
import { type ReactElement, type ReactNode, useState } from "react";

import { randomUUID } from "~/lib/utils";
import { forgeWorkItems } from "~/state/forgeWorkItems";
import { useEnvironmentQuery } from "~/state/query";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "../ui/preview-card";
import { ForgeItemLabel } from "./ForgeItemLabel";
import { ForgeWorkItemCard } from "./ForgeWorkItemCard";

/**
 * A Forge item's hover card around the element that names it: the header segment or a chat
 * chip. Each opening reads Forge at once, and a closed card costs nothing.
 */
export function ForgeWorkItemPreview(props: {
  threadRef: ScopedThreadRef;
  link: ForgeWorkItemView;
  trigger: ReactElement;
  children: ReactNode;
}) {
  const { threadRef, link } = props;
  const shown = presentForgeWorkItem(link);
  const [opening, setOpening] = useState<string | null>(null);
  const cardQuery = useEnvironmentQuery(
    opening === null
      ? null
      : forgeWorkItems.card({
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
            <ForgeWorkItemCard card={cardQuery.data} />
          ) : (
            <div className="text-xs">
              <p className="font-medium text-foreground">{shown.title}</p>
              <p className="text-muted-foreground">
                <ForgeItemLabel item={{ number: link.number, ref: link.item?.ref }} />
                {shown.statusLabel ? ` · ${shown.statusLabel}` : ""}
              </p>
              {cardQuery.error !== null || shown.unavailable ? (
                <p className="mt-1 text-muted-foreground">
                  Forge couldn't be reached
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
