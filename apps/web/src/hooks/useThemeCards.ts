import { BUILT_IN_THEMES } from "@t3tools/shared/themePalettes";
import { useMemo } from "react";

import {
  getThemeCardDefinition,
  STANDARD_THEME_CARDS,
} from "../components/settings/ThemePreviewCircles";
import { useCustomThemes } from "./useCustomThemes";
import { useEnvironmentThemeDefinitions } from "./useEnvironmentTheme";

/** Every theme a user can pick, standard first; the standard card has a null id. */
export function useThemeCards() {
  const customThemes = useCustomThemes();
  const environmentThemes = useEnvironmentThemeDefinitions();
  return useMemo(() => {
    const seen = new Set<string>();
    return [
      ...STANDARD_THEME_CARDS.map((card) => ({ ...card, id: null })),
      ...[...BUILT_IN_THEMES, ...customThemes, ...environmentThemes]
        .filter((definition) => {
          if (seen.has(definition.id)) return false;
          seen.add(definition.id);
          return true;
        })
        .map(getThemeCardDefinition),
    ];
  }, [customThemes, environmentThemes]);
}
