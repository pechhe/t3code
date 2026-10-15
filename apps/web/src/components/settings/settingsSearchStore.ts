import { create } from "zustand";

/**
 * The settings search query. The sidebar edits it; while it is non-empty the
 * settings layout shows every matching setting in place of the current page.
 */
export const useSettingsSearchQuery = create<{
  query: string;
  setQuery: (query: string) => void;
}>((set) => ({
  query: "",
  setQuery: (query) => set({ query }),
}));
