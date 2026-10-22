import { describe, expect, it } from "vite-plus/test";

import { markSelectionCoveredChips } from "./selectionActions";

// A chip the browser draws with its own surface, as ContextChip does.
function chip(label: string): HTMLSpanElement {
  const element = document.createElement("span");
  element.dataset.slot = "context-chip";
  element.textContent = label;
  return element;
}

function setup() {
  const viewport = document.createElement("div");
  const first = chip("first-chip");
  const second = chip("second-chip");
  const wrap = document.createElement("p");
  wrap.append(first, " beta ", second);
  viewport.append("Alpha ", wrap, " gamma");
  // A selection only exists in the document, so the viewport has to be mounted.
  document.body.append(viewport);
  return { viewport, first, second };
}

function teardown(viewport: HTMLElement) {
  window.getSelection()?.removeAllRanges();
  viewport.remove();
}

function select(range: () => Range): Selection {
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range());
  return selection;
}

function coveredChips(viewport: HTMLElement): HTMLElement[] {
  return [...viewport.querySelectorAll<HTMLElement>("[data-slot='context-chip']")].filter(
    (element) => element.hasAttribute("data-selection-covered"),
  );
}

describe("markSelectionCoveredChips", () => {
  it("marks the chips the selection crosses and clears them when it ends", () => {
    const { viewport, first, second } = setup();
    try {
      const selection = select(() => {
        const range = document.createRange();
        range.setStart(viewport.firstChild!, 0);
        range.setEnd(second.firstChild!, "second-chip".length);
        return range;
      });

      markSelectionCoveredChips(viewport, selection);
      expect(coveredChips(viewport)).toEqual([first, second]);

      selection.removeAllRanges();
      markSelectionCoveredChips(viewport, selection);
      expect(coveredChips(viewport)).toEqual([]);
    } finally {
      teardown(viewport);
    }
  });

  it("leaves chips outside the selection alone", () => {
    const { viewport, first, second } = setup();
    try {
      const selection = select(() => {
        const range = document.createRange();
        range.setStart(viewport.firstChild!, 0);
        range.setEnd(first.firstChild!, "first-chip".length);
        return range;
      });

      markSelectionCoveredChips(viewport, selection);
      expect(coveredChips(viewport)).toEqual([first]);
      expect(second.hasAttribute("data-selection-covered")).toBe(false);
    } finally {
      teardown(viewport);
    }
  });

  it("clears a stale mark for a selection made outside the viewport", () => {
    const { viewport, first } = setup();
    const outside = document.createElement("p");
    outside.textContent = "elsewhere";
    document.body.append(outside);
    try {
      first.setAttribute("data-selection-covered", "");
      const selection = select(() => {
        const range = document.createRange();
        range.selectNodeContents(outside);
        return range;
      });

      markSelectionCoveredChips(viewport, selection);
      expect(first.hasAttribute("data-selection-covered")).toBe(false);
    } finally {
      outside.remove();
      teardown(viewport);
    }
  });
});
