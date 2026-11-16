import { describe, expect, it } from "vite-plus/test";

import { advanceCompactionPull, type CompactionPullState } from "./compactionPull.logic";

const run = (steps: ReadonlyArray<readonly [used: number, count: number]>) => {
  let state: CompactionPullState | null = null;
  return steps.map(([usedTokens, compactionCount]) => {
    const next = advanceCompactionPull(state, { usedTokens, compactionCount });
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
        [400, 0],
        [400, 1],
        [120, 1],
      ] as const,
      pulls: [null, null, pull],
    },
    {
      name: "plays when the fall is reported before the compaction",
      steps: [
        [400, 0],
        [120, 0],
        [120, 1],
      ] as const,
      pulls: [null, null, pull],
    },
    {
      name: "plays once for a fall that arrives in two steps",
      steps: [
        [400, 0],
        [200, 0],
        [120, 1],
        [120, 1],
      ] as const,
      pulls: [null, null, pull, null],
    },
    {
      name: "stays still when context falls without a compaction",
      steps: [
        [400, 3],
        [120, 3],
      ] as const,
      pulls: [null, null],
    },
    {
      name: "plays on return when the thread compacted and grew again unseen",
      steps: [
        [400, 0],
        [150, 2],
      ] as const,
      pulls: [null, { fromTokens: 400, toTokens: 150 }],
    },
    {
      name: "forgets a fall once context has grown again",
      steps: [
        [400, 0],
        [120, 0],
        [150, 0],
        [150, 1],
      ] as const,
      pulls: [null, null, null, null],
    },
  ])("$name", ({ steps, pulls }) => {
    expect(run(steps)).toEqual(pulls);
  });
});
