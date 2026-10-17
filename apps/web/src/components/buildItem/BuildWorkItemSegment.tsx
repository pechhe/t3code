import {
  type BuildWorkItemPresentation,
  presentBuildWorkItem,
} from "@t3tools/client-runtime/state/build-work-items";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { BuildWorkItemView, ScopedThreadRef } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";

import { buildWorkItems } from "~/state/buildWorkItems";
import { useAtomCommand } from "~/state/use-atom-command";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { WorkspaceBreadcrumbText } from "../WorkspaceBreadcrumb";
import { BuildStatusDot } from "./BuildWorkItemCard";
import { BuildWorkItemPreview } from "./BuildWorkItemPreview";
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
      <BuildWorkItemPreview
        threadRef={threadRef}
        link={link}
        trigger={
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
        <BuildItemFlags shown={shown} />
      </BuildWorkItemPreview>
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

/** The status dot, then Held and Blocked beside it: separate from status, never derived from it. */
export function BuildItemFlags(props: { shown: BuildWorkItemPresentation }) {
  const { shown } = props;
  return (
    <>
      <BuildStatusDot tone={shown.tone} />
      {shown.held ? (
        <span className="shrink-0 font-medium text-2xs text-warning-foreground">⏸ Held</span>
      ) : null}
      {shown.blocked ? (
        <span className="shrink-0 font-medium text-2xs text-error-foreground">⛓ Blocked</span>
      ) : null}
    </>
  );
}
