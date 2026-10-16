import { HTML_RENDER_DEFAULT_FONTS, htmlRenderTheme } from "@t3tools/shared/htmlRender";
import { useMemo, useSyncExternalStore } from "react";

import { appearanceFontStack } from "../appearanceFonts";
import {
  getStandardThemeColors,
  getThemeColorsForMode,
  getThemeDefinition,
  subscribeToCustomThemes,
  themeColorToHex,
  type ThemeAppearance,
  type ThemePreference,
} from "../themePalette";
import { useClientSettings } from "./useSettings";
import { useTheme } from "./useTheme";

/** The palette `applyTheme` paints for the active theme, or the stock look when no theme applies. */
function resolveActiveThemeColors(activeTheme: ThemePreference, appearance: ThemeAppearance) {
  const definition = getThemeDefinition(activeTheme);
  return definition === null
    ? getStandardThemeColors(appearance)
    : (getThemeColorsForMode(definition, appearance) ?? definition.colors);
}

/** The app's active theme and fonts, as handed to agent HTML renders. Stable until one changes. */
export function useHtmlRenderTheme() {
  const { activeTheme, resolvedTheme } = useTheme();
  // Custom and published palettes can be edited in place, under an unchanged preference.
  const colors = useSyncExternalStore(
    subscribeToCustomThemes,
    () => resolveActiveThemeColors(activeTheme, resolvedTheme),
    () => getStandardThemeColors(resolvedTheme),
  );
  const sans = useClientSettings((settings) => settings.fontFamilySans);
  const mono = useClientSettings((settings) => settings.fontFamilyCode);
  return useMemo(
    () =>
      htmlRenderTheme(
        Object.fromEntries(
          Object.entries(colors).map(([role, color]) => [role, themeColorToHex(color) ?? color]),
        ) as typeof colors,
        resolvedTheme,
        {
          sans: appearanceFontStack(sans, HTML_RENDER_DEFAULT_FONTS.sans),
          mono: appearanceFontStack(mono, HTML_RENDER_DEFAULT_FONTS.mono),
        },
      ),
    [colors, resolvedTheme, sans, mono],
  );
}
