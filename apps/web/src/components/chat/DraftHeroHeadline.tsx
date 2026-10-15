import type { DraftId } from "~/composerDraftStore";
import { composerDraftHasUserContent, useComposerDraftStore } from "~/composerDraftStore";
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
    [environmentLabelById, openedAt, primaryEnvironmentId, projectGroupingSettings, projects, threads],
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
  const activeProjectDisplayName = activeProjectGroup?.displayName ?? activeProjectTitle;
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
  // With a prompt typed, project selection changes the target of the open
  // draft in place, so the prompt stays in the same composer session. An empty
  // draft instead opens the chosen project's own draft, like starting a new
  // thread there: moving it would replace that draft and strand whatever it
  // holds, such as the browser tabs of the no-project draft.
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
      void openProjectDraft(scopeProjectRef(project.environmentId, project.id));
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
  const heading = isScratchDraft
    ? "What should we work on?"
    : canChooseProject || hasResolvedProject
      ? "What should we build?"
      : "Add a project to start";

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col items-center">
      <h1 className="w-full text-center font-normal text-2xl text-foreground tracking-tight sm:text-3xl">
        {heading}
      </h1>
      <ProjectChipRow
        className="pointer-events-auto mt-3"
        label={activeProjectDisplayName ?? "Project"}
      >
        {menuEntries.map(({ group, targetProject }) => (
          <ProjectChip
            key={group.projectKey}
            project={group}
            label={group.displayName}
            selected={!isScratchDraft && group.projectKey === activeProjectKey}
            className="h-6 max-w-48 px-2 text-xs"
            render={
              <button
                type="button"
                aria-pressed={!isScratchDraft && group.projectKey === activeProjectKey}
                onClick={() => {
                  if (!isScratchDraft && group.projectKey === activeProjectKey) return;
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
        {canStartWithoutProject ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-pressed={isScratchDraft}
                  onClick={() => void startScratch()}
                  className={cn(
                    "inline-flex h-6 items-center gap-1 rounded-md border border-dashed border-border px-2 font-semibold text-muted-foreground text-xs transition-[background-color,border-color,color] hover:border-foreground/30 hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring motion-reduce:transition-none",
                    isScratchDraft && "border-solid border-foreground/60 bg-foreground/8 text-foreground",
                  )}
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
