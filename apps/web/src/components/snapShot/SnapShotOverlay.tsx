import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Outlet } from "@tanstack/react-router";
import { ExternalLinkIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef } from "react";

import type { DraftId } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useScratchProject } from "../../hooks/useScratchProject";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { SnapShotCoordinator } from "../desktop/SnapShotCoordinator";
import { Button } from "../ui/button";

/** Starts a fresh chat without a project in the overlay window, replacing what it shows. */
function useStartSnapShotOverlayDraft(): () => Promise<DraftId | null> {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { openScratchProject } = useScratchProject();
  const handleNewThread = useNewThreadHandler();
  return useCallback(async () => {
    if (primaryEnvironmentId === null) return null;
    const project = await openScratchProject(primaryEnvironmentId);
    if (!project) return null;
    const created = await handleNewThread(scopeProjectRef(project.environmentId, project.id), {
      replace: true,
    });
    return created?.draftId ?? null;
  }, [handleNewThread, openScratchProject, primaryEnvironmentId]);
}

/** The overlay window's app: its routes plus the coordinator that puts captures in its chat. */
export function SnapShotOverlayRoot() {
  const startOverlayDraft = useStartSnapShotOverlayDraft();
  return (
    <>
      <SnapShotCoordinator overlay startOverlayDraft={startOverlayDraft} />
      <Outlet />
    </>
  );
}

/** Where the overlay window opens: a fresh chat without a project. */
export function SnapShotOverlayStart() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const startOverlayDraft = useStartSnapShotOverlayDraft();
  const startedRef = useRef(false);
  useEffect(() => {
    if (primaryEnvironmentId === null || startedRef.current) return;
    startedRef.current = true;
    void startOverlayDraft();
  }, [primaryEnvironmentId, startOverlayDraft]);
  return null;
}

/**
 * The overlay's card around its chat. The window is transparent, so the card is all the user
 * sees. Escape hides the overlay, keeping the chat for the next capture.
 */
export function SnapShotOverlayFrame({
  threadRef,
  children,
}: {
  /** The sent chat, which can then be opened in the main window. */
  readonly threadRef: ScopedThreadRef | null;
  readonly children: ReactNode;
}) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // The composer and dialogs claim Escape first, for menus they close.
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      void window.desktopBridge?.hideSnapShotOverlay?.();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="flex h-svh min-h-0 p-3">
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl">
        <div className="drag-region flex h-9 shrink-0 items-center justify-end gap-1 px-2">
          {threadRef ? (
            <Button
              size="xs"
              variant="ghost"
              className="[-webkit-app-region:no-drag]"
              onClick={() => void window.desktopBridge?.openThreadInMainWindow?.(threadRef)}
            >
              <ExternalLinkIcon className="size-3.5" />
              Open in T3
            </Button>
          ) : null}
        </div>
        <div className="flex min-h-0 min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
