import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Outlet } from "@tanstack/react-router";
import { ExternalLinkIcon } from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

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

/** How far the bottom of the overlay window reaches below the work area, over the Dock. */
function measureBelowWorkArea(): number {
  const { availHeight, availTop = 0 } = window.screen as Screen & { availTop?: number };
  return Math.max(0, window.screenY + window.innerHeight - (availTop + availHeight));
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The overlay's composer, floating where the main window's composer sits. The window reaches
 * the bottom of the screen, so the composer slides up from the screen edge when the overlay
 * shows and drops back down when Escape hides it, keeping the chat for the next capture. Only
 * the composer and its menus take the pointer; elsewhere clicks reach the app behind.
 */
export function SnapShotOverlayFrame({
  threadRef,
  children,
}: {
  /** The sent chat, which can then be opened in the main window. */
  readonly threadRef: ScopedThreadRef | null;
  readonly children: ReactNode;
}) {
  const [shown, setShown] = useState(false);
  const [belowWorkArea, setBelowWorkArea] = useState(0);
  const hidingRef = useRef(false);

  useEffect(() => {
    const slideIn = () => {
      if (document.visibilityState !== "visible") return;
      hidingRef.current = false;
      setBelowWorkArea(measureBelowWorkArea());
      // Paint the composer below the screen edge first, so it has somewhere to slide from.
      requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") slideIn();
      else setShown(false);
    };
    slideIn();
    window.addEventListener("focus", slideIn);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", slideIn);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // The composer and dialogs claim Escape first, for menus they close.
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      if (prefersReducedMotion()) {
        void window.desktopBridge?.hideSnapShotOverlay?.();
        return;
      }
      hidingRef.current = true;
      setShown(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    let interactive = false;
    const setInteractive = (next: boolean) => {
      if (next === interactive) return;
      interactive = next;
      void window.desktopBridge?.setSnapShotOverlayInteractive?.(next);
    };
    // The window ignores the pointer but still reports its moves; take it over content only.
    const onPointerMove = (event: MouseEvent) => {
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      setInteractive(hit !== null && hit !== document.documentElement && hit !== document.body);
    };
    const onHidden = () => {
      if (document.visibilityState !== "visible") setInteractive(false);
    };
    window.addEventListener("mousemove", onPointerMove);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      window.removeEventListener("mousemove", onPointerMove);
      document.removeEventListener("visibilitychange", onHidden);
      setInteractive(false);
    };
  }, []);

  return (
    <div
      className="pointer-events-none flex h-svh min-h-0 overflow-hidden"
      style={{ paddingBottom: belowWorkArea + 12 }}
    >
      <div
        data-snap-shot-overlay-slide
        data-snap-shot-overlay-shown={shown || undefined}
        className="relative flex min-h-0 min-w-0 flex-1 translate-y-[calc(100%+var(--overlay-drop))] transition-transform duration-200 ease-in data-snap-shot-overlay-shown:translate-y-0 data-snap-shot-overlay-shown:duration-300 data-snap-shot-overlay-shown:ease-drawer motion-reduce:transition-none"
        style={{ "--overlay-drop": `${belowWorkArea + 12}px` } as CSSProperties}
        onTransitionEnd={(event) => {
          if (event.target !== event.currentTarget || shown || !hidingRef.current) return;
          hidingRef.current = false;
          void window.desktopBridge?.hideSnapShotOverlay?.();
        }}
      >
        {threadRef ? (
          <Button
            size="xs"
            variant="glass"
            className="pointer-events-auto absolute top-3 right-14 z-30"
            onClick={() => void window.desktopBridge?.openThreadInMainWindow?.(threadRef)}
          >
            <ExternalLinkIcon className="size-3.5" />
            Open in T3
          </Button>
        ) : null}
        <div className="flex min-h-0 min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
