import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type {
  DesktopSnapShotDraftHandoff,
  DesktopSnapShotOverlayInsets,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { Outlet, useRouter } from "@tanstack/react-router";
import {
  type CSSProperties,
  type ReactNode,
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  type ComposerThreadTarget,
  type DraftId,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useScratchProject } from "../../hooks/useScratchProject";
import { useStableCallback } from "../../hooks/useStableCallback";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../../threadRoutes";
import { SnapShotCoordinator } from "../desktop/SnapShotCoordinator";
import { isSnapShotOverlayDocked, useSnapShotOverlaySession } from "./snapShotOverlaySession";

// Ending a conversation and a capture arriving just after both ask for a fresh chat; they share
// one, so the capture lands in the chat the overlay shows.
let startingOverlayDraft: Promise<DraftId | null> | null = null;

/** Starts a fresh chat without a project in the overlay window, replacing what it shows. */
function useStartSnapShotOverlayDraft(): () => Promise<DraftId | null> {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { openScratchProject } = useScratchProject();
  const handleNewThread = useNewThreadHandler();
  const start = async () => {
    if (primaryEnvironmentId === null) return null;
    const project = await openScratchProject(primaryEnvironmentId);
    if (!project) return null;
    const created = await handleNewThread(scopeProjectRef(project.environmentId, project.id), {
      replace: true,
    });
    prepareMainWindowFor(created?.draftId ?? null);
    return created?.draftId ?? null;
  };
  return () => {
    startingOverlayDraft ??= start().finally(() => {
      startingOverlayDraft = null;
    });
    return startingOverlayDraft;
  };
}

/** The overlay's current chat, read from its route. */
function currentOverlayDraftId(router: ReturnType<typeof useRouter>): DraftId | null {
  const route = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
  return route?.kind === "draft" ? route.draftId : null;
}

/** The conversation the overlay shows once its chat is sent; null while it is unsent. */
function currentOverlayConversation(router: ReturnType<typeof useRouter>): ScopedThreadRef | null {
  const route = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
  if (route?.kind === "server") return route.threadRef;
  const draftId = route?.kind === "draft" ? route.draftId : null;
  return (draftId && useComposerDraftStore.getState().getDraftSession(draftId)?.promotedTo) || null;
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
 * When the main window takes focus while the overlay is up, an unsent chat moves onto the main
 * window's new-chat page. A conversation stays in the overlay until the user ends it.
 */
function useSnapShotOverlayHandoff() {
  const router = useRouter();
  useEffect(() => {
    const bridge = window.desktopBridge;
    // Activating the app and focusing the main window can both ask; the chat moves once.
    let handingOff = false;
    return bridge?.onSnapShotOverlayHandoffRequest?.(() => {
      if (handingOff || currentOverlayConversation(router)) return;
      const draftId = currentOverlayDraftId(router);
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

/** Menus, popups and rows that close on Escape before anything else does. */
export const SNAP_SHOT_OPEN_POPUP_SELECTOR =
  '[data-composer-drawer-layer], [data-slot$="-popup"]:not([data-closed]), [role="dialog"], [data-snap-shot-project-row]';
/** Layers that close on Escape before the overlay does: popups, then the whole conversation. */
const OPEN_LAYER_SELECTOR = `${SNAP_SHOT_OPEN_POPUP_SELECTOR}, [data-snap-shot-expanded]`;

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** What the overlay's chat can ask of the overlay around it. */
export interface SnapShotOverlayControls {
  /**
   * Puts a conversation's composer away behind the pill, or slides an unsent chat away, keeping
   * it for the next time the overlay shows.
   */
  readonly hide: () => void;
  /** Brings a conversation's composer back up from behind the pill. */
  readonly show: () => void;
  /** Ends the conversation on screen: the overlay slides away and the next capture starts fresh. */
  readonly end: () => void;
  /** Ends the conversation on screen for a fresh chat, taking the composer's content along. */
  readonly startNewChat: (composerTarget: ComposerThreadTarget) => void;
  /** Takes the fresh chat's content back to the conversation the user last ended. */
  readonly resume: (draftId: DraftId) => void;
  /** Where the overlay's pill floats: centred at the bottom of the work area, above any Dock. */
  readonly floor: HTMLElement | null;
}

const SnapShotOverlayControlsContext = createContext<SnapShotOverlayControls | null>(null);

/** The overlay's controls, or null outside the overlay window. */
export function useSnapShotOverlayControls(): SnapShotOverlayControls | null {
  return useContext(SnapShotOverlayControlsContext);
}

/**
 * The overlay's composer, floating exactly where the main window's composer sits. The window
 * reaches the bottom of the screen, so the composer slides up from the screen edge when the
 * overlay shows. Hiding a conversation leaves a pill on screen to bring it back; hiding an unsent
 * chat drops the composer back down and hides the overlay, keeping the chat for next time. Escape
 * ends a conversation, so the next capture starts fresh. Only the composer, the pill and their
 * menus take the pointer; elsewhere clicks reach the app behind.
 */
export function SnapShotOverlayFrame({ children }: { readonly children: ReactNode }) {
  const router = useRouter();
  const startOverlayDraft = useStartSnapShotOverlayDraft();
  const [shown, setShownState] = useState(false);
  const shownRef = useRef(false);
  const setShown = (next: boolean) => {
    shownRef.current = next;
    setShownState(next);
  };
  const [insets, setInsets] = useState<DesktopSnapShotOverlayInsets>({ composer: 0, workArea: 0 });
  const [floor, setFloor] = useState<HTMLElement | null>(null);
  // Set while the overlay slides away, with what to do once it is hidden.
  const hidingRef = useRef<{ readonly afterHide: (() => void) | undefined } | null>(null);

  const finishHiding = useStableCallback(() => {
    const hiding = hidingRef.current;
    hidingRef.current = null;
    void window.desktopBridge?.hideSnapShotOverlay?.();
    hiding?.afterHide?.();
  });
  const slideAway = useStableCallback((afterHide?: () => void) => {
    hidingRef.current = { afterHide };
    if (prefersReducedMotion() || !shownRef.current) {
      finishHiding();
      return;
    }
    setShown(false);
  });

  const end = useStableCallback(() => {
    const conversation = currentOverlayConversation(router);
    if (!conversation) {
      slideAway();
      return;
    }
    useSnapShotOverlaySession.getState().endConversation(conversation, Date.now());
    slideAway(() => void startOverlayDraft());
  });

  const startNewChat = useStableCallback((composerTarget: ComposerThreadTarget) => {
    const conversation = currentOverlayConversation(router);
    if (!conversation) return;
    useSnapShotOverlaySession.getState().endConversation(conversation, Date.now());
    void startOverlayDraft().then((draftId) => {
      if (draftId) {
        useComposerDraftStore.getState().moveComposerPromptAndImages(composerTarget, draftId);
      } else {
        // No fresh chat: the conversation carries on.
        useSnapShotOverlaySession.getState().forgetEnded();
      }
    });
  });

  const hide = useStableCallback(() => {
    if (currentOverlayConversation(router)) useSnapShotOverlaySession.getState().hide();
    else slideAway();
  });

  // The show-or-hide shortcut, pressed while the overlay is on screen.
  const toggle = useStableCallback(() => {
    const session = useSnapShotOverlaySession.getState();
    if (
      currentOverlayConversation(router) &&
      isSnapShotOverlayDocked(session, session.workingTurn)
    ) {
      session.show();
    } else {
      hide();
    }
  });

  const resume = useStableCallback((draftId: DraftId) => {
    const { ended, forgetEnded, show } = useSnapShotOverlaySession.getState();
    if (!ended) return;
    forgetEnded();
    show();
    useComposerDraftStore.getState().moveComposerPromptAndImages(draftId, ended.threadRef);
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(ended.threadRef),
      replace: true,
    });
  });

  useEffect(() => {
    const slideIn = () => {
      hidingRef.current = null;
      setShown(false);
      const session = useSnapShotOverlaySession.getState();
      session.show();
      session.forgetStaleEnded(Date.now());
      void (
        window.desktopBridge?.getSnapShotOverlayInsets?.() ??
        Promise.resolve({ composer: 0, workArea: 0 })
      )
        .catch(() => ({ composer: 0, workArea: 0 }))
        .then((next) => {
          setInsets(next);
          // Paint the composer below the screen edge first, so it has somewhere to slide from.
          requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
        });
    };
    // The window never reports itself hidden, so the desktop app says when it shows and hides.
    if (document.hasFocus()) slideIn();
    const stopVisibility = window.desktopBridge?.onSnapShotOverlayVisibility?.((visible) => {
      if (visible) {
        slideIn();
        return;
      }
      // Hidden by the desktop app mid-slide: finish what the slide was for.
      const hiding = hidingRef.current;
      hidingRef.current = null;
      setShown(false);
      hiding?.afterHide?.();
    });
    const stopToggleRequest = window.desktopBridge?.onSnapShotOverlayToggleRequest?.(toggle);
    return () => {
      stopVisibility?.();
      stopToggleRequest?.();
    };
  }, [setShown, toggle]);

  useEffect(() => {
    // Escape ends the conversation from anywhere, the composer included, or hides an unsent chat,
    // unless it is closing a menu, popup or the composer's suggestions first. Listening ahead of
    // the composer, which keeps Escape for itself.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
      if (document.querySelector(OPEN_LAYER_SELECTOR)) return;
      event.preventDefault();
      event.stopPropagation();
      end();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [end]);

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

  const controls: SnapShotOverlayControls = {
    hide,
    show: () => useSnapShotOverlaySession.getState().show(),
    end,
    startNewChat,
    resume,
    floor,
  };

  return (
    <SnapShotOverlayControlsContext value={controls}>
      <div
        // Clipped rather than hidden, so focusing the composer mid-slide cannot scroll it.
        className="pointer-events-none relative flex h-svh min-h-0 overflow-clip"
        style={{ paddingBottom: insets.composer }}
      >
        {/* Sliding in plays the slide out backwards: the same duration and the reversed curve. */}
        <div
          data-snap-shot-overlay-slide
          data-snap-shot-overlay-shown={shown || undefined}
          className="relative flex min-h-0 min-w-0 flex-1 translate-y-[calc(100%+var(--overlay-drop))] transition-transform duration-200 ease-in data-snap-shot-overlay-shown:translate-y-0 data-snap-shot-overlay-shown:ease-in-reversed motion-reduce:transition-none"
          style={{ "--overlay-drop": `${insets.composer}px` } as CSSProperties}
          onTransitionEnd={(event) => {
            if (event.target !== event.currentTarget || shown || !hidingRef.current) return;
            finishHiding();
          }}
        >
          <div className="flex min-h-0 min-w-0 flex-1">{children}</div>
        </div>
        <div
          ref={setFloor}
          className="pointer-events-none absolute inset-x-0 flex justify-center"
          style={{ bottom: insets.workArea }}
        />
      </div>
    </SnapShotOverlayControlsContext>
  );
}
