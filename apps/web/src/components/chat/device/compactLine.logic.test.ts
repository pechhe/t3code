import { describe, expect, it } from "vite-plus/test";

import {
  compactAtFromPointer,
  isDoubleTap,
  nudgeCompactAt,
  resolveCompactLine,
} from "./compactLine.logic";

const bounds = { min: 67_000, max: 967_000 };

describe("resolveCompactLine", () => {
  const claudeBounds = { min: 67_000, max: 167_000 };

  it("follows the provider when the thread has no point of its own", () => {
    expect(
      resolveCompactLine({
        threadCompactAt: null,
        appliedThreshold: 136_000,
        bounds: claudeBounds,
      }),
    ).toEqual({ position: 136_000, pending: false, unreported: false });
  });

  it("offers an unreported line at the top of the range when the provider reports no point", () => {
    expect(
      resolveCompactLine({ threadCompactAt: null, appliedThreshold: undefined, bounds }),
    ).toEqual({ position: bounds.max, pending: false, unreported: true });
  });

  it("shows nothing when neither a point nor the range is known", () => {
    expect(
      resolveCompactLine({ threadCompactAt: undefined, appliedThreshold: undefined, bounds: null }),
    ).toEqual({ position: null, pending: false, unreported: false });
  });

  it("is applied once the provider reports the thread's point", () => {
    expect(
      resolveCompactLine({
        threadCompactAt: 150_000,
        appliedThreshold: 150_000,
        bounds: claudeBounds,
      }),
    ).toEqual({ position: 150_000, pending: false, unreported: false });
  });

  it("is pending while the provider still reports another point or none", () => {
    expect(
      resolveCompactLine({
        threadCompactAt: 150_000,
        appliedThreshold: 136_000,
        bounds: claudeBounds,
      }),
    ).toEqual({ position: 150_000, pending: true, unreported: false });
    expect(
      resolveCompactLine({
        threadCompactAt: 150_000,
        appliedThreshold: undefined,
        bounds: claudeBounds,
      }),
    ).toEqual({ position: 150_000, pending: true, unreported: false });
  });

  it("holds a point outside the provider's range to the range, where the provider applies it", () => {
    expect(
      resolveCompactLine({
        threadCompactAt: 190_000,
        appliedThreshold: 167_000,
        bounds: claudeBounds,
      }),
    ).toEqual({ position: 167_000, pending: false, unreported: false });
    expect(
      resolveCompactLine({
        threadCompactAt: 40_000,
        appliedThreshold: 67_000,
        bounds: claudeBounds,
      }),
    ).toEqual({ position: 67_000, pending: false, unreported: false });
  });
});

describe("compactAtFromPointer", () => {
  const base = { trackWidth: 400, maxTokens: 1_000_000, bounds };

  it("maps the pointer across the window, rounded to whole thousands", () => {
    expect(compactAtFromPointer({ ...base, offsetX: 100 })).toBe(250_000);
    expect(compactAtFromPointer({ ...base, offsetX: 123.4 })).toBe(309_000);
  });

  it("stops at the provider's bounds however far the pointer goes", () => {
    expect(compactAtFromPointer({ ...base, offsetX: -50 })).toBe(bounds.min);
    expect(compactAtFromPointer({ ...base, offsetX: 399 })).toBe(bounds.max);
    expect(compactAtFromPointer({ ...base, offsetX: 900 })).toBe(bounds.max);
  });

  it("stays at the lower bound on an unmeasured track", () => {
    expect(compactAtFromPointer({ ...base, trackWidth: 0, offsetX: 10 })).toBe(bounds.min);
  });
});

describe("nudgeCompactAt", () => {
  const base = { maxTokens: 1_000_000, bounds };

  it("steps 1% of the window, or 5% with shift", () => {
    expect(nudgeCompactAt({ ...base, current: 200_000, direction: 1, large: false })).toBe(210_000);
    expect(nudgeCompactAt({ ...base, current: 200_000, direction: -1, large: true })).toBe(150_000);
  });

  it("does not leave the bounds", () => {
    expect(nudgeCompactAt({ ...base, current: 70_000, direction: -1, large: true })).toBe(
      bounds.min,
    );
    expect(nudgeCompactAt({ ...base, current: 965_000, direction: 1, large: true })).toBe(
      bounds.max,
    );
  });
});

describe("isDoubleTap", () => {
  it("needs an earlier tap close enough in time", () => {
    expect(isDoubleTap(null, 1_000)).toBe(false);
    expect(isDoubleTap(800, 1_000)).toBe(true);
    expect(isDoubleTap(500, 1_000)).toBe(false);
  });
});
