import { describe, expect, it } from "vite-plus/test";

import { screenRecordingIndicatorBounds } from "./ScreenRecordingIndicator.ts";

describe("screen recording indicator placement", () => {
  it("wraps the notch with a wing either side", () => {
    const bounds = screenRecordingIndicatorBounds(
      { bounds: { x: 0, y: 0, width: 1800, height: 1169 } },
      { x: 0, y: 0, width: 1800, notchLeft: 790, notchRight: 1010, notchHeight: 38 },
    );
    expect(bounds.gap).toBe(220);
    expect(bounds.height).toBe(38);
    expect(bounds.y).toBe(0);
    expect(bounds.x + bounds.left).toBe(790);
    expect(bounds.x + bounds.left + bounds.gap).toBe(1010);
  });

  it("hangs from the top centre of a screen without a notch", () => {
    const bounds = screenRecordingIndicatorBounds(
      { bounds: { x: 1800, y: -200, width: 2560, height: 1440 } },
      undefined,
    );
    expect(bounds.y).toBe(-200);
    expect(bounds.x + bounds.width / 2).toBe(1800 + 2560 / 2);
  });
});
