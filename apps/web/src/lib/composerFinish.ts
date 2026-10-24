/**
 * Composer finishes: the device composer's metal and screen, chosen apart from
 * the app theme (Settings → Appearance → Composer finish). The named finishes
 * are peach-pi's saved themes, reduced to the parts the composer wears.
 *
 * A finish is applied on <html>: `data-composer-chassis` forces the silver or
 * anodized body (absent, the chassis follows the theme), and the colour
 * variables below are read by `deviceComposer.css`. Under "Match theme" the
 * theme's own device colours, if it has any, fill the same variables.
 */
import { useEffect } from "react";

import { useClientSettings } from "~/hooks/useSettings";

export interface ComposerFinish {
  id: string;
  label: string;
  /** Absent: silver in light themes, anodized black in dark ones. */
  chassis?: "light" | "dark";
  /** Pigment mixed into the metal. */
  metal?: string;
  /** Screen background and ink; absent, the screen follows the app theme. */
  screen?: string;
  screenText?: string;
}

const DEFAULT_COMPOSER_FINISH_ID = "auto";

export const COMPOSER_FINISHES: ReadonlyArray<ComposerFinish> = [
  { id: DEFAULT_COMPOSER_FINISH_ID, label: "Match theme" },
  { id: "silver", label: "Silver", chassis: "light" },
  { id: "anodized", label: "Anodized black", chassis: "dark" },
  { id: "vampire", label: "Vampire", chassis: "dark", metal: "#360202", screen: "#1e1515" },
  {
    id: "cyber",
    label: "Cyber",
    chassis: "dark",
    metal: "#121712",
    screen: "#000000",
    screenText: "#05eb14",
  },
  {
    id: "ghost",
    label: "Ghost",
    chassis: "light",
    metal: "#181b18",
    screen: "#000000",
    screenText: "#00a30b",
  },
  {
    id: "dawnfox",
    label: "Dawnfox",
    chassis: "light",
    metal: "#e8e0e8",
    screen: "#f2e9f1",
    screenText: "#575279",
  },
  {
    id: "dayfox",
    label: "Dayfox",
    chassis: "light",
    metal: "#e8e8e8",
    screen: "#ebebeb",
    screenText: "#352c24",
  },
  {
    id: "nord-light",
    label: "Nord Light",
    chassis: "light",
    metal: "#d8dee9",
    screen: "#e5e9f0",
    screenText: "#2e3440",
  },
];

/** How strongly a finish's pigment tints the metal, as in peach-pi. */
const METAL_TINT_AMOUNT = "40%";

const FINISH_VARIABLES = {
  metal: "--metal-dye",
  screen: "--device-screen",
  screenText: "--device-screen-text",
} as const;

export function resolveComposerFinish(id: string): ComposerFinish {
  return COMPOSER_FINISHES.find((finish) => finish.id === id) ?? COMPOSER_FINISHES[0]!;
}

function applyComposerFinish(finish: ComposerFinish): void {
  const root = document.documentElement;
  // "Match theme" lets the theme's own device colours through (deviceComposer.css).
  root.dataset.composerFinish = finish.id;
  if (finish.chassis) root.dataset.composerChassis = finish.chassis;
  else delete root.dataset.composerChassis;
  for (const [key, variable] of Object.entries(FINISH_VARIABLES)) {
    const value = finish[key as keyof typeof FINISH_VARIABLES];
    if (value) root.style.setProperty(variable, value);
    else root.style.removeProperty(variable);
  }
  if (finish.metal) root.style.setProperty("--metal-tint-amount", METAL_TINT_AMOUNT);
  else root.style.removeProperty("--metal-tint-amount");
}

/** Keeps <html> wearing the chosen finish. Mount once, at the app root. */
export function useComposerFinishSync(): void {
  const finishId = useClientSettings((settings) => settings.composerFinish);
  useEffect(() => {
    applyComposerFinish(resolveComposerFinish(finishId));
  }, [finishId]);
}
