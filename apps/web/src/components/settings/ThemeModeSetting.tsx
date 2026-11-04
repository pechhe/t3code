import { ArrowDownIcon, ArrowUpIcon, StarIcon, XIcon } from "lucide-react";

import { useTheme } from "../../hooks/useTheme";
import { getThemeDefinition } from "../../themePalette";
import { STANDARD_ROTATION_THEME, type ThemeMode } from "../../themeRotation";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const THEME_MODE_LABELS: Record<ThemeMode, string> = {
  single: "One theme",
  project: "Per-project themes",
  rotation: "Daily rotation",
};

const THEME_MODE_DESCRIPTIONS: Record<ThemeMode, string> = {
  single: "Every project looks the same, in the theme you pick below.",
  project: "Each project can have its own theme, shown while its threads are open.",
  rotation: "A different favourite each day. Pick a theme below to keep it for today only.",
};

export function themeRotationLabel(themeId: string): string {
  if (themeId === STANDARD_ROTATION_THEME) return "T3 Code";
  return getThemeDefinition(themeId)?.label ?? themeId;
}

function RotationPlan() {
  const {
    rotation,
    rotationToday,
    setRotationOverride,
    setRotationFavourite,
    moveRotationFavourite,
  } = useTheme();
  const { favourites } = rotation;

  return (
    <div className="space-y-3 px-3 pb-3 sm:px-4" data-theme-rotation-panel>
      {favourites.length === 0 && rotationToday.theme === null ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          Star themes below to start the rotation.
          <StarIcon className="size-3" />
        </p>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <div className="min-w-0">
            <span className="text-muted-foreground">Today </span>
            <span className="font-medium text-foreground">
              {rotationToday.theme === null
                ? "Your theme"
                : themeRotationLabel(rotationToday.theme)}
            </span>
            {rotationToday.overridden ? (
              <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                chosen for today
              </span>
            ) : null}
            {rotationToday.next !== null ? (
              <span className="ml-3 text-xs text-muted-foreground">
                Tomorrow {themeRotationLabel(rotationToday.next)}
              </span>
            ) : null}
          </div>
          {rotationToday.overridden ? (
            <Button size="xs" variant="outline" onClick={() => setRotationOverride(null)}>
              Back to rotation
            </Button>
          ) : null}
        </div>
      )}
      {favourites.length > 0 ? (
        <ol
          aria-label="Rotation order"
          className="divide-y divide-border/60 rounded-lg border border-border/70"
        >
          {favourites.map((themeId, index) => (
            <li className="flex items-center gap-2 px-3 py-1.5 text-sm" key={themeId}>
              <span className="w-5 text-xs tabular-nums text-muted-foreground">{index + 1}</span>
              <span className="min-w-0 flex-1 truncate">{themeRotationLabel(themeId)}</span>
              <Button
                aria-label={`Move ${themeRotationLabel(themeId)} earlier`}
                disabled={index === 0}
                size="icon-xs"
                variant="ghost"
                onClick={() => moveRotationFavourite(themeId, -1)}
              >
                <ArrowUpIcon />
              </Button>
              <Button
                aria-label={`Move ${themeRotationLabel(themeId)} later`}
                disabled={index === favourites.length - 1}
                size="icon-xs"
                variant="ghost"
                onClick={() => moveRotationFavourite(themeId, 1)}
              >
                <ArrowDownIcon />
              </Button>
              <Button
                aria-label={`Remove ${themeRotationLabel(themeId)} from the rotation`}
                size="icon-xs"
                variant="ghost"
                onClick={() => setRotationFavourite(themeId, false)}
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

/** Chooses how this device picks its theme: one theme, one per project, or a favourite each day. */
export function ThemeModeSetting() {
  const { themeMode, setThemeMode } = useTheme();
  return (
    <div>
      <SettingsRow
        {...searchableSetting("theme-mode")}
        description={THEME_MODE_DESCRIPTIONS[themeMode]}
        control={
          <Select
            value={themeMode}
            onValueChange={(value) => {
              if (value === "single" || value === "project" || value === "rotation") {
                setThemeMode(value);
              }
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-48" aria-label="Theme mode">
              <SelectValue>{THEME_MODE_LABELS[themeMode]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(["single", "project", "rotation"] as const).map((value) => (
                <SelectItem hideIndicator key={value} value={value}>
                  {THEME_MODE_LABELS[value]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      {themeMode === "rotation" ? <RotationPlan /> : null}
    </div>
  );
}
