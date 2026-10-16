import { useParams } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { derivePhysicalProjectKey, selectProjectGroupingSettings } from "../logicalProject";
import { buildPhysicalToLogicalProjectKeyMap } from "../sidebarProjectGrouping";
import { useProjects, useThreadShell } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";
import { useClientSettings } from "./useSettings";
import { setActiveProjectTheme } from "./useTheme";

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
  const projects = useProjects();
  const settings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // The same grouping Settings → Projects keys its rows by, so a theme set
  // there is found here for every checkout in the group.
  const logicalKeyByPhysicalKey = useMemo(
    () => buildPhysicalToLogicalProjectKeyMap({ projects, settings, primaryEnvironmentId }),
    [primaryEnvironmentId, projects, settings],
  );
  const project = owner
    ? projects.find(
        (candidate) =>
          candidate.environmentId === owner.environmentId && candidate.id === owner.projectId,
      )
    : undefined;
  return project ? (logicalKeyByPhysicalKey.get(derivePhysicalProjectKey(project)) ?? null) : null;
}

/** The theme preference the project paints, or null when it follows the user's theme. */
export function useProjectTheme(projectKey: string | null): string | null {
  return useUiStateStore((store) =>
    projectKey === null ? null : (store.projectThemeByKey[projectKey] ?? null),
  );
}

/** Paints the open project's theme, and the user's own theme everywhere else. */
export function useProjectThemeSync(): void {
  const theme = useProjectTheme(useActiveProjectKey());
  useEffect(() => {
    setActiveProjectTheme(theme);
  }, [theme]);
}
