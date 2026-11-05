import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { applyAppearanceFontVariables } from "./appearanceFonts";

function renderedFontSize(style: (probe: HTMLElement) => void): string {
  const probe = document.createElement("div");
  style(probe);
  document.body.append(probe);
  try {
    return getComputedStyle(probe).fontSize;
  } finally {
    probe.remove();
  }
}

const composerFontSize = () =>
  renderedFontSize((probe) => {
    // The composer editor's own size class.
    probe.className = "text-(length:--font-size-prompt,var(--text-sm))";
  });

const touchComposerFontSize = () =>
  renderedFontSize((probe) => {
    probe.style.fontSize = "var(--font-size-prompt-touch)";
  });

describe("applyAppearanceFontVariables", () => {
  it("sizes the composer from the interface size until fonts are set separately", () => {
    const root = document.documentElement;
    const style = root.getAttribute("style");
    const preferences = {
      sans: "",
      code: "",
      composer: "",
      response: "",
      sizeInterface: 20,
      sizePrompt: 14,
      sizeCode: 13,
      smoothing: true,
    };
    try {
      applyAppearanceFontVariables(root, { ...preferences, separate: false });
      expect(composerFontSize()).toBe("17.5px");
      expect(touchComposerFontSize()).toBe("17.5px");

      applyAppearanceFontVariables(root, { ...preferences, separate: true });
      expect(composerFontSize()).toBe("14px");
      // iOS zooms into inputs under 16px.
      expect(touchComposerFontSize()).toBe("16px");
    } finally {
      if (style === null) root.removeAttribute("style");
      else root.setAttribute("style", style);
    }
  });
});

describe("theme typeface", () => {
  const root = document.documentElement;
  const preferences = {
    sans: "Papyrus",
    code: "",
    composer: "Papyrus",
    response: "",
    sizeInterface: 16,
    sizePrompt: 14,
    sizeCode: 13,
    smoothing: true,
    separate: true,
  };
  const face = (variable: string) => getComputedStyle(root).getPropertyValue(variable);

  it("outranks the custom interface and prompt fonts only while the setting is on", () => {
    const style = root.getAttribute("style");
    try {
      applyAppearanceFontVariables(root, preferences);
      root.dataset.themeFont = "serif";
      expect(face("--font-sans")).toContain("Papyrus");

      root.dataset.themeTypeface = "";
      expect(face("--font-sans")).toContain("Charter");
      expect(face("--font-composer")).toContain("Charter");
      expect(face("--font-response")).not.toContain("Charter");
    } finally {
      delete root.dataset.themeFont;
      delete root.dataset.themeTypeface;
      if (style === null) root.removeAttribute("style");
      else root.setAttribute("style", style);
    }
  });
});
