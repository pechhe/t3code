import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useThreadRouteTarget } from "../../hooks/useThreadRouteTarget";
import { readThreadShell } from "../../state/entities";
import type { ThreadRouteTarget } from "../../threadRoutes";

export function isSidebarUtilityPage(pathname: string) {
  return (
    pathname === "/settings" ||
    pathname.startsWith("/settings/") ||
    pathname.startsWith("/projects/") ||
    pathname === "/usage" ||
    pathname === "/scheduled" ||
    pathname === "/pull-requests"
  );
}

let mainAppHref: string | null = null;
let mainAppThreadTarget: ThreadRouteTarget | null = null;

export function MainAppLocationTracker() {
  const href = useLocation({
    select: (location) => (isSidebarUtilityPage(location.pathname) ? null : location.href),
  });
  const threadTarget = useThreadRouteTarget();
  useEffect(() => {
    if (href === null) return;
    mainAppHref = href;
    mainAppThreadTarget = threadTarget;
  }, [href, threadTarget]);
  return null;
}

export function useNavigateToMainApp() {
  const navigate = useNavigate();
  return () => navigate({ href: mainAppHref ?? "/" });
}

/** The project of the thread or draft open in the main app before a utility page. */
export function readMainAppProjectRef(): ScopedProjectRef | null {
  if (mainAppThreadTarget?.kind === "server") {
    const thread = readThreadShell(mainAppThreadTarget.threadRef);
    return thread ? scopeProjectRef(thread.environmentId, thread.projectId) : null;
  }
  if (mainAppThreadTarget?.kind === "draft") {
    const draft = useComposerDraftStore.getState().getDraftSession(mainAppThreadTarget.draftId);
    return draft ? scopeProjectRef(draft.environmentId, draft.projectId) : null;
  }
  return null;
}
