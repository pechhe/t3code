import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { DesktopSnapShotDraftHandoff } from "@t3tools/contracts";
import { Outlet, useRouter } from "@tanstack/react-router";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useScratchProject } from "../../hooks/useScratchProject";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { SnapShotCoordinator } from "../desktop/SnapShotCoordinator";

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
    prepareMainWindowFor(created?.draftId ?? null);
    return created?.draftId ?? null;
  }, [handleNewThread, openScratchProject, primaryEnvironmentId]);
}

/** The overlay's current chat, read from its route. */
function currentOverlayDraftId(router: ReturnType<typeof useRouter>): DraftId | null {
  const route = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
  return route?.kind === "draft" ? route.draftId : null;
}

/** Opens the overlay chat's project on the main window's new-chat page, ready for the handover. */
function prepareMainWindowFor(draftId: DraftId | null): void {
  const session = draftId ? useComposerDraftStore.getState().getDraftSession(draftId) : null;
  if (!session || session.promotedTo) return;
  void window.desktopBridge?.prepareSnapShotDraftHandoff?.(
    scopeProjectRef(session.environmentId, session.projectId),
  );
}

/** The overlay's chat in the form the main window takes it over in. */
function snapShotDraftHandoff(draftId: DraftId): DesktopSnapShotDraftHandoff | null {
  const store = useComposerDraftStore.getState();
  const session = store.getDraftSession(draftId);
  if (!session) return null;
  const draft = store.getComposerDraft(draftId);
  const modelSelection = draft?.activeProvider
    ? draft.modelSelectionByProvider[draft.activeProvider]
    : undefined;
  return {
    projectRef: scopeProjectRef(session.environmentId, session.projectId),
    prompt: draft?.prompt ?? "",
    images: (draft?.persistedAttachments ?? []).map(
      ({ id, name, mimeType, sizeBytes, dataUrl, source }) => ({
        id,
        name,
        mimeType,
        sizeBytes,
        dataUrl,
        ...(source ? { source } : {}),
      }),
    ),
    ...(modelSelection ? { modelSelection } : {}),
  };
}

/**
 * When the main window takes focus while the overlay is up, the overlay's chat moves there:
 * an unsent one onto the main window's new-chat page, a sent one by opening it.
 */
function useSnapShotOverlayHandoff() {
  const router = useRouter();
  useEffect(() => {
    const bridge = window.desktopBridge;
    // Activating the app and focusing the main window can both ask; the chat moves once.
    let handingOff = false;
    return bridge?.onSnapShotOverlayHandoffRequest?.(() => {
      if (handingOff) return;
      const route = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
      const draftId = currentOverlayDraftId(router);
      const threadRef = route?.kind === "server" ? route.threadRef : null;
      const sentThread =
        threadRef ??
        (draftId ? useComposerDraftStore.getState().getDraftSession(draftId)?.promotedTo : null);
      if (sentThread) {
        void bridge.openThreadInMainWindow?.(sentThread);
        return;
      }
      const draft = draftId ? snapShotDraftHandoff(draftId) : null;
      if (!draftId || !draft) {
        void bridge.hideSnapShotOverlay?.();
        return;
      }
      handingOff = true;
      void bridge
        .handOffSnapShotDraft?.(draft)
        .then(() => useComposerDraftStore.getState().clearComposerPromptAndImages(draftId))
        .finally(() => {
          handingOff = false;
        });
    });
  }, [router]);
  useEffect(
    () =>
      window.desktopBridge?.onSnapShotOverlayVisibility?.((visible) => {
        if (visible) prepareMainWindowFor(currentOverlayDraftId(router));
      }),
    [router],
  );
}

/** The overlay window's app: its routes plus the coordinator that puts captures in its chat. */
export function SnapShotOverlayRoot() {
  const startOverlayDraft = useStartSnapShotOverlayDraft();
  useSnapShotOverlayHandoff();
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

/** Layers that close on Escape before the overlay does. */
const OPEN_LAYER_SELECTOR =
  '[data-composer-drawer-layer], [data-slot$="-popup"]:not([data-closed]), [role="dialog"]';

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The overlay's composer, floating exactly where the main window's composer sits. The window
 * reaches the bottom of the screen, so the composer slides up from the screen edge when the
 * overlay shows and drops back down when Escape hides it, keeping the chat for the next
 * capture. Only the composer and its menus take the pointer; elsewhere clicks reach the app
 * behind.
 */
export function SnapShotOverlayFrame({ children }: { readonly children: ReactNode }) {
  const [shown, setShown] = useState(false);
  const [belowWorkArea, setBelowWorkArea] = useState(0);
  const hidingRef = useRef(false);

  useEffect(() => {
    const slideIn = () => {
      hidingRef.current = false;
      setShown(false);
      void (window.desktopBridge?.getSnapShotOverlayBottomInset?.() ?? Promise.resolve(0))
        .catch(() => 0)
        .then((inset) => {
          setBelowWorkArea(inset);
          // Paint the composer below the screen edge first, so it has somewhere to slide from.
          requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
        });
    };
    // The window never reports itself hidden, so the desktop app says when it shows and hides.
    if (document.hasFocus()) slideIn();
    return window.desktopBridge?.onSnapShotOverlayVisibility?.((visible) => {
      if (visible) {
        slideIn();
        return;
      }
      hidingRef.current = false;
      setShown(false);
    });
  }, []);

  useEffect(() => {
    // Escape hides the overlay from anywhere, the composer included, unless it is closing a menu,
    // popup or the composer's suggestions first. Listening ahead of the composer, which keeps
    // Escape for itself.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
      if (document.querySelector(OPEN_LAYER_SELECTOR)) return;
      event.preventDefault();
      event.stopPropagation();
      if (prefersReducedMotion()) {
        void window.desktopBridge?.hideSnapShotOverlay?.();
        return;
      }
      hidingRef.current = true;
      setShown(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
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
      style={{ paddingBottom: belowWorkArea }}
    >
      <div
        data-snap-shot-overlay-slide
        data-snap-shot-overlay-shown={shown || undefined}
        className="relative flex min-h-0 min-w-0 flex-1 translate-y-[calc(100%+var(--overlay-drop))] transition-transform duration-200 ease-in data-snap-shot-overlay-shown:translate-y-0 data-snap-shot-overlay-shown:duration-300 data-snap-shot-overlay-shown:ease-drawer motion-reduce:transition-none"
        style={{ "--overlay-drop": `${belowWorkArea}px` } as CSSProperties}
        onTransitionEnd={(event) => {
          if (event.target !== event.currentTarget || shown || !hidingRef.current) return;
          hidingRef.current = false;
          void window.desktopBridge?.hideSnapShotOverlay?.();
        }}
      >
        <div className="flex min-h-0 min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
