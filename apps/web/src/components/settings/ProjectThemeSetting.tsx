import { useState } from "react";

import { useCustomThemes } from "../../hooks/useCustomThemes";
import {
  setProjectBaseTheme,
  setProjectThemeHalf,
  useProjectTheme,
} from "../../hooks/useProjectTheme";
import { readThemeHalvesRaw, useTheme } from "../../hooks/useTheme";
import { pruneThemeHalves } from "../../themePalette";
import { useUiStateStore } from "../../uiStateStore";
import { SettingResetButton, SettingsSection } from "./settingsLayout";
import { ThemeLibrary } from "./ThemeSettings";

/**
 * The theme painted while a thread or draft of this project is open, on this device,
 * picked from the same gallery as the app theme. Until the project has its own, the
 * gallery shows the app theme, which the first pick starts from.
 */
export function ProjectThemeSetting({ projectKey }: { projectKey: string }) {
  const projectTheme = useProjectTheme(projectKey);
  const setProjectTheme = useUiStateStore((store) => store.setProjectTheme);
  const customThemes = useCustomThemes();
  const {
    theme: appTheme,
    themeHalves: appThemeHalves,
    appearanceMode,
    setAppearanceMode,
    resolvedTheme,
    refreshTheme,
    themeMode,
  } = useTheme();
  const [isImportOpen, setIsImportOpen] = useState(false);

  return (
    <SettingsSection
      title="Theme"
      variant="plain"
      headerAction={
        projectTheme !== null ? (
          <SettingResetButton
            label="project theme"
            tooltip="Use the app theme"
            onClick={() => setProjectTheme(projectKey, null)}
          />
        ) : null
      }
    >
      <p className="px-3 pb-1 text-xs text-muted-foreground sm:px-4">
        {themeMode !== "project"
          ? "Not shown right now: Theme mode in Appearance settings is set to one theme or a daily rotation. Anything you pick here is kept for when it is per project."
          : projectTheme === null
            ? "Uses your app theme. Pick a theme, or one for light and one for dark, to give this project its own."
            : "Shown while a thread or new thread in this project is open, on this device."}
      </p>
      <ThemeLibrary
        appearanceMode={appearanceMode}
        customThemes={customThemes}
        initialAppearance={resolvedTheme}
        isImportOpen={isImportOpen}
        onImportOpenChange={setIsImportOpen}
        readThemeHalvesRaw={() => {
          const stored = useUiStateStore.getState().projectThemeByKey[projectKey];
          if (!stored) return readThemeHalvesRaw();
          return {
            ...(stored.light === undefined ? {} : { light: stored.light }),
            ...(stored.dark === undefined ? {} : { dark: stored.dark }),
          };
        }}
        refreshTheme={refreshTheme}
        scope="project"
        setAppearanceMode={setAppearanceMode}
        setTheme={(next) => {
          setProjectBaseTheme(projectKey, next);
          return true;
        }}
        setThemeHalf={(appearance, themeId) => {
          setProjectThemeHalf(projectKey, appearance, themeId);
          return true;
        }}
        theme={projectTheme?.theme ?? appTheme}
        themeHalves={projectTheme === null ? appThemeHalves : pruneThemeHalves(projectTheme)}
      />
    </SettingsSection>
  );
}
