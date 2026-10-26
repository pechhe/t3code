import { describe, expect, it } from "vite-plus/test";

import type { MaterialYouPalette } from "./materialYouPalette";
import { materialYouPaletteToMobileThemeVariables } from "./materialYouTheme.android";
import { DEFAULT_MOBILE_THEME_ID, getMobileThemeVariables } from "./mobileTheme";

const palette: MaterialYouPalette = {
  primary: "#6750A4FF",
  onPrimary: "#FFFFFFFF",
  primaryContainer: "#EADDFFFF",
  onPrimaryContainer: "#21005DFF",
  inversePrimary: "#D0BCFFFF",
  secondaryContainer: "#E8DEF8FF",
  onSecondaryContainer: "#1D192BFF",
  tertiary: "#7D5260FF",
  tertiaryContainer: "#FFD8E4FF",
  onTertiaryContainer: "#31111DFF",
  surface: "#FFFBFEFF",
  onSurface: "#1C1B1FFF",
  onSurfaceVariant: "#49454FFF",
  surfaceContainer: "#F3EDF7FF",
  surfaceContainerHigh: "#ECE6F0FF",
  surfaceContainerHighest: "#E6E0E9FF",
  surfaceContainerLow: "#F7F2FAFF",
  surfaceContainerLowest: "#FFFFFFFF",
  errorContainer: "#F9DEDCFF",
  onErrorContainer: "#410E0BFF",
  outline: "#79747EFF",
  outlineVariant: "#CAC4D0FF",
  scrim: "#000000FF",
};

describe("Material You theme conversion", () => {
  it.each(["light", "dark"] as const)(
    "keeps Markdown text legible in %s appearance",
    (appearance) => {
      const base = getMobileThemeVariables(DEFAULT_MOBILE_THEME_ID, appearance);
      const variables = materialYouPaletteToMobileThemeVariables(palette, appearance, base);
      const text = variables["--color-md-body"];
      expect(text).toMatch(/^#[\dA-F]{8}$/);
      const channels = [1, 3, 5].map((offset) =>
        Number.parseInt(text.slice(offset, offset + 2), 16),
      );
      if (appearance === "light") expect(Math.max(...channels)).toBeLessThan(100);
      else expect(Math.min(...channels)).toBeGreaterThan(200);
      expect(variables["--color-md-strong"]).toBe(text);
      expect(variables["--color-md-link"]).toBe(palette.primary);
    },
  );
});
