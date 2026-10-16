import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { DesktopSnapShotDraftHandoff } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { dispatchSnapShotComposerFocus } from "../../lib/desktopSnapShot";
import { placeDraftHeroAtBottom } from "../../lib/draftHeroAtBottom";
import { dataUrlToFile } from "../../lib/imageCompression";
import { buildThreadRouteParams } from "../../threadRoutes";

/**
 * Puts the SnapShot overlay's unsent chat in the main window's composer for its project,
 * on its new-chat page with the composer where the overlay's was, after anything already
 * drafted there.
 */
export async function receiveSnapShotDraft(
  draft: DesktopSnapShotDraftHandoff,
  openProjectDraft: ReturnType<typeof useNewThreadHandler>,
): Promise<void> {
  const opened = await openProjectDraft(draft.projectRef);
  if (!opened) return;
  const { draftId } = opened;
  placeDraftHeroAtBottom(
    scopedThreadKey(scopeThreadRef(draft.projectRef.environmentId, opened.threadId)),
  );
  const store = useComposerDraftStore.getState();
  const existing = store.getComposerDraft(draftId);
  if (draft.prompt.trim().length > 0) {
    const prompt = existing?.prompt.trim() ? `${existing.prompt}\n\n${draft.prompt}` : draft.prompt;
    store.setPrompt(draftId, prompt);
  }
  const attached = new Set(existing?.images.map(({ id }) => id));
  const images = draft.images.filter(({ id }) => !attached.has(id));
  for (const image of images) {
    store.addImage(draftId, {
      type: "image",
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      previewUrl: image.dataUrl,
      file: dataUrlToFile(image.dataUrl, image.name, image.mimeType),
      ...(image.source ? { source: image.source } : {}),
    });
  }
  if (images.length > 0) {
    const persisted = store.getComposerDraft(draftId)?.persistedAttachments ?? [];
    await store.syncPersistedAttachments(draftId, [...persisted, ...images]);
  }
  if (draft.modelSelection) store.setModelSelection(draftId, draft.modelSelection);
  dispatchSnapShotComposerFocus();
}

/**
 * Opens what the desktop app hands the main window: a thread, such as one sent from the
 * SnapShot overlay, or the overlay's unsent chat when the main window takes focus.
 */
export function DesktopOpenThreadCoordinator() {
  const navigate = useNavigate();
  const openProjectDraft = useNewThreadHandler();
  useEffect(
    () =>
      window.desktopBridge?.onOpenThread?.((threadRef) => {
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(threadRef),
        });
      }),
    [navigate],
  );
  useEffect(
    () =>
      window.desktopBridge?.onSnapShotDraftHandoff?.((draft) => {
        void receiveSnapShotDraft(draft, openProjectDraft);
      }),
    [openProjectDraft],
  );
  return null;
}
