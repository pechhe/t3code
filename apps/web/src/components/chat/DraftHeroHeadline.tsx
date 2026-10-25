import type { DraftId } from "~/composerDraftStore";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { MessageSquareDashedIcon, PlusIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
} from "react";

import { isMacPlatform } from "@t3tools/shared/keybindings";
import { isCommandPaletteOpen, openCommandPalette } from "~/commandPaletteBus";
import { resolveShortcutCommand, shortcutLabelForCommand } from "~/keybindings";
import { cn } from "~/lib/utils";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { ProjectEnvironmentBadge } from "../ProjectEnvironmentBadge";
import { ProjectChip } from "../ProjectChip";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { isReservedForEditing, nextProjectForLetter } from "./projectLetterShortcut";
import { useDraftProjectChoice } from "./useDraftProjectChoice";

// Keys for the pieces of the question that move when the project changes. Each project
// chip is keyed by its project key, in the row or in the sentence alike.
const NO_PROJECT_KEY = "flip:no-project";
const SENTENCE_LEAD_KEY = "flip:sentence-lead";
const SENTENCE_TAIL_KEY = "flip:sentence-tail";
const ADD_PROJECT_KEY = "flip:add-project";
// Long enough to cover reading the project's t3.json defaults before the change lands.
const FLIP_MAX_AGE_MS = 5_000;

/**
 * Glides keyed elements from where they were to where they land after a re-render: the
 * chosen chip flies into the question, the one it replaces flies back, and everything
 * between slides. `capture(target)` records positions before a change; the move plays when
 * `changeKey` becomes `target`, and is dropped if anything else lands first.
 */
function useFlip(changeKey: string) {
  const nodes = useRef(new Map<string, HTMLElement>());
  const captured = useRef<{ rects: Map<string, DOMRect>; target: string; at: number } | null>(null);
  const landedKey = useRef(changeKey);
  const refFor = useCallback(
    (key: string) => (node: HTMLElement | null) => {
      if (!node) return;
      nodes.current.set(key, node);
      return () => {
        if (nodes.current.get(key) === node) nodes.current.delete(key);
      };
    },
    [],
  );
  const capture = useCallback((target: string) => {
    const rects = new Map<string, DOMRect>();
    for (const [key, node] of nodes.current) rects.set(key, node.getBoundingClientRect());
    captured.current = { rects, target, at: performance.now() };
  }, []);
  useLayoutEffect(() => {
    if (landedKey.current === changeKey) return;
    landedKey.current = changeKey;
    const snapshot = captured.current;
    captured.current = null;
    if (
      !snapshot ||
      snapshot.target !== changeKey ||
      performance.now() - snapshot.at > FLIP_MAX_AGE_MS
    ) {
      return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    for (const [key, node] of nodes.current) {
      const from = snapshot.rects.get(key);
      const to = node.getBoundingClientRect();
      if (!from || to.height === 0) continue;
      const dx = from.left - to.left;
      const dy = from.top - to.top;
      const scale = from.height / to.height;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(scale - 1) < 0.01) continue;
      node.animate(
        [
          { transformOrigin: "top left", transform: `translate(${dx}px, ${dy}px) scale(${scale})` },
          { transformOrigin: "top left", transform: "none" },
        ],
        { duration: 320, easing: "cubic-bezier(0.2, 0, 0, 1)" },
      );
    }
  }, [changeKey]);
  return { refFor, capture };
}

interface DraftHeroHeadlineProps {
  readonly draftId: DraftId | null;
  readonly activeProjectRef: ScopedProjectRef | null;
  readonly activeProjectTitle: string | null;
}

