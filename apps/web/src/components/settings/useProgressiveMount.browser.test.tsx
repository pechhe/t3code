import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { useProgressiveMount } from "./useProgressiveMount";

let frames = new Map<number, () => void>();
let nextFrame = 1;
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  frames = new Map();
  nextFrame = 1;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => {
    frames.set(nextFrame, callback);
    return nextFrame++;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function nextPaint() {
  const pending = [...frames.values()];
  frames.clear();
  await act(async () => pending.forEach((callback) => callback()));
}

async function setup(initial: readonly string[]) {
  let mounted: readonly string[] = [];
  function Probe({ wanted }: { wanted: readonly string[] }) {
    mounted = useProgressiveMount(wanted);
    return null;
  }
  await act(async () => root.render(<Probe wanted={initial} />));
  return {
    mounted: () => mounted,
    update: (wanted: readonly string[]) => act(async () => root.render(<Probe wanted={wanted} />)),
  };
}

it("mounts nothing in the first commit, then one entry per frame in order", async () => {
  const view = await setup(["a", "b", "c"]);
  expect(view.mounted()).toEqual([]);
  await nextPaint();
  expect(view.mounted()).toEqual(["a"]);
  await nextPaint();
  await nextPaint();
  expect(view.mounted()).toEqual(["a", "b", "c"]);
  expect(frames.size).toBe(0);
});

it("keeps entries that stay wanted and mounts only the new ones as the list changes", async () => {
  const view = await setup(["a", "b"]);
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
