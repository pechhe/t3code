import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

interface SelectedWorkspaceStoreState {
  /** The selected attachment's workspace path; a thread without an entry uses its primary. */
  byThreadKey: Record<string, string>;
  select: (ref: ScopedThreadRef, workspacePath: string | null) => void;
}

export const useSelectedWorkspaceStore = create<SelectedWorkspaceStoreState>()((set) => ({
  byThreadKey: {},
  select: (ref, workspacePath) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      if (workspacePath === null) {
        if (!(threadKey in state.byThreadKey)) return state;
        const { [threadKey]: _removed, ...rest } = state.byThreadKey;
        return { byThreadKey: rest };
      }
      return { byThreadKey: { ...state.byThreadKey, [threadKey]: workspacePath } };
    }),
}));
