import { create } from "zustand";

import type { DraftId } from "./composerDraftStore";

interface DraftProjectChoiceState {
  /**
   * Drafts the general New thread action opened before any project was picked. Not persisted:
   * a reloaded draft keeps the project it shows.
   */
  readonly unchosenDraftIds: Readonly<Record<string, true>>;
  readonly markUnchosen: (draftId: DraftId) => void;
  readonly markChosen: (draftId: DraftId) => void;
}

export const useDraftProjectChoiceStore = create<DraftProjectChoiceState>()((set) => ({
  unchosenDraftIds: {},
  markUnchosen: (draftId) =>
    set((state) =>
      state.unchosenDraftIds[draftId]
        ? state
        : { unchosenDraftIds: { ...state.unchosenDraftIds, [draftId]: true } },
    ),
  markChosen: (draftId) =>
    set((state) => {
      if (!state.unchosenDraftIds[draftId]) return state;
      const { [draftId]: _chosen, ...rest } = state.unchosenDraftIds;
      return { unchosenDraftIds: rest };
    }),
}));

export function useDraftProjectUnchosen(draftId: DraftId | null): boolean {
  return useDraftProjectChoiceStore(
    (state) => draftId !== null && state.unchosenDraftIds[draftId] === true,
  );
}
