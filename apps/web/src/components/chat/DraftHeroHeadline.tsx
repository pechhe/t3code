import type { DraftId } from "~/composerDraftStore";
import {
  composerDraftHasUserContent,
  draftThreadHasOpenPreview,
  useComposerDraftStore,
} from "~/composerDraftStore";
import { resolveEnvironmentMachineKind, type ScopedProjectRef } from "@t3tools/contracts";
import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { MessageSquareDashedIcon, PlusIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { shortcutLabelForCommand } from "~/keybindings";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useScratchProject } from "~/hooks/useScratchProject";
import { useClientSettings } from "~/hooks/useSettings";
import { hasExplicitComposerModelSelection } from "~/lib/chatThreadActions";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "~/logicalProject";
import {
  buildSidebarProjectPickerEntries,
  buildSidebarProjectSnapshots,
  projectGroupsSpanEnvironments,
} from "~/sidebarProjectGrouping";
import { useProjects, useThreadShells } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { ProjectEnvironmentBadge } from "../ProjectEnvironmentBadge";
import { ProjectChip } from "../ProjectChip";
import { sortLogicalProjectsByRecentUse } from "../Sidebar.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

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
 * chosen chip flies into the question, the one it replaces flies back to its place in the
 * row, and everything between them slides. `capture(target)` records positions before a
 * change; the move plays when `changeKey` becomes `target`, and is dropped if anything else
 * lands first. Transforms only, one shot.
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
  const projects = useProjects();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);
  const getDraftSession = useComposerDraftStore((store) => store.getDraftSession);
  const applyStickyState = useComposerDraftStore((store) => store.applyStickyState);
  const setModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const openAddProject = useCallback(() => openCommandPalette({ open: "add-project" }), []);
  const { scratchEnvironmentId, scratchWorkspaceRootFor, openScratchProject } = useScratchProject();
  const openProjectDraft = useNewThreadHandler();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);

  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  // The 30-day window is measured from when the screen opened, so the order holds still.
  const [openedAt] = useState(() => Date.now());
  const projectGroups = useMemo(
    () =>
      sortLogicalProjectsByRecentUse(
        buildSidebarProjectSnapshots({
          projects,
          settings: projectGroupingSettings,
          primaryEnvironmentId,
          resolveEnvironmentLabel: (environmentId) =>
            environmentLabelById.get(environmentId) ?? null,
        }),
        threads,
        openedAt,
      ),
    [
      environmentLabelById,
      openedAt,
      primaryEnvironmentId,
      projectGroupingSettings,
      projects,
      threads,
    ],
  );
  // Same-named projects on two machines are only told apart by where they
  // live, so rows on another machine carry its icon once the catalog spans
  // more than one environment; a single-machine catalog stays as it was.
  const showProjectEnvironments = useMemo(
    () => projectGroupsSpanEnvironments(projectGroups),
    [projectGroups],
  );
  const environmentMachineById = useMemo(
    () =>
      new Map(
        environments.map(
          (environment) =>
            [
              environment.environmentId,
              resolveEnvironmentMachineKind(environment.serverConfig),
            ] as const,
        ),
      ),
    [environments],
  );
  const projectPickerEntries = useMemo(
    () =>
      buildSidebarProjectPickerEntries({
        groups: projectGroups,
        preferredProjectRef: activeProjectRef,
      }),
    [activeProjectRef, projectGroups],
  );

  const activeProjectGroup =
    activeProjectRef === null
      ? null
      : (projectGroups.find((group) =>
          group.memberProjectRefs.some(
            (projectRef) => scopedProjectKey(projectRef) === scopedProjectKey(activeProjectRef),
          ),
        ) ?? null);
  const activeProjectKey = activeProjectGroup?.projectKey ?? "";
  const hasResolvedProject = activeProjectTitle !== null;
  const canChooseProject = projectPickerEntries.length > 0;
  // The project that hosts threads without a project is not a chip of its own:
  // the "No project" chip is the way into it. Chips keep the usage order rather
  // than the picker's chosen-first order, so choosing one never moves the row.
  const menuEntries = useMemo(() => {
    const position = new Map(projectGroups.map((group, index) => [group.projectKey, index]));
    return projectPickerEntries
      .filter(
        ({ targetProject }) =>
          !isScratchProject(targetProject, scratchWorkspaceRootFor(targetProject.environmentId)),
      )
      .toSorted(
        (left, right) =>
          (position.get(left.group.projectKey) ?? 0) - (position.get(right.group.projectKey) ?? 0),
      );
  }, [projectGroups, projectPickerEntries, scratchWorkspaceRootFor]);
  const activeProject =
    activeProjectRef === null
      ? null
      : (projects.find(
          (project) =>
            project.environmentId === activeProjectRef.environmentId &&
            project.id === activeProjectRef.projectId,
        ) ?? null);
  const scratchTargetEnvironmentId = scratchEnvironmentId(
    activeProjectRef?.environmentId ?? primaryEnvironmentId,
  );
  const scratchWorkspaceRoot = scratchWorkspaceRootFor(scratchTargetEnvironmentId);
  const isScratchDraft =
    activeProject !== null && isScratchProject(activeProject, scratchWorkspaceRoot);

  // A chip can change the draft's target while the no-project home is
  // still being opened; a stale continuation must not retarget it again.
  const latestTargetRef = useRef({ draftId, activeProjectKey, scratchTargetEnvironmentId });
  useEffect(() => {
    latestTargetRef.current = { draftId, activeProjectKey, scratchTargetEnvironmentId };
  }, [activeProjectKey, scratchTargetEnvironmentId, draftId]);
  // Project selection changes the target of the open draft in place, so the composer
  // stays mounted. An empty draft takes the project's new-thread defaults, like starting
  // a new thread there; with a prompt typed, the workspace choices made so far stand.
  const selectProject = (project: (typeof projects)[number], logicalProjectKey: string) => {
    if (!draftId) {
      return;
    }
    latestTargetRef.current = {
      draftId,
      activeProjectKey: logicalProjectKey,
      scratchTargetEnvironmentId: project.environmentId,
    };
    const currentDraft = getComposerDraft(draftId);
    if (!composerDraftHasUserContent(currentDraft)) {
      // A draft holding open browser tabs keeps them where they are; the project's own
      // draft opens instead.
      const keepsOpenPages = draftThreadHasOpenPreview(getDraftSession(draftId) ?? undefined);
      void openProjectDraft(
        scopeProjectRef(project.environmentId, project.id),
        keepsOpenPages ? undefined : { retargetDraftId: draftId },
      );
      return;
    }
    setLogicalProjectDraftThreadId(
      logicalProjectKey,
      scopeProjectRef(project.environmentId, project.id),
      draftId,
    );
    if (!hasExplicitComposerModelSelection(currentDraft)) {
      applyStickyState(draftId);
      const environmentSettings = environments.find(
        (environment) => environment.environmentId === project.environmentId,
      )?.serverConfig?.settings;
      const defaultModelSelection = environmentSettings
        ? resolveProjectSettings(environmentSettings, project.id, project).settings
            .defaultModelSelection
        : project.defaultModelSelection;
      if (defaultModelSelection) {
        setModelSelection(draftId, defaultModelSelection, {
          replaceOptions: true,
        });
      }
    }
  };
  const startScratch = async (): Promise<boolean> => {
    if (scratchTargetEnvironmentId === null || isScratchDraft) {
      return false;
    }
    const requested = { draftId, activeProjectKey, scratchTargetEnvironmentId };
    const project = await openScratchProject(scratchTargetEnvironmentId);
    const latest = latestTargetRef.current;
    if (
      !project ||
      latest.draftId !== requested.draftId ||
      latest.activeProjectKey !== requested.activeProjectKey ||
      latest.scratchTargetEnvironmentId !== requested.scratchTargetEnvironmentId
    ) {
      return false;
    }
    selectProject(project, deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings));
    return true;
  };

  const noProjectShortcut = shortcutLabelForCommand(keybindings, "chat.newWithoutProject");
  const canStartWithoutProject = scratchWorkspaceRoot !== null;
  // The chosen project sits in the question; the row offers the others.
  const chosenGroup = isScratchDraft ? null : activeProjectGroup;
  const rowEntries = menuEntries.filter(
    ({ group }) => group.projectKey !== chosenGroup?.projectKey,
  );
  const { refFor, capture } = useFlip(chosenGroup?.projectKey ?? NO_PROJECT_KEY);

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
          <span ref={refFor(NO_PROJECT_KEY)} className="inline-block text-muted-foreground/50">
            …
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
 * The project choices under the new-thread question. Arrow keys move between chips, and
 * typing a project's name while a chip has focus jumps to it.
 */
function ProjectChipRow(props: {
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
