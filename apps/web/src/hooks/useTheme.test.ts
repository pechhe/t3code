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

// Importing the theme state pulls in the app's whole client graph, which is slow on a loaded runner.
vi.setConfig({ testTimeout: 60_000 });

afterEach(() => {
  vi.doUnmock("react");
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("project themes", () => {
  it("paints the open project's theme over the user's mix, and falls back when it cannot", async () => {
    vi.doMock("react", async (importOriginal) => ({
      ...(await importOriginal<typeof import("react")>()),
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
    vi.stubGlobal("window", {
      localStorage,
      location: { search: "" },
      matchMedia: () => ({ matches: true }),
    });

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

describe("theme mode", () => {
  const mockReact = () =>
    vi.doMock("react", async (importOriginal) => ({
      ...(await importOriginal<typeof import("react")>()),
      useCallback: <A>(callback: A) => callback,
      useEffect: () => undefined,
      useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
    }));

  async function readWith(storage: Record<string, string>, projectTheme: { theme: string } | null) {
    mockReact();
    const localStorage = createStorage();
    for (const [key, value] of Object.entries(storage)) localStorage.setItem(key, value);
    vi.stubGlobal("window", {
      localStorage,
      location: { search: "" },
      matchMedia: () => ({ matches: true }),
    });
    const { setActiveProjectTheme, useTheme } = await import("./useTheme");
    setActiveProjectTheme(projectTheme);
    const { activeTheme, projectTheme: painted, rotationToday } = useTheme();
    return { activeTheme, painted, rotationToday };
  }

  it("ignores the open project's theme unless themes are per project", async () => {
    const storage = { "t3code:theme": "ocean" };
    const project = { theme: "grove" };

    expect((await readWith(storage, project)).activeTheme).toBe("grove");

    vi.resetModules();
    const single = await readWith({ ...storage, "t3code:theme-mode:v1": "single" }, project);
    expect(single.activeTheme).toBe("ocean");
    expect(single.painted).toBeNull();
  });

  it("paints today's favourite in a daily rotation, over a project's theme", async () => {
    const { rotationDay } = await import("../themeRotation");
    const favourites = ["ocean", "grove", "ember"];
    const scheduled = rotationDay({ favourites, override: null }, new Date()).theme;

    const day = await readWith(
      {
        "t3code:theme": "iris",
        "t3code:theme-mode:v1": "rotation",
        "t3code:theme-rotation:v1": JSON.stringify({ favourites }),
      },
      { theme: "iris" },
    );
    expect(day.activeTheme).toBe(scheduled);
    expect(day.painted).toBeNull();
    expect(day.rotationToday.overridden).toBe(false);
  });

  it("paints a theme chosen for today, and the user's own theme when there are no favourites", async () => {
    const { localDateKey } = await import("../themeRotation");
    vi.resetModules();
    const chosen = await readWith(
      {
        "t3code:theme-mode:v1": "rotation",
        "t3code:theme-rotation:v1": JSON.stringify({
          favourites: ["ocean", "grove"],
          override: { date: localDateKey(new Date()), theme: "ember" },
        }),
      },
      null,
    );
    expect(chosen.activeTheme).toBe("ember");
    expect(chosen.rotationToday.overridden).toBe(true);

    vi.resetModules();
    const empty = await readWith(
      { "t3code:theme": "iris", "t3code:theme-mode:v1": "rotation" },
      null,
    );
    expect(empty.activeTheme).toBe("iris");
  });

  it("forgets deleted themes, keeping today's theme unless it was the deleted one", async () => {
    const { rotationDay } = await import("../themeRotation");
    const favourites = ["ocean", "grove", "ember", "iris"];
    const today = rotationDay({ favourites, override: null }, new Date()).theme!;

    const forget = async (gone: ReadonlyArray<string>) => {
      vi.resetModules();
      mockReact();
      const localStorage = createStorage();
      localStorage.setItem("t3code:theme-mode:v1", "rotation");
      localStorage.setItem("t3code:theme-rotation:v1", JSON.stringify({ favourites }));
      vi.stubGlobal("window", {
      localStorage,
      location: { search: "" },
      matchMedia: () => ({ matches: true }),
    });
      const { forgetRotationThemes } = await import("./useTheme");
      forgetRotationThemes(gone);
      return JSON.parse(localStorage.getItem("t3code:theme-rotation:v1")!) as {
        favourites: string[];
        override?: { date: string; theme: string };
      };
    };

    const others = favourites.filter((id) => id !== today);
    const afterOther = await forget([others[0]!]);
    expect(afterOther.favourites).not.toContain(others[0]);
    const todayAfterOther =
      afterOther.override?.theme ??
      rotationDay({ favourites: afterOther.favourites, override: null }, new Date()).theme;
    expect(todayAfterOther).toBe(today);

    const afterToday = await forget([today]);
    expect(afterToday.favourites).not.toContain(today);
    expect(afterToday.override).toBeUndefined();
  });

  it("cycles today's theme through the favourites in order, and does nothing for fewer than two", async () => {
    const { localDateKey } = await import("../themeRotation");
    const run = async (favourites: ReadonlyArray<string>, override: string | null) => {
      vi.resetModules();
      mockReact();
      const localStorage = createStorage();
      localStorage.setItem("t3code:theme-mode:v1", "rotation");
      localStorage.setItem(
        "t3code:theme-rotation:v1",
        JSON.stringify({
          favourites,
          ...(override ? { override: { date: localDateKey(new Date()), theme: override } } : {}),
        }),
      );
      vi.stubGlobal("window", {
      localStorage,
      location: { search: "" },
      matchMedia: () => ({ matches: true }),
    });
      const { useNextRotationTheme, useTheme } = await import("./useTheme");
      const before = useNextRotationTheme();
      const changed = before.cycle();
      return { next: before.next, changed, today: useTheme().rotationToday };
    };

    const second = await run(["ocean", "grove", "ember"], "ocean");
    expect(second.next).toBe("grove");
    expect(second.today.theme).toBe("grove");
    expect(second.today.overridden).toBe(true);

    const wrapped = await run(["ocean", "grove", "ember"], "ember");
    expect(wrapped.today.theme).toBe("ocean");

    const alone = await run(["ocean"], null);
    expect(alone.next).toBeNull();
    expect(alone.changed).toBe(false);
  });
});
