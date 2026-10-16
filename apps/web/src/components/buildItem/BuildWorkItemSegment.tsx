import { presentBuildWorkItem } from "@t3tools/client-runtime/state/build-work-items";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { BuildWorkItemView, ScopedThreadRef } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { randomUUID } from "~/lib/utils";
import { buildWorkItems } from "~/state/buildWorkItems";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "../ui/preview-card";
import { toastManager } from "../ui/toast";
import { WorkspaceBreadcrumbText } from "../WorkspaceBreadcrumb";
import { BuildStatusDot, BuildWorkItemCard } from "./BuildWorkItemCard";
import { openLinkBuildItemDialog } from "./LinkBuildItemDialog";

/**
 * The thread's Build Spec or Ticket as a breadcrumb segment. Hovering shows its card, clicking
 * opens the item in HQ, and its menu changes or removes the link. Held and Blocked sit beside the
 * status dot, separate from status, and Blocked comes only from the waits Build reports.
 */
export function BuildWorkItemSegment(props: {
  threadRef: ScopedThreadRef;
  link: BuildWorkItemView;
  canEdit: boolean;
}) {
  const { threadRef, link, canEdit } = props;
  const shown = presentBuildWorkItem(link);
  // Each opening reads Build at once; a closed card costs nothing.
  const [opening, setOpening] = useState<string | null>(null);
  const cardQuery = useEnvironmentQuery(
    opening === null
      ? null
      : buildWorkItems.card({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, itemId: link.itemId, open: opening },
        }),
  );
  const setLink = useAtomCommand(buildWorkItems.link, { reportFailure: false });
  const unlink = () =>
    void setLink({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, reference: null },
    }).then((result) => {
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Failed to unlink Build item",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    });

  return (
    <div className="group/build-item flex min-w-0 max-w-64 items-center gap-0.5">
      <PreviewCard
        open={opening !== null}
        onOpenChange={(open) => setOpening(open ? randomUUID() : null)}
      >
        <PreviewCardTrigger
          delay={350}
          closeDelay={120}
          render={
            <a
              href={link.url}
              target="_blank"
              rel="noreferrer"
              aria-label={`Open ${shown.title} in HQ`}
              className="inline-flex min-w-0 items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            />
          }
        >
          <span aria-hidden className="shrink-0 text-xs">
            {shown.glyph}
          </span>
          <WorkspaceBreadcrumbText>{shown.title}</WorkspaceBreadcrumbText>
          <BuildStatusDot tone={shown.tone} />
          {shown.held ? (
            <span className="shrink-0 font-medium text-2xs text-warning-foreground">⏸ Held</span>
          ) : null}
          {shown.blocked ? (
            <span className="shrink-0 font-medium text-2xs text-error-foreground">⛓ Blocked</span>
          ) : null}
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
      {canEdit ? (
        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                aria-label="Build item actions"
                className="inline-flex shrink-0 cursor-pointer items-center rounded-sm p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring group-hover/build-item:opacity-100 data-popup-open:opacity-100"
              />
            }
          >
            <ChevronDownIcon aria-hidden className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="start">
            <MenuItem onClick={() => openLinkBuildItemDialog(threadRef)}>Change…</MenuItem>
            <MenuItem onClick={unlink}>Unlink</MenuItem>
          </MenuPopup>
        </Menu>
      ) : null}
    </div>
  );
}
