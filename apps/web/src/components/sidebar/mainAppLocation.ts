import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ScopedProjectRef } from "@t3tools/contracts";
import { useNavigate, type AnyRouter } from "@tanstack/react-router";

import { GUEST_PAGE_PATH } from "../../guestPage";
import { withoutAssistantCitationHash } from "../../lib/assistantCitationNavigation";

import { useComposerDraftStore } from "../../composerDraftStore";
import { readThreadShell } from "../../state/entities";
import { resolveThreadRouteTarget, type ThreadRouteTarget } from "../../threadRoutes";

/** Settings and Usage open as modals over the last main-app view. */
export function isAppModalPage(pathname: string) {
  return pathname === "/settings" || pathname.startsWith("/settings/") || pathname === "/usage";
}

export function isSidebarUtilityPage(pathname: string) {
  return (
    pathname.startsWith("/projects/") ||
    pathname === "/scheduled" ||
    pathname === "/champions" ||
    pathname === "/pull-requests"
  );
}

// Pages the root route always renders without the app shell, so they are never
// a page to return to. Other paths seen before auth or on a prompt-link landing
// are still recorded; they are real app URLs, so returning to one is harmless.
const SHELL_LESS_PATHS = new Set(["/pair", "/connect", "/connect-agent", GUEST_PAGE_PATH]);

let mainAppHref: string | null = null;
let appModalReturnHref: string | null = null;
let mainAppThreadTarget: ThreadRouteTarget | null = null;

/** Remembers where Settings, Usage, and the utility pages lead back to. */
export function startMainAppLocationTracking(router: AnyRouter): () => void {
  const record = () => {
    const { pathname } = router.state.location;
    if (isAppModalPage(pathname) || SHELL_LESS_PATHS.has(pathname)) return;
    const href = withoutAssistantCitationHash(router.state.location.href);
    appModalReturnHref = href;
    if (!isSidebarUtilityPage(pathname)) {
      mainAppHref = href;
      mainAppThreadTarget = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
    }
  };
  record();
  return router.subscribe("onResolved", record);
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
