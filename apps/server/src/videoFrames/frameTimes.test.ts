import { expect, it } from "@effect/vitest";

import { pickFrameTimes } from "./frameTimes.ts";

const times = (input: Parameters<typeof pickFrameTimes>[0]) =>
  pickFrameTimes(input).map((frame) => frame.timestampMs);

it("spaces frames evenly when nothing changed", () => {
  expect(times({ startMs: 0, endMs: 3000, count: 4, changesMs: [] })).toEqual([
    0, 1000, 2000, 3000,
  ]);
});

it("keeps both edges of a short event that falls between even frames", () => {
  const picked = pickFrameTimes({
    startMs: 0,
    endMs: 8000,
    count: 12,
    changesMs: [2000, 2233, 5000, 5066],
  });
  expect(picked).toHaveLength(12);
  expect(picked.filter((frame) => frame.changed).map((frame) => frame.timestampMs)).toEqual([
    2000, 2233, 5000, 5066,
  ]);
  expect(picked[0]!.timestampMs).toBe(0);
  expect(picked.at(-1)!.timestampMs).toBe(8000);
});

it("prefers the larger bursts when there are more changes than slots", () => {
  const scroll = Array.from({ length: 20 }, (_, i) => 4000 + i * 30);
  const picked = pickFrameTimes({
    startMs: 0,
    endMs: 10_000,
    count: 4,
    changesMs: [1000, ...scroll, 8000],
  });
  expect(picked).toHaveLength(4);
  expect(picked.filter((frame) => frame.changed).map((frame) => frame.timestampMs)).toEqual([
    4000, 4570,
  ]);
});

it("ignores changes outside the requested range", () => {
  expect(times({ startMs: 1000, endMs: 2000, count: 3, changesMs: [500, 2500] })).toEqual([
    1000, 1500, 2000,
  ]);
});

it("always returns the requested count, even for an empty range", () => {
  expect(times({ startMs: 500, endMs: 500, count: 5, changesMs: [500] })).toHaveLength(5);
});
