import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import {
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { FolderInputIcon } from "lucide-react";
import { msg } from "gt-react";
import type { MessageResolver } from "../../i18n/messages";

import type { Project } from "../../types";
import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteSubmenuItem,
} from "../CommandPalette.logic";
import { projectFaviconIcon } from "../CommandPaletteProjectItems";

export function buildMoveToProjectItem(input: {
  readonly resolve: MessageResolver;
  readonly activeThread: EnvironmentThreadShell | null;
  readonly projects: ReadonlyArray<Project>;
  readonly scratchWorkspaceRootFor: (environmentId: EnvironmentId) => string | null;
  readonly moveThreadToProject: (
    source: EnvironmentThreadShell,
    projectId: ProjectId,
  ) => Promise<unknown>;
}): CommandPaletteSubmenuItem | null {
  const { resolve, activeThread, projects, scratchWorkspaceRootFor, moveThreadToProject } = input;
  const activeThreadProject = activeThread
    ? projects.find(
        (project) =>
          project.environmentId === activeThread.environmentId &&
          project.id === activeThread.projectId,
      )
    : undefined;
  if (
    !activeThread ||
    !activeThreadProject ||
    !isScratchProject(activeThreadProject, scratchWorkspaceRootFor(activeThread.environmentId))
  ) {
    return null;
  }
  const moveTargets = projects.filter(
    (project) =>
      project.environmentId === activeThread.environmentId && project.id !== activeThreadProject.id,
  );
  if (moveTargets.length === 0) return null;
  return {
    kind: "submenu",
    value: "action:move-thread-to-project",
    searchTerms: ["move", "project", "no project", "scratch"],
    title: resolve(msg("Move to project…")),
    icon: <FolderInputIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <FolderInputIcon className={ADDON_ICON_CLASS} />,
    groups: [
      {
        value: "projects",
        label: resolve(msg("Move to project")),
        items: moveTargets.map((project): CommandPaletteActionItem => ({
          kind: "action",
          value: `move-thread-to-project:${project.id}`,
          title: project.title,
          searchTerms: [project.title, "move", "project"],
          icon: projectFaviconIcon(project),
          disabled: threadRuntimeIsActive(activeThread.runtime),
          run: async () => {
            await moveThreadToProject(activeThread, project.id);
          },
        })),
      },
    ],
  };
}
