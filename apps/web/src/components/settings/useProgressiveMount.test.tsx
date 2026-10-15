import { act } from "react";
import { create } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { useProgressiveMount } from "./useProgressiveMount";

let frames = new Map<number, () => void>();
let nextFrame = 1;

beforeEach(() => {
  frames = new Map();
  nextFrame = 1;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    frames.set(nextFrame, callback);
    return nextFrame++;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});
afterEach(() => vi.unstubAllGlobals());

async function nextPaint() {
  const pending = [...frames.values()];
  frames.clear();
  await act(async () => pending.forEach((callback) => callback()));
}

function setup(initial: readonly string[]) {
  let mounted: readonly string[] = [];
  function Probe({ wanted }: { wanted: readonly string[] }) {
    mounted = useProgressiveMount(wanted);
    return null;
  }
  let renderer!: ReturnType<typeof create>;
  act(() => {
    renderer = create(<Probe wanted={initial} />);
  });
  return {
    mounted: () => mounted,
    update: (wanted: readonly string[]) => act(() => renderer.update(<Probe wanted={wanted} />)),
  };
}

it("mounts nothing in the first commit, then one entry per frame in order", async () => {
  const view = setup(["a", "b", "c"]);
  expect(view.mounted()).toEqual([]);
  await nextPaint();
  expect(view.mounted()).toEqual(["a"]);
  await nextPaint();
  await nextPaint();
  expect(view.mounted()).toEqual(["a", "b", "c"]);
  expect(frames.size).toBe(0);
});

it("keeps entries that stay wanted and mounts only the new ones as the list changes", async () => {
  const view = setup(["a", "b"]);
  await nextPaint();
  await nextPaint();
  expect(view.mounted()).toEqual(["a", "b"]);

  await view.update(["b", "c"]);
  expect(view.mounted()).toEqual(["b"]);
  await nextPaint();
  expect(view.mounted()).toEqual(["b", "c"]);

  await view.update(["c", "b", "a"]);
  expect(view.mounted()).toEqual(["c", "b", "a"]);
});
