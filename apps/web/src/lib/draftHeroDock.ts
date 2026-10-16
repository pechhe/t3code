import { create } from "zustand";

/**
 * Drafts whose composer starts docked at the bottom rather than centred, like a chat handed
 * over from the SnapShot overlay, so its composer appears where the overlay's was.
 */
export const useDockedDraftHeroStore = create<{ readonly threadKeys: ReadonlySet<string> }>(() => ({
  threadKeys: new Set<string>(),
}));

export function requestDraftHeroDock(threadKey: string): void {
  useDockedDraftHeroStore.setState(({ threadKeys }) => ({
    threadKeys: new Set(threadKeys).add(threadKey),
  }));
}
