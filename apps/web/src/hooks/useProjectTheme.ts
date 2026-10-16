import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { useEffect } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import {
  derivePhysicalProjectKey,
  selectProjectGroupingSettings,
  type ProjectGroupingSettings,
} from "../logicalProject";
import { buildPhysicalToLogicalProjectKeyMap } from "../sidebarProjectGrouping";
import { useProjects, useThreadShell } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { themeChoiceAccent, type ThemeAppearance, type ThemeChoice } from "../themePalette";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";
import { useClientSettings } from "./useSettings";
import { readUserThemeChoice, setActiveProjectTheme, useResolvedAppearance } from "./useTheme";

let cachedKeyMap: {
  projects: ReadonlyArray<EnvironmentProject>;
  settings: ProjectGroupingSettings;
  primaryEnvironmentId: EnvironmentId | null;
  map: Map<string, string>;
} | null = null;

/**
 * Physical to logical project keys, built once per change to the inputs and
 * shared by every caller: each project chip asks for its own project's key.
 */
function logicalProjectKeyMap(
  projects: ReadonlyArray<EnvironmentProject>,
  settings: ProjectGroupingSettings,
  primaryEnvironmentId: EnvironmentId | null,
): Map<string, string> {
  if (
    cachedKeyMap?.projects !== projects ||
    cachedKeyMap.primaryEnvironmentId !== primaryEnvironmentId ||
    cachedKeyMap.settings.sidebarProjectGroupingMode !== settings.sidebarProjectGroupingMode ||
    cachedKeyMap.settings.sidebarProjectGroupingOverrides !==
      settings.sidebarProjectGroupingOverrides
  ) {
    cachedKeyMap = {
      projects,
      settings,
      primaryEnvironmentId,
      map: buildPhysicalToLogicalProjectKeyMap({ projects, settings, primaryEnvironmentId }),
    };
  }
  return cachedKeyMap.map;
}

/**
 * The logical key a project's theme is stored under: the same grouping
 * Settings → Projects keys its rows by, so a theme set there is found for
 * every checkout in the group.
 */
function useLogicalProjectKey(
  project: Pick<EnvironmentProject, "environmentId" | "workspaceRoot"> | undefined,
): string | null {
  const projects = useProjects();
  const settings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  if (!project) return null;
  return (
    logicalProjectKeyMap(projects, settings, primaryEnvironmentId).get(
      derivePhysicalProjectKey(project),
    ) ?? null
  );
}

/**
 * Logical key of the project behind the open thread or draft, or null on
 * routes without one. A draft follows its project picker, so changing the
 * project on the new-thread page changes this too.
 */
export function useActiveProjectKey(): string | null {
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const thread = useThreadShell(routeTarget?.kind === "server" ? routeTarget.threadRef : null);
  const draft = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const owner = thread ?? draft;
  const project = useProjects().find(
    (candidate) =>
      owner !== null &&
      candidate.environmentId === owner.environmentId &&
      candidate.id === owner.projectId,
  );
  return useLogicalProjectKey(project);
}

/** The theme the project paints, or null when it follows the user's theme. */
export function useProjectTheme(projectKey: string | null): ThemeChoice | null {
  return useUiStateStore((store) =>
    projectKey === null ? null : (store.projectThemeByKey[projectKey] ?? null),
  );
}

/** Gives the project a whole theme, dropping its light and dark picks, as the app gallery does. */
export function setProjectBaseTheme(projectKey: string, theme: string): void {
  useUiStateStore.getState().setProjectTheme(projectKey, { theme });
}

/**
 * Picks the project's theme for one appearance, or clears that pick with null.
 * A project without a theme of its own starts from the user's, so the other
 * appearance keeps looking as it did.
 */
export function setProjectThemeHalf(
  projectKey: string,
  appearance: ThemeAppearance,
  themeId: string | null,
): void {
  useUiStateStore
    .getState()
    .setProjectThemeHalf(projectKey, appearance, themeId, readUserThemeChoice());
}

/** Paints the open project's theme, and the user's own theme everywhere else. */
export function useProjectThemeSync(): void {
  const theme = useProjectTheme(useActiveProjectKey());
  useEffect(() => {
    setActiveProjectTheme(theme);
  }, [theme]);
}

/**
 * The accent of the theme a project paints in the current appearance, so its
 * chip wears its theme's colour; null for a project without a palette theme.
 */
export function useProjectThemeAccent(
  project: Pick<EnvironmentProject, "environmentId" | "workspaceRoot">,
): string | null {
  const choice = useProjectTheme(useLogicalProjectKey(project));
  const appearance = useResolvedAppearance();
  return choice === null ? null : themeChoiceAccent(choice, appearance);
}
