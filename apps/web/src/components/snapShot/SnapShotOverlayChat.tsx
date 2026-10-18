import type { ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";
import {
  EyeOffIcon,
  Maximize2Icon,
  MessageSquareDashedIcon,
  Minimize2Icon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { ComposerThreadTarget, DraftId } from "~/composerDraftStore";
import { useClientSettings } from "~/hooks/useSettings";
import { formatShortcutLabel } from "~/keybindings";
import { cn } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";
import ChatMarkdown from "../ChatMarkdown";
import { ProjectChip } from "../ProjectChip";
import { ProjectChipRow } from "../chat/DraftHeroHeadline";
import { useDraftProjectChoice } from "../chat/useDraftProjectChoice";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  SNAP_SHOT_OPEN_POPUP_SELECTOR,
  type SnapShotOverlayControls,
  useSnapShotOverlayControls,
} from "./SnapShotOverlay";
import type { SnapShotOverlayDock } from "./snapShotOverlayDock";
import { useSnapShotOverlaySession } from "./snapShotOverlaySession";

/** Sends the composer below the screen edge, with the slide the overlay itself uses. */
export const SNAP_SHOT_DOCK_CLASS_NAME =
  "transition-transform duration-200 ease-in-reversed data-snap-shot-docked:translate-y-[100svh] data-snap-shot-docked:ease-in motion-reduce:transition-none";

/**
 * The whole conversation, shown in the overlay as a frosted panel behind the composer. Its bottom
 * edge meets the composer's, above the spacer under it.
 */
export const SNAP_SHOT_EXPANDED_CLASS_NAME =
  "surface-glass mx-6 mt-4 mb-4 overflow-hidden rounded-2xl border border-border/60 shadow-lg sm:mb-5";

// The pill inverts the theme, so it stands out over the app behind and the overlay's glass.
const PILL_BUTTON_CLASS_NAME =
  "flex h-7 shrink-0 items-center rounded-full outline-none hover:bg-background/15 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

/**
 * An icon button with its name, and shortcut if it has one, in a tooltip. On the pill it is a
 * plain round button in the pill's inverted colours.
 */
function OverlayIconButton(props: {
  readonly label: string;
  readonly shortcut?: string | undefined;
  readonly onClick: () => void;
  readonly onPill?: boolean | undefined;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          props.onPill ? (
            <button
              type="button"
              aria-label={props.label}
              onClick={props.onClick}
              className={cn(
                PILL_BUTTON_CLASS_NAME,
                "w-7 justify-center text-background/70 hover:text-background [&_svg]:size-3.5",
              )}
            />
          ) : (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={props.label}
              onClick={props.onClick}
            />
          )
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="top">
        {props.shortcut ? `${props.label} · ${props.shortcut}` : props.label}
      </TooltipPopup>
    </Tooltip>
  );
}

function useHideShortcutLabel(): string {
  return formatShortcutLabel(useClientSettings((settings) => settings.snapShotOverlayShortcut));
}

/** Hides the overlay, keeping the conversation, or ends it. */
function OverlayHideAndEnd({
  controls,
  onPill,
}: {
  readonly controls: SnapShotOverlayControls;
  readonly onPill?: boolean | undefined;
}) {
  const hideShortcut = useHideShortcutLabel();
  return (
    <>
      <OverlayIconButton
        label="Hide"
        shortcut={hideShortcut}
        onClick={controls.hide}
        onPill={onPill}
      >
        <EyeOffIcon />
      </OverlayIconButton>
      <OverlayIconButton label="End" shortcut="Esc" onClick={controls.end} onPill={onPill}>
        <XIcon />
      </OverlayIconButton>
    </>
  );
}

function OpenInT3Button({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  return (
    <Button
      size="compact"
      variant="ghost"
      onClick={() => void window.desktopBridge?.openThreadInMainWindow?.(threadRef)}
    >
      Open in T3
    </Button>
  );
}

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
  readonly composerTarget: ComposerThreadTarget | null;
  readonly cwd: string | undefined;
}) {
  const { dock, threadRef, composerTarget } = props;
  const controls = useSnapShotOverlayControls();
  if (controls === null) return null;
  if (dock.prompt === null && !dock.working) {
    return props.draftId === null ? null : (
      <SnapShotOverlayProjectChip
        draftId={props.draftId}
        projectRef={props.projectRef}
        projectTitle={props.projectTitle}
        aside={<SnapShotOverlayResumeChip draftId={props.draftId} controls={controls} />}
      />
    );
  }
  if (dock.prompt === null || dock.reply === null || dock.expanded) return null;
  return (
    <div className="surface-glass absolute inset-x-0 bottom-full mb-2 flex max-h-80 flex-col overflow-hidden rounded-2xl border border-border/60 text-foreground shadow-lg">
      <div className="flex shrink-0 items-center gap-1 py-1.5 ps-3.5 pe-1.5">
        <p className="min-w-0 flex-1 truncate text-muted-foreground text-xs">{dock.prompt.text}</p>
        <OverlayIconButton label="Show whole conversation" onClick={() => dock.setExpanded(true)}>
          <Maximize2Icon />
        </OverlayIconButton>
        {threadRef ? <OpenInT3Button threadRef={threadRef} /> : null}
        {composerTarget ? (
          <Button
            size="compact"
            variant="ghost"
            onClick={() => controls.startNewChat(composerTarget)}
          >
            New chat
          </Button>
        ) : null}
        <OverlayHideAndEnd controls={controls} />
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

/** Heads the whole conversation while the overlay shows it, and shrinks it back to the reply. */
export function SnapShotOverlayExpandedHeader(props: {
  readonly dock: SnapShotOverlayDock;
  readonly title: string;
  readonly threadRef: ScopedThreadRef | null;
}) {
  const { dock } = props;
  const { setExpanded } = dock;
  const controls = useSnapShotOverlayControls();
  useEffect(() => {
    // Escape shrinks the conversation once any popup over it has closed; the overlay waits while
    // it is open.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector(SNAP_SHOT_OPEN_POPUP_SELECTOR)) return;
      setExpanded(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setExpanded]);
  if (controls === null) return null;
  return (
    <div
      data-snap-shot-expanded
      className="flex shrink-0 items-center gap-1 border-border/60 border-b py-1.5 ps-3.5 pe-1.5 text-foreground"
    >
      <p className="min-w-0 flex-1 truncate font-medium text-sm">{props.title}</p>
      <OverlayIconButton label="Show latest reply only" onClick={() => dock.setExpanded(false)}>
        <Minimize2Icon />
      </OverlayIconButton>
      {props.threadRef ? <OpenInT3Button threadRef={props.threadRef} /> : null}
      <OverlayHideAndEnd controls={controls} />
    </div>
  );
}

/**
 * Stands in for the docked composer at the bottom of the screen: says the agent is working, and
 * brings the composer back when clicked.
 */
export function SnapShotOverlayDockPill({ dock }: { readonly dock: SnapShotOverlayDock }) {
  const controls = useSnapShotOverlayControls();
  if (controls?.floor == null) return null;
  return createPortal(
    <div
      data-shown={dock.docked || undefined}
      inert={!dock.docked}
      className="mb-4 flex h-9 max-w-[calc(100%-3rem)] translate-y-4 items-center gap-0.5 rounded-full bg-foreground/85 px-1 text-background opacity-0 shadow-xl backdrop-blur-(--glass-blur) backdrop-saturate-(--glass-saturation) transition-[opacity,translate] duration-200 data-shown:pointer-events-auto data-shown:translate-y-0 data-shown:opacity-100 motion-reduce:transition-none"
    >
      <button
        type="button"
        onClick={dock.raise}
        className={cn(PILL_BUTTON_CLASS_NAME, "min-w-0 gap-2 ps-2.5 pe-2 font-medium text-xs")}
      >
        <Spinner className="size-3.5 shrink-0" />
        Working
        {dock.prompt ? (
          <span className="min-w-0 truncate font-normal text-background/60">
            · {dock.prompt.text}
          </span>
        ) : null}
      </button>
      <OverlayHideAndEnd controls={controls} onPill />
    </div>,
    controls.floor,
  );
}

/** Offers the conversation the overlay last ended, for a while after it ended. */
function SnapShotOverlayResumeChip({
  draftId,
  controls,
}: {
  readonly draftId: DraftId;
  readonly controls: SnapShotOverlayControls;
}) {
  const ended = useSnapShotOverlaySession((state) => state.ended);
  const thread = useThreadShell(ended?.threadRef ?? null);
  if (ended === null) return null;
  return (
    <button
      type="button"
      onClick={() => controls.resume(draftId)}
      className={cn(NO_PROJECT_CHIP_CLASS_NAME, "max-w-64 border-solid starting:opacity-0")}
    >
      <RotateCcwIcon aria-hidden className="size-3 shrink-0" />
      <span className="truncate">Resume · {thread?.title ?? "last chat"}</span>
    </button>
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
  /** Shown beside the chip while the row of projects is closed. */
  readonly aside?: ReactNode;
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
      {open ? null : props.aside}
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
