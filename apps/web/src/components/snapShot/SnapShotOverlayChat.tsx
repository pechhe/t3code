import type { ScopedProjectRef, ScopedThreadRef } from "@t3tools/contracts";
import {
  ChevronUpIcon,
  EyeOffIcon,
  ImageIcon,
  Maximize2Icon,
  MessageSquareDashedIcon,
  Minimize2Icon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react";
import {
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import type { ComposerThreadTarget, DraftId } from "~/composerDraftStore";
import { useClientSettings } from "~/hooks/useSettings";
import { formatShortcutLabel } from "~/keybindings";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";
import type { ChatMessage } from "~/types";
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

/**
 * Puts the composer away by fading it down, and brings it back up the same way; the pill takes
 * its place meanwhile.
 */
export const SNAP_SHOT_DOCK_CLASS_NAME =
  "transition-[translate,opacity] duration-300 ease-out data-snap-shot-docked:translate-y-6 data-snap-shot-docked:opacity-0 data-snap-shot-docked:duration-200 data-snap-shot-docked:ease-in motion-reduce:transition-none";

// The pill inverts the theme, so it stands out over the app behind and the overlay's glass.
const PILL_BUTTON_CLASS_NAME =
  "flex h-7 shrink-0 items-center rounded-full outline-none hover:bg-background/15 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

/** Names a control, and its shortcut if it has one, in a tooltip. */
function OverlayTooltip(props: {
  readonly label: string;
  readonly shortcut?: string | undefined;
  /** The control, without its content. */
  readonly trigger: ReactElement;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={props.trigger}>{props.children}</TooltipTrigger>
      <TooltipPopup side="top">
        {props.shortcut ? `${props.label} · ${props.shortcut}` : props.label}
      </TooltipPopup>
    </Tooltip>
  );
}

/** An icon button; on the pill, a plain round one in the pill's inverted colours. */
function OverlayIconButton(props: {
  readonly label: string;
  readonly shortcut?: string | undefined;
  readonly onClick: () => void;
  readonly onPill?: boolean | undefined;
  readonly children: ReactNode;
}) {
  return (
    <OverlayTooltip
      label={props.label}
      shortcut={props.shortcut}
      trigger={
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
          <Button size="icon-xs" variant="ghost" aria-label={props.label} onClick={props.onClick} />
        )
      }
    >
      {props.children}
    </OverlayTooltip>
  );
}

function useToggleShortcutLabel(): string {
  return formatShortcutLabel(useClientSettings((settings) => settings.snapShotOverlayShortcut));
}

function OverlayEndButton(props: {
  readonly controls: SnapShotOverlayControls;
  readonly onPill?: boolean | undefined;
}) {
  return (
    <OverlayIconButton
      label="End"
      shortcut="Esc"
      onClick={props.controls.end}
      onPill={props.onPill}
    >
      <XIcon />
    </OverlayIconButton>
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
 * Above the overlay's composer: the project chip while the chat is unsent, then a card with the
 * reply to the latest message, or the whole conversation. Both ride with the composer when it
 * docks.
 */
export function SnapShotOverlayAbove(props: {
  readonly dock: SnapShotOverlayDock;
  readonly draftId: DraftId | null;
  readonly projectRef: ScopedProjectRef | null;
  readonly projectTitle: string | null;
  readonly threadRef: ScopedThreadRef | null;
  readonly composerTarget: ComposerThreadTarget | null;
  readonly title: string;
  readonly cwd: string | undefined;
}) {
  const { dock } = props;
  const controls = useSnapShotOverlayControls();
  const toggleShortcut = useToggleShortcutLabel();
  if (controls === null) return null;
  if (dock.prompt === null && !dock.working) {
    return props.draftId === null ? null : (
      <SnapShotOverlayProjectChip
        draftId={props.draftId}
        projectRef={props.projectRef}
        projectTitle={props.projectTitle}
        aside={
          <>
            <SnapShotOverlayResumeChip draftId={props.draftId} controls={controls} />
            <OverlayTooltip
              label="Hide"
              shortcut="Esc"
              trigger={
                <button
                  type="button"
                  onClick={controls.hide}
                  className={cn(NO_PROJECT_CHIP_CLASS_NAME, "ms-auto border-solid")}
                />
              }
            >
              <EyeOffIcon aria-hidden className="size-3" />
              Hide
            </OverlayTooltip>
          </>
        }
      />
    );
  }
  if (dock.prompt === null) return null;
  return (
    <SnapShotOverlayCard {...props} prompt={dock.prompt} controls={controls}>
      <OverlayTooltip
        label="Hide"
        shortcut={toggleShortcut}
        trigger={<Button size="compact" variant="ghost" onClick={controls.hide} />}
      >
        Hide
      </OverlayTooltip>
    </SnapShotOverlayCard>
  );
}

/** How far an element sits below the top of the page, leaving out the overlay's slides. */
function offsetTopInPage(element: HTMLElement): number {
  let top = 0;
  for (let node: Element | null = element; node instanceof HTMLElement; node = node.offsetParent) {
    top += node.offsetTop;
  }
  return top;
}

/**
 * The reply to the latest message, or, expanded, the whole conversation, sized to its messages
 * up to the room above the composer.
 */
function SnapShotOverlayCard(props: {
  readonly dock: SnapShotOverlayDock;
  readonly prompt: ChatMessage;
  readonly controls: SnapShotOverlayControls;
  readonly threadRef: ScopedThreadRef | null;
  readonly composerTarget: ComposerThreadTarget | null;
  readonly title: string;
  readonly cwd: string | undefined;
  /** The hide button. */
  readonly children: ReactNode;
}) {
  const { dock, controls, threadRef, composerTarget } = props;
  const { expanded, setExpanded } = dock;
  const [card, setCard] = useState<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  // The room between the top of the window and the composer the card sits on.
  const [roomAbove, setRoomAbove] = useState<number | null>(null);

  useLayoutEffect(() => {
    const composer = card?.parentElement;
    if (!expanded || !composer) return;
    const measure = () => setRoomAbove(offsetTopInPage(composer));
    measure();
    const stopObserving = observeResize(composer, measure);
    window.addEventListener("resize", measure);
    return () => {
      stopObserving();
      window.removeEventListener("resize", measure);
    };
  }, [card, expanded]);

  // The conversation opens at its latest message, and follows new ones and a streaming reply
  // unless the user has scrolled back.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    const content = transcriptRef.current;
    if (!expanded || !body || !content) return;
    let following = true;
    const onScroll = () => {
      following = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
    };
    const follow = () => {
      if (following) body.scrollTop = body.scrollHeight;
    };
    follow();
    body.addEventListener("scroll", onScroll, { passive: true });
    const stopObserving = observeResize(content, follow);
    return () => {
      body.removeEventListener("scroll", onScroll);
      stopObserving();
    };
  }, [expanded]);

  // Behind the pill, the conversation is out of sight and Escape ends it as usual.
  const expandedOnScreen = expanded && !dock.docked;
  useEffect(() => {
    if (!expandedOnScreen) return;
    // Escape shrinks the conversation once any popup over it has closed; the overlay waits while
    // it is open.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector(SNAP_SHOT_OPEN_POPUP_SELECTOR)) return;
      setExpanded(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expandedOnScreen, setExpanded]);

  const markdown = (message: ChatMessage) => (
    <ChatMarkdown
      text={message.text}
      cwd={props.cwd}
      threadRef={threadRef ?? undefined}
      isStreaming={message.streaming}
    />
  );
  const working = dock.working ? (
    <p className="flex items-center gap-2 text-muted-foreground text-xs">
      <Spinner className="size-3.5" />
      Working
    </p>
  ) : null;

  return (
    // Solid rather than glass: the window is transparent, so nothing behind it can be blurred.
    <div
      ref={setCard}
      data-snap-shot-expanded={expandedOnScreen || undefined}
      className={cn(
        "absolute inset-x-0 bottom-full mb-2 flex flex-col overflow-hidden rounded-2xl border border-border/60 bg-background text-foreground shadow-lg",
        !expanded && "max-h-80",
      )}
      // A 1rem gap above, as below the composer.
      style={expanded && roomAbove !== null ? { maxHeight: roomAbove - 24 } : undefined}
    >
      <div className="flex shrink-0 items-center gap-1 py-1.5 ps-3.5 pe-1.5">
        <p
          className={cn(
            "min-w-0 flex-1 truncate text-xs",
            expanded ? "font-medium text-foreground" : "text-muted-foreground",
          )}
        >
          {expanded ? props.title : props.prompt.text}
        </p>
        {expanded ? (
          <OverlayIconButton label="Show latest reply only" onClick={() => setExpanded(false)}>
            <Minimize2Icon />
          </OverlayIconButton>
        ) : (
          <OverlayIconButton label="Show whole conversation" onClick={() => setExpanded(true)}>
            <Maximize2Icon />
          </OverlayIconButton>
        )}
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
        {props.children}
        <OverlayEndButton controls={controls} />
      </div>
      <div ref={bodyRef} className="min-h-0 overflow-y-auto px-3.5 pb-3 text-sm">
        {expanded ? (
          <div ref={transcriptRef} className="flex flex-col gap-3 pt-1">
            {dock.truncated ? (
              <p className="text-center text-muted-foreground text-xs">
                Earlier messages are in T3
              </p>
            ) : null}
            {dock.transcript.map((message) =>
              message.role === "user" ? (
                <SnapShotOverlayPrompt key={message.id} message={message} />
              ) : (
                <div key={message.id}>{markdown(message)}</div>
              ),
            )}
            {dock.reply === null ? working : null}
          </div>
        ) : dock.reply ? (
          markdown(dock.reply)
        ) : (
          working
        )}
      </div>
    </div>
  );
}

function SnapShotOverlayPrompt({ message }: { readonly message: ChatMessage }) {
  const images = message.attachments?.length ?? 0;
  return (
    <div className="ms-auto flex max-w-[85%] flex-col gap-1 rounded-xl bg-muted px-3 py-1.5">
      {message.text ? <p className="whitespace-pre-wrap break-words">{message.text}</p> : null}
      {images > 0 ? (
        <p className="flex items-center gap-1 text-muted-foreground text-xs">
          <ImageIcon aria-hidden className="size-3" />
          {images === 1 ? "1 image" : `${images} images`}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Stands in for the composer while it is put away, at the bottom of the screen: says the agent
 * is working, and brings the composer back when clicked.
 */
export function SnapShotOverlayDockPill(props: {
  readonly dock: SnapShotOverlayDock;
  readonly title: string;
}) {
  const { dock } = props;
  const controls = useSnapShotOverlayControls();
  const toggleShortcut = useToggleShortcutLabel();
  if (controls?.floor == null) return null;
  return createPortal(
    <div
      data-shown={dock.docked || undefined}
      inert={!dock.docked}
      className="mb-4 flex h-9 max-w-[calc(100%-3rem)] translate-y-4 items-center gap-0.5 rounded-full bg-foreground/90 px-1 text-background opacity-0 shadow-xl transition-[opacity,translate] duration-200 data-shown:pointer-events-auto data-shown:translate-y-0 data-shown:opacity-100 data-shown:duration-300 motion-reduce:transition-none"
    >
      <OverlayTooltip
        label="Show"
        shortcut={toggleShortcut}
        trigger={
          <button
            type="button"
            onClick={controls.show}
            className={cn(PILL_BUTTON_CLASS_NAME, "min-w-0 gap-2 ps-2.5 pe-2 font-medium text-xs")}
          />
        }
      >
        {dock.working ? (
          <>
            <Spinner className="size-3.5 shrink-0" />
            Working
            {dock.prompt ? (
              <span className="min-w-0 truncate font-normal text-background/60">
                · {dock.prompt.text}
              </span>
            ) : null}
          </>
        ) : (
          <>
            <ChevronUpIcon aria-hidden className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">{props.title}</span>
          </>
        )}
      </OverlayTooltip>
      <OverlayEndButton controls={controls} onPill />
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
