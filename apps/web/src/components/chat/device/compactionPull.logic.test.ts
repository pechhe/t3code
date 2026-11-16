import { describe, expect, it } from "vite-plus/test";

import { advanceCompactionPull, type CompactionPullState } from "./compactionPull.logic";

const run = (steps: ReadonlyArray<readonly [thread: string, used: number, count: number]>) => {
  let state: CompactionPullState | null = null;
  return steps.map(([threadKey, usedTokens, compactionCount]) => {
    const next = advanceCompactionPull(state, { threadKey, usedTokens, compactionCount });
    state = next.state;
    return next.pull;
  });
};

describe("advanceCompactionPull", () => {
  const pull = { fromTokens: 400, toTokens: 120 };
  it.each([
    {
      name: "plays when the compaction is reported before the fall",
      steps: [
        ["a", 400, 0],
        ["a", 400, 1],
        ["a", 120, 1],
      ] as const,
      pulls: [null, null, pull],
    },
    {
      name: "plays when the fall is reported before the compaction",
      steps: [
        ["a", 400, 0],
        ["a", 120, 0],
        ["a", 120, 1],
      ] as const,
      pulls: [null, null, pull],
    },
    {
      name: "plays once for a fall that arrives in two steps",
      steps: [
        ["a", 400, 0],
        ["a", 200, 0],
        ["a", 120, 1],
        ["a", 120, 1],
      ] as const,
      pulls: [null, null, pull, null],
    },
    {
      name: "stays still when context falls without a compaction",
      steps: [
        ["a", 400, 3],
        ["a", 120, 3],
      ] as const,
      pulls: [null, null],
    },
    {
      name: "stays still when another thread opens with less context and more compactions",
      steps: [
        ["a", 400, 0],
        ["b", 120, 4],
      ] as const,
      pulls: [null, null],
    },
    {
      name: "forgets a fall once context has grown again",
      steps: [
        ["a", 400, 0],
        ["a", 120, 0],
        ["a", 150, 0],
        ["a", 150, 1],
      ] as const,
      pulls: [null, null, null, null],
    },
  ])("$name", ({ steps, pulls }) => {
    expect(run(steps)).toEqual(pulls);
  });
});
