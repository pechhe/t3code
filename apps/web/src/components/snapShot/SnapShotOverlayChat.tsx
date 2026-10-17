import type { ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronUpIcon, MessageSquareDashedIcon } from "lucide-react";
import { type CSSProperties, useEffect, useRef, useState } from "react";

import type { DraftId } from "~/composerDraftStore";
import { cn } from "~/lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { ProjectChip } from "../ProjectChip";
import { ProjectChipRow } from "../chat/DraftHeroHeadline";
import { useDraftProjectChoice } from "../chat/useDraftProjectChoice";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import type { SnapShotOverlayDock } from "./snapShotOverlayDock";

/** Sends the composer below the screen edge, with the slide the overlay itself uses. */
export const SNAP_SHOT_DOCK_CLASS_NAME =
  "transition-transform duration-200 ease-in-reversed data-snap-shot-docked:translate-y-[100svh] data-snap-shot-docked:ease-in motion-reduce:transition-none";

/**
 * Above the overlay's composer: the project chip while the chat is unsent, then the reply to the
 * latest message. Both ride with the composer when it docks.
 */
export function SnapShotOverlayAbove(props: {
  readonly dock: SnapShotOverlayDock;
  readonly draftId: DraftId | null;
  readonly projectRef: ScopedProjectRef | null;
  readonly projectTitle: string | null;
  readonly threadRef: ScopedThreadRef | null;
  readonly cwd: string | undefined;
}) {
  const { dock } = props;
  if (dock.prompt === null && !dock.working) {
    return props.draftId === null ? null : (
      <SnapShotOverlayProjectChip
        draftId={props.draftId}
        projectRef={props.projectRef}
        projectTitle={props.projectTitle}
      />
    );
  }
  if (dock.prompt === null || dock.reply === null) return null;
  const { threadRef } = props;
  return (
    <div className="surface-glass absolute inset-x-0 bottom-full mb-2 flex max-h-80 flex-col overflow-hidden rounded-2xl border border-border/60 text-foreground shadow-lg">
      <div className="flex shrink-0 items-center gap-1 py-1.5 ps-3.5 pe-1.5">
        <p className="min-w-0 flex-1 truncate text-muted-foreground text-xs">{dock.prompt.text}</p>
        {threadRef ? (
          <Button
            size="compact"
            variant="ghost"
            onClick={() => void window.desktopBridge?.openThreadInMainWindow?.(threadRef)}
          >
            Open in T3
          </Button>
        ) : null}
        <Button size="icon-xs" variant="ghost" aria-label="Hide" onClick={dock.toggle}>
          <ChevronDownIcon />
        </Button>
      </div>
      <div className="min-h-0 overflow-y-auto px-3.5 pb-3 text-sm">
        <ChatMarkdown
          text={dock.reply.text}
          cwd={props.cwd}
          threadRef={threadRef ?? undefined}
          isStreaming={dock.reply.streaming}
        />
      </div>
    </div>
  );
}

/** Stands in for the docked composer: says the agent is working, and brings the composer back. */
export function SnapShotOverlayDockPill({ dock }: { readonly dock: SnapShotOverlayDock }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-5 flex justify-center">
      <button
        type="button"
        data-shown={dock.docked || undefined}
        aria-hidden={!dock.docked}
        tabIndex={dock.docked ? 0 : -1}
        onClick={dock.toggle}
        className="surface-glass inline-flex h-7 translate-y-3 items-center gap-2 rounded-full border border-border/60 px-3 font-medium text-foreground text-xs opacity-0 shadow-lg transition-[opacity,translate] duration-200 data-shown:pointer-events-auto data-shown:translate-y-0 data-shown:opacity-100 motion-reduce:transition-none"
      >
        {dock.working ? <Spinner className="size-3" /> : <ChevronUpIcon className="size-3.5" />}
        {dock.working ? "Working" : "Show reply"}
      </button>
    </div>
  );
}

// A chip floating over another app: its tint over the frosted glass the overlay's other
// surfaces use, rather than over nothing.
const GLASS_CHIP_CLASS_NAME =
  "h-6 max-w-48 px-2 text-xs shadow-sm backdrop-blur-(--glass-blur) backdrop-saturate-(--glass-saturation)";
const GLASS_CHIP_STYLE = {
  "--tint-chip-fill":
    "color-mix(in oklab, var(--tint-chip-accent) 24%, color-mix(in srgb, var(--background) var(--glass-opacity), transparent))",
} as CSSProperties;
const NO_PROJECT_CHIP_CLASS_NAME =
  "surface-glass inline-flex h-6 items-center gap-1 rounded-md border border-dashed border-border px-2 font-semibold text-muted-foreground text-xs shadow-sm hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";

/**
 * The project the unsent chat will start in, as one chip above the composer. Clicking it lays the
 * other projects out beside it; choosing one moves the chat there, capture and prompt included.
 */
function SnapShotOverlayProjectChip(props: {
  readonly draftId: DraftId;
  readonly projectRef: ScopedProjectRef | null;
  readonly projectTitle: string | null;
}) {
  const { chosenGroup, rowEntries, selectProject, startScratch, canStartWithoutProject } =
    useDraftProjectChoice({
      draftId: props.draftId,
      activeProjectRef: props.projectRef,
      activeProjectTitle: props.projectTitle,
    });
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // The overlay leaves Escape to an open row, then hides on the next press.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  const chosenLabel = chosenGroup?.displayName ?? "No project";
  return (
    <div
      ref={containerRef}
      data-snap-shot-project-row={open || undefined}
      className="absolute inset-x-2 bottom-full mb-2 flex items-end gap-1.5"
    >
      {chosenGroup ? (
        <ProjectChip
          project={chosenGroup}
          label={chosenLabel}
          selected
          className={GLASS_CHIP_CLASS_NAME}
          style={GLASS_CHIP_STYLE}
          render={
            <button type="button" aria-expanded={open} onClick={() => setOpen((was) => !was)} />
          }
        />
      ) : (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((was) => !was)}
          className={NO_PROJECT_CHIP_CLASS_NAME}
        >
          <MessageSquareDashedIcon aria-hidden className="size-3" />
          No project
        </button>
      )}
      {open ? (
        <ProjectChipRow label={chosenLabel} className="min-w-0 justify-start">
          {rowEntries.map(({ group, targetProject }) => (
            <ProjectChip
              key={group.projectKey}
              project={group}
              label={group.displayName}
              className={cn(GLASS_CHIP_CLASS_NAME, "starting:opacity-0")}
              style={GLASS_CHIP_STYLE}
              render={
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    selectProject(targetProject, group.projectKey);
                  }}
                />
              }
            />
          ))}
          {canStartWithoutProject && chosenGroup ? (
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                void startScratch();
              }}
              className={cn(NO_PROJECT_CHIP_CLASS_NAME, "transition-opacity starting:opacity-0")}
            >
              <MessageSquareDashedIcon aria-hidden className="size-3" />
              No project
            </button>
          ) : null}
        </ProjectChipRow>
      ) : null}
    </div>
  );
}
