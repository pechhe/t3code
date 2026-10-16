import { useProjectTheme } from "../../hooks/useProjectTheme";
import { useThemeCards } from "../../hooks/useThemeCards";
import { getThemeDefinition } from "../../themePalette";
import { useUiStateStore } from "../../uiStateStore";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { ThemePreviewCircle } from "./ThemePreviewCircles";

const APP_THEME_VALUE = "app";
// The standard look as a project theme: no palette, the user's appearance mode.
const STANDARD_THEME_PREFERENCE = "system";

/** The theme painted while a thread or draft of this project is open, on this device. */
export function ProjectThemeSetting({ projectKey }: { projectKey: string }) {
  const projectTheme = useProjectTheme(projectKey);
  const setProjectTheme = useUiStateStore((store) => store.setProjectTheme);
  const themeCards = useThemeCards();
  const value =
    projectTheme === null
      ? APP_THEME_VALUE
      : projectTheme === STANDARD_THEME_PREFERENCE
        ? projectTheme
        : (getThemeDefinition(projectTheme)?.id ?? projectTheme);
  const labelOf = (selected: string) =>
    selected === APP_THEME_VALUE
      ? "App theme"
      : (themeCards.find((card) => (card.id ?? STANDARD_THEME_PREFERENCE) === selected)?.label ??
        "Unavailable theme");

  return (
    <SettingsRow
      title="Theme"
      description="Shown while a thread or new thread in this project is open, on this device."
      resetAction={
        projectTheme !== null ? (
          <SettingResetButton
            label="project theme"
            onClick={() => setProjectTheme(projectKey, null)}
          />
        ) : null
      }
      control={
        <Select
          value={value}
          onValueChange={(next) => {
            if (typeof next === "string") {
              setProjectTheme(projectKey, next === APP_THEME_VALUE ? null : next);
            }
          }}
        >
          <SelectTrigger size="sm" aria-label="Project theme">
            <SelectValue>{(selected: string) => labelOf(selected)}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value={APP_THEME_VALUE}>App theme</SelectItem>
            {themeCards.map((card) => (
              <SelectItem key={card.id ?? "standard"} value={card.id ?? STANDARD_THEME_PREFERENCE}>
                <span className="flex items-center gap-2">
                  <span className="flex items-center gap-1" aria-hidden>
                    {card.previews.map((preview) => (
                      <ThemePreviewCircle
                        key={preview.mode}
                        colors={preview.colors}
                        mode={preview.mode}
                        className="size-3 border-0"
                      />
                    ))}
                  </span>
                  {card.label}
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
