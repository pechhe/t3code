import { create } from "zustand";

/**
 * Drafts whose new-chat page keeps its composer at the bottom rather than centred, like a chat
 * handed over from the SnapShot overlay, so its composer appears where the overlay's was.
 */
export const useBottomDraftHeroStore = create<{ readonly threadKeys: ReadonlySet<string> }>(() => ({
  threadKeys: new Set<string>(),
}));

export function placeDraftHeroAtBottom(threadKey: string): void {
  useBottomDraftHeroStore.setState(({ threadKeys }) => ({
    threadKeys: new Set(threadKeys).add(threadKey),
  }));
}
