import { describe, expect, it } from "vite-plus/test";

import golden from "./golden/compile.golden.json" with { type: "json" };
import { compile, renderSummary } from "./index.ts";
import type { Message } from "./shims/pi-ai.ts";
import type { Observation, Reflection } from "./upstream/om/ledger/types.ts";

// compile.golden.json holds pi-blackhole 0.5.19's own output (run with Pi's real pi-tui) for the
// transcript stored beside it, so these rows fail if T3's copy drifts from upstream.
describe("Blackhole compaction matches pi-blackhole", () => {
  const first = golden.first as Message[];
  const second = golden.second as Message[];

  it("compiles a first compaction identically", () => {
    expect(compile({ messages: first, cwd: golden.cwd })).toBe(golden.expected.firstSummary);
  });

  it("merges a later compaction into the previous summary identically", () => {
    expect(
      compile({
        messages: second,
        previousSummary: golden.expected.firstSummary,
        cwd: golden.cwd,
        sourceIndices: golden.sourceIndices,
      }),
    ).toBe(golden.expected.merged);
  });

  it("renders observational memory identically", () => {
    expect(
      renderSummary(golden.reflections as Reflection[], golden.observations as Observation[]),
    ).toBe(golden.expected.memory);
  });
});
