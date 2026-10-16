import {
  type BuildStatusTone,
  presentBuildWorkItem,
} from "@t3tools/client-runtime/state/build-work-items";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { BuildWorkItemView, ScopedThreadRef } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { buildWorkItems } from "~/state/buildWorkItems";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspaceBreadcrumbText } from "../WorkspaceBreadcrumb";
import { openLinkBuildItemDialog } from "./LinkBuildItemDialog";

const DOT_CLASSES: Record<BuildStatusTone, string> = {
  "not-started": "border border-muted-foreground/70",
  "in-progress": "bg-amber-500",
  landed: "bg-emerald-500",
  accepted: "bg-emerald-500 ring-2 ring-emerald-500/30",
  dropped: "bg-muted-foreground/50",
  unknown: "bg-muted-foreground/50",
};

/**
 * The thread's Build Spec or Ticket as a breadcrumb segment. Clicking it opens the item in HQ;
 * its menu changes or removes the link. Held and Blocked sit beside the status dot, separate
 * from status, and Blocked comes only from the waits Build reports.
 */
export function BuildWorkItemSegment(props: {
  threadRef: ScopedThreadRef;
  link: BuildWorkItemView;
  canEdit: boolean;
}) {
  const { threadRef, link, canEdit } = props;
  const shown = presentBuildWorkItem(link);
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
      <Tooltip>
        <TooltipTrigger
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
          <span
            aria-hidden
            className={cn("size-2 shrink-0 rounded-full", DOT_CLASSES[shown.tone])}
          />
          {shown.held ? (
            <span className="shrink-0 font-medium text-2xs text-orange-600 dark:text-orange-400">
              ⏸ Held
            </span>
          ) : null}
          {shown.blocked ? (
            <span className="shrink-0 font-medium text-2xs text-red-600 dark:text-red-400">
              ⛓ Blocked
            </span>
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="top">
          {shown.title}
          <span className="block text-muted-foreground">
            {[`#${link.number}`, shown.statusLabel].filter(Boolean).join(" · ")}
          </span>
          {shown.unavailable ? (
            <span className="block text-muted-foreground">
              Build couldn't be reached
              {link.readAt ? ` · updated ${formatRelativeTimeLabel(link.readAt)}` : ""}
            </span>
          ) : null}
        </TooltipPopup>
      </Tooltip>
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