export function DraftHeroHeadline({
  draftId,
  activeProjectRef,
  activeProjectTitle,
}: DraftHeroHeadlineProps) {
  const {
    chosenGroup,
    menuEntries,
    rowEntries,
    selectProject,
    startScratch,
    canChooseProject,
    hasResolvedProject,
    canStartWithoutProject,
    showProjectEnvironments,
    primaryEnvironmentId,
    environmentMachineById,
  } = useDraftProjectChoice({ draftId, activeProjectRef, activeProjectTitle });
  const openAddProject = useCallback(() => openCommandPalette({ open: "add-project" }), []);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const noProjectShortcut = shortcutLabelForCommand(keybindings, "chat.newWithoutProject");
  const { refFor, capture } = useFlip(chosenGroup?.projectKey ?? NO_PROJECT_KEY);

  // Mod + a project's first letter chooses it; pressing again rotates through the projects
  // that share the letter. Configured shortcuts win, and the composer keeps its editing keys.
  const onProjectLetter = useEffectEvent((event: globalThis.KeyboardEvent) => {
    const useMeta = isMacPlatform(navigator.platform);
    if (event.defaultPrevented || event.shiftKey || event.altKey || event.isComposing) return;
    if (useMeta ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return;
    const letter = event.key.toLowerCase();
    if (!/^[a-z]$/.test(letter) || isReservedForEditing(letter) || isCommandPaletteOpen()) return;
    if (resolveShortcutCommand(event, keybindings) !== null) return;
    const next = nextProjectForLetter(
      menuEntries.map((entry) => ({
        key: entry.group.projectKey,
        name: entry.group.displayName,
        value: entry,
      })),
      letter,
      chosenGroup?.projectKey ?? null,
    );
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    capture(next.group.projectKey);
    selectProject(next.targetProject, next.group.projectKey);
  });
  useEffect(() => {
    window.addEventListener("keydown", onProjectLetter);
    return () => window.removeEventListener("keydown", onProjectLetter);
  }, []);

  if (!canChooseProject && !hasResolvedProject && !canStartWithoutProject) {
    return (
      <div className="mx-auto flex w-full max-w-5xl flex-col items-center">
        <h1 className="w-full text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl">
          Add a project to start
        </h1>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col items-center">
      <h1
        aria-label={
          chosenGroup
            ? `What should we build in ${chosenGroup.displayName}?`
            : "What should we build without a project?"
        }
        className="w-full text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl"
      >
        <span ref={refFor(SENTENCE_LEAD_KEY)} className="inline-block">
          What should we build in
        </span>{" "}
        {chosenGroup ? (
          <span
            key={chosenGroup.projectKey}
            ref={refFor(chosenGroup.projectKey)}
            className="inline-flex max-w-80 align-middle"
          >
            <ProjectChip
              project={chosenGroup}
              label={chosenGroup.displayName}
              selected
              className="h-8 gap-1.5 px-2.5 text-lg sm:h-9 sm:text-xl [&>:first-child]:size-4.5"
            />
          </span>
        ) : (
          // The same dashed chip as in the row: a stand-in the user swaps for a project.
          <span ref={refFor(NO_PROJECT_KEY)} className="inline-flex align-middle">
            <span className="inline-flex h-8 items-center gap-1.5 rounded-md border border-dashed border-border px-2.5 font-semibold text-lg text-muted-foreground sm:h-9 sm:text-xl">
              <MessageSquareDashedIcon aria-hidden className="size-4.5" />
              No project
            </span>
          </span>
        )}
        <span ref={refFor(SENTENCE_TAIL_KEY)} className="inline-block">
          ?
        </span>
      </h1>
      <ProjectChipRow
        className="pointer-events-auto mt-3"
        label={chosenGroup?.displayName ?? "No project"}
      >
        {rowEntries.map(({ group, targetProject }) => (
          <ProjectChip
            key={group.projectKey}
            ref={refFor(group.projectKey)}
            project={group}
            label={group.displayName}
            className="h-6 max-w-48 px-2 text-xs"
            render={
              <button
                type="button"
                onClick={() => {
                  capture(group.projectKey);
                  selectProject(targetProject, group.projectKey);
                }}
              />
            }
          >
            {showProjectEnvironments ? (
              <ProjectEnvironmentBadge
                group={group}
                primaryEnvironmentId={primaryEnvironmentId}
                machineByEnvironmentId={environmentMachineById}
              />
            ) : null}
          </ProjectChip>
        ))}
        {canStartWithoutProject && chosenGroup ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  ref={refFor(NO_PROJECT_KEY)}
                  type="button"
                  onClick={() => {
                    capture(NO_PROJECT_KEY);
                    void startScratch();
                  }}
                  className="inline-flex h-6 items-center gap-1 rounded-md border border-dashed border-border px-2 font-semibold text-muted-foreground text-xs transition-[border-color,color] hover:border-foreground/30 hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none"
                />
              }
            >
              <MessageSquareDashedIcon aria-hidden className="size-3" />
              No project
            </TooltipTrigger>
            {noProjectShortcut ? (
              <TooltipPopup side="bottom">{noProjectShortcut}</TooltipPopup>
            ) : null}
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                ref={refFor(ADD_PROJECT_KEY)}
                type="button"
                aria-label="Add project"
                onClick={openAddProject}
                className="inline-flex size-6 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
              />
            }
          >
            <PlusIcon aria-hidden className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Add project</TooltipPopup>
        </Tooltip>
      </ProjectChipRow>
    </div>
  );
}

/**
 * A row of project choices, under the new-thread question or beside the SnapShot overlay's
 * project chip. Arrow keys move between chips, and
 * typing a project's name while a chip has focus jumps to it.
 */
export function ProjectChipRow(props: {
  readonly label: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const typed = useRef({ text: "", at: 0 });
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const chips = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
    const index = chips.indexOf(document.activeElement as HTMLButtonElement);
    if (index === -1) return;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const step = event.key === "ArrowRight" ? 1 : -1;
      chips[(index + step + chips.length) % chips.length]?.focus();
      return;
    }
    if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return;
    const now = event.timeStamp;
    typed.current = {
      text: (now - typed.current.at < 700 ? typed.current.text : "") + event.key.toLowerCase(),
      at: now,
    };
    const match = chips.find((chip) =>
      chip.textContent?.trim().toLowerCase().startsWith(typed.current.text),
    );
    if (match) {
      event.preventDefault();
      match.focus();
    }
  };
  return (
    <div
      role="group"
      aria-label={`Project: ${props.label}`}
      onKeyDown={onKeyDown}
      className={cn("flex max-w-2xl flex-wrap justify-center gap-1.5", props.className)}
    >
      {props.children}
    </div>
  );
}
