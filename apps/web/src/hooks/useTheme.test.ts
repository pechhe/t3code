import { afterEach, describe, expect, it, vi } from "vite-plus/test";

function createStorage(overrides: Partial<Storage> = {}): Storage {
  const store = new Map<string, string>();
  return {
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
    ...overrides,
  };
}

afterEach(() => {
  vi.doUnmock("react");
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("project themes", () => {
  it("paints the open project's theme over the user's mix, and falls back when it cannot", async () => {
    vi.doMock("react", () => ({
      useCallback: <A>(callback: A) => callback,
      useEffect: () => undefined,
      useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
    }));
    const { THEME_APPEARANCE_MODE_STORAGE_KEY, THEME_HALVES_STORAGE_KEY } =
      await import("../themePalette");
    const localStorage = createStorage();
    localStorage.setItem("t3code:theme", "ocean");
    localStorage.setItem(THEME_APPEARANCE_MODE_STORAGE_KEY, "dark");
    localStorage.setItem(THEME_HALVES_STORAGE_KEY, JSON.stringify({ dark: "ember" }));
    vi.stubGlobal("window", { localStorage, matchMedia: () => ({ matches: true }) });

    const { setActiveProjectTheme, useTheme } = await import("./useTheme");
    const read = () => {
      const { theme, themeHalves, projectTheme, activeTheme, resolvedTheme } = useTheme();
      return { theme, themeHalves, projectTheme, activeTheme, resolvedTheme };
    };
    const ownChoice = {
      theme: "ocean",
      themeHalves: { dark: "ember" },
      projectTheme: null,
      activeTheme: "ember",
      resolvedTheme: "dark",
    };

    expect(read()).toEqual(ownChoice);

    const wholeTheme = { theme: "grove" };
    setActiveProjectTheme(wholeTheme);
    // The user's own choice is untouched, so Settings still edits it.
    expect(read()).toEqual({ ...ownChoice, projectTheme: wholeTheme, activeTheme: "grove" });

    // The project's own dark pick wins over its base, as the user's does.
    const mixedTheme = { theme: "grove", dark: "ocean" };
    setActiveProjectTheme(mixedTheme);
    expect(read()).toEqual({ ...ownChoice, projectTheme: mixedTheme, activeTheme: "ocean" });

    // A theme this device no longer has must not leave the app unthemed.
    setActiveProjectTheme({ theme: "deleted-custom-theme", dark: "ocean" });
    expect(read()).toEqual(ownChoice);

    setActiveProjectTheme(null);
    expect(read()).toEqual(ownChoice);
  });
});
