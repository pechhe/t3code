import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useThreadRouteTarget } from "../../hooks/useThreadRouteTarget";
import { readThreadShell } from "../../state/entities";
import type { ThreadRouteTarget } from "../../threadRoutes";

/** Settings and Usage open as modals over the last main-app view. */
export function isAppModalPage(pathname: string) {
  return pathname === "/settings" || pathname.startsWith("/settings/") || pathname === "/usage";
}

export function isSidebarUtilityPage(pathname: string) {
  return (
    pathname.startsWith("/projects/") || pathname === "/scheduled" || pathname === "/pull-requests"
  );
}

let mainAppHref: string | null = null;
let appModalReturnHref: string | null = null;
let mainAppThreadTarget: ThreadRouteTarget | null = null;

export function MainAppLocationTracker() {
  const href = useLocation({ select: (location) => location.href });
  const pathname = useLocation({ select: (location) => location.pathname });
  const threadTarget = useThreadRouteTarget();
  useEffect(() => {
    if (isAppModalPage(pathname)) return;
    appModalReturnHref = href;
    if (isSidebarUtilityPage(pathname)) return;
    mainAppHref = href;
    mainAppThreadTarget = threadTarget;
  }, [href, pathname, threadTarget]);
  return null;
}

export function useNavigateToMainApp() {
  const navigate = useNavigate();
  return () => navigate({ href: mainAppHref ?? "/" });
}

/** Leaves Settings or Usage for the page that opened it. */
export function useCloseAppModal() {
  const navigate = useNavigate();
  return () => navigate({ href: appModalReturnHref ?? mainAppHref ?? "/" });
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
