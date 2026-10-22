import { describe, expect, it } from "vite-plus/test";

import { resolveSelectionActionPlacement } from "./selectionActions";

const selection = { left: 300, top: 400, bottom: 420 };
const size = { width: 160, height: 24 };
const viewport = { width: 1000, height: 800 };

describe("resolveSelectionActionPlacement", () => {
  it("sits above the selected text, clear of it", () => {
    expect(resolveSelectionActionPlacement({ selection, size, viewport })).toEqual({
      x: 300,
      y: 370,
    });
  });

  it("sits below the text when there is no room above", () => {
    expect(
      resolveSelectionActionPlacement({
        selection: { ...selection, top: 10, bottom: 30 },
        size,
        viewport,
      }),
    ).toEqual({ x: 300, y: 36 });
  });

  it("goes below a selection that starts above the viewport", () => {
    // A long selection scrolled so its first lines are out of view: the visible
    // bounds start at the viewport edge, leaving no room above them.
    expect(
      resolveSelectionActionPlacement({
        selection: { ...selection, top: 8, bottom: 500 },
        size,
        viewport,
      }).y,
    ).toBe(506);
  });

  it("falls back to the bottom edge when the selection fills the viewport", () => {
    expect(
      resolveSelectionActionPlacement({
        selection: { left: 0, top: 0, bottom: 800 },
        size,
        viewport,
      }).y,
    ).toBe(768);
  });

  it("stays inside the viewport at a side edge", () => {
    expect(
      resolveSelectionActionPlacement({
        selection: { ...selection, left: 960 },
        size,
        viewport,
      }).x,
    ).toBe(832);
  });
});
