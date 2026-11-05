import {
  setProjectBaseTheme,
  setProjectThemeHalf,
  useActiveProjectKey,
} from "../hooks/useProjectTheme";
import { getThemeDefinition } from "../themePalette";
import { useThemeCards } from "../hooks/useThemeCards";
import { ThemePreviewCircle } from "./settings/ThemePreviewCircles";
import { useUiStateStore } from "../uiStateStore";
import { MonitorIcon, MoonIcon, PaletteIcon, SunIcon } from "lucide-react";

import { useNextRotationTheme, useTheme } from "../hooks/useTheme";
import { STANDARD_ROTATION_THEME } from "../themeRotation";
import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteSubmenuItem,
} from "./CommandPalette.logic";
import { toggleThemeEditorForTheme } from "./settings/themeEditorStore";
import { stackedThreadToast, toastManager } from "./ui/toast";

export const APPEARANCE_OPTIONS = [
  { mode: "system", label: "System", icon: MonitorIcon },
  { mode: "light", label: "Light", icon: SunIcon },
  { mode: "dark", label: "Dark", icon: MoonIcon },
] as const;

export function notifyThemeSaveFailure(): void {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: "Couldn't save theme selection",
      description: "Try again.",
    }),
  );
}

export function useCommandPaletteThemeItems() {
  const {
    theme,
    themeHalves,
    resolvedTheme,
    appearanceMode,
    setAppearanceMode,
    setTheme,
    setThemeHalf,
    projectTheme,
    activeTheme,
    themeMode,
    rotationToday,
    setRotationOverride,
  } = useTheme();
  const inRotation = themeMode === "rotation";
  const { next: nextRotationTheme, cycle: cycleRotationTheme } = useNextRotationTheme();
  const themeCards = useThemeCards();
  // Inside a project with its own theme, picking a theme changes what is on
  // screen: that project's theme, not the user's own one underneath it.
  // Keyed on the painted project theme, so a project whose theme this device
  // no longer has behaves like an unthemed one, as it looks.
  const activeProjectKey = useActiveProjectKey();
  const setProjectTheme = useUiStateStore((store) => store.setProjectTheme);
  const themedProjectKey = projectTheme === null ? null : activeProjectKey;
  const currentThemeCardId = inRotation
    ? rotationToday.theme === STANDARD_ROTATION_THEME
      ? null
      : rotationToday.theme
    : projectTheme === null
      ? (themeHalves?.[resolvedTheme] ?? getThemeDefinition(theme)?.id ?? null)
      : (getThemeDefinition(activeTheme)?.id ?? null);

  const changeThemeItem: CommandPaletteSubmenuItem = {
    kind: "submenu",
    value: "action:change-theme",
    searchTerms: ["change theme", "appearance", "colors", "palette"],
    title: "Change theme",
    icon: <PaletteIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <PaletteIcon className={ADDON_ICON_CLASS} />,
    shortcutCommand: "theme.select",
    groups: [
      {
        value: "themes",
        label: inRotation
          ? "Use theme today"
          : themedProjectKey === null
            ? "Change theme"
            : "Change project theme",
        items: [
          ...(nextRotationTheme === null
            ? []
            : ([
                {
                  kind: "action",
                  value: "theme:next",
                  title: "Next theme",
                  description: "Show the next favourite for today",
                  searchTerms: ["next theme", "cycle", "rotation", "favourite", "today"],
                  icon: <PaletteIcon className={ITEM_ICON_CLASS} />,
                  run: async () => {
                    if (!cycleRotationTheme()) notifyThemeSaveFailure();
                  },
                },
              ] satisfies CommandPaletteActionItem[])),
          ...(inRotation && rotationToday.overridden
            ? ([
                {
                  kind: "action",
                  value: "theme:rotation",
                  title: "Back to rotation",
                  description: "Stop overriding today's theme",
                  searchTerms: ["rotation", "theme", "appearance", "reset", "today"],
                  icon: <PaletteIcon className={ITEM_ICON_CLASS} />,
                  run: async () => {
                    if (!setRotationOverride(null)) notifyThemeSaveFailure();
                  },
                },
              ] satisfies CommandPaletteActionItem[])
            : []),
          ...(themedProjectKey === null
            ? []
            : ([
                {
                  kind: "action",
                  value: "theme:app",
                  title: "App theme",
                  description: "Stop overriding the theme in this project",
                  searchTerms: ["app theme", "theme", "appearance", "reset"],
                  icon: <PaletteIcon className={ITEM_ICON_CLASS} />,
                  run: async () => setProjectTheme(themedProjectKey, null),
                },
              ] satisfies CommandPaletteActionItem[])),
          ...themeCards.map(({ id, label, previews }): CommandPaletteActionItem => ({
            kind: "action",
            value: id === null ? "theme:standard" : `theme:palette:${id}`,
            title: label,
            description:
              previews.length === 1 && !inRotation ? `For ${previews[0]!.mode} mode` : undefined,
            searchTerms: [label, "theme", "appearance"],
            icon: <PaletteIcon className={ITEM_ICON_CLASS} />,
            titleTrailingContent: (
              <span className="flex shrink-0 items-center gap-2">
                {currentThemeCardId === id ? (
                  <span className="text-xs text-muted-foreground/70">Current</span>
                ) : null}
                <span className="flex items-center gap-1" aria-hidden>
                  {previews.map((preview) => (
                    <ThemePreviewCircle
                      key={preview.mode}
                      colors={preview.colors}
                      mode={preview.mode}
                      className="size-3 border-0"
                    />
                  ))}
                </span>
              </span>
            ),
            run: async () => {
              if (inRotation) {
                if (!setTheme(id ?? "system")) notifyThemeSaveFailure();
                return;
              }
              if (themedProjectKey !== null) {
                if (previews.length === 1 && id !== null) {
                  setProjectThemeHalf(themedProjectKey, previews[0]!.mode, id);
                } else {
                  setProjectBaseTheme(themedProjectKey, id ?? appearanceMode);
                }
                return;
              }
              const saved =
                previews.length === 1 && id !== null
                  ? setThemeHalf(previews[0]!.mode, id)
                  : setTheme(id ?? appearanceMode);
              if (!saved) notifyThemeSaveFailure();
            },
          })),
        ],
      },
    ],
  };

  const changeAppearanceItem: CommandPaletteSubmenuItem = {
    kind: "submenu",
    value: "action:change-appearance",
    searchTerms: ["change appearance", "light", "dark", "system", "mode", "toggle"],
    title: "Change appearance",
    icon: <MonitorIcon className={ITEM_ICON_CLASS} />,
    addonIcon: <MonitorIcon className={ADDON_ICON_CLASS} />,
    shortcutCommand: "appearance.cycle",
    groups: [
      {
        value: "appearance",
        label: "Change appearance",
        items: APPEARANCE_OPTIONS.map(({ mode, label, icon: Icon }) => ({
          kind: "action",
          value: `appearance:${mode}`,
          title: label,
          searchTerms: [label, "appearance", "mode"],
          icon: <Icon className={ITEM_ICON_CLASS} />,
          titleTrailingContent:
            appearanceMode === mode ? (
              <span className="text-xs text-muted-foreground/70">Current</span>
            ) : undefined,
          run: async () => {
            if (!setAppearanceMode(mode)) notifyThemeSaveFailure();
          },
        })),
      },
    ],
  };

  const themeEditorItem: CommandPaletteActionItem = {
    kind: "action",
    value: "action:theme-editor",
    searchTerms: ["theme", "appearance", "colors", "palette", "customize"],
    title: "Toggle theme editor",
    icon: <PaletteIcon className={ITEM_ICON_CLASS} />,
    shortcutCommand: "themeEditor.toggle",
    run: async () => {
      toggleThemeEditorForTheme({
        theme,
        themeHalves,
        initialAppearance: resolvedTheme,
      });
    },
  };

  return { changeThemeItem, changeAppearanceItem, themeEditorItem };
}
