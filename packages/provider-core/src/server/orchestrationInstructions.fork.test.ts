import { assert, describe, it } from "@effect/vitest";

import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "./orchestrationInstructions.ts";

describe("T3 orchestration provider instructions", () => {
  it("distinguishes delegated subagents from ordinary top-level threads", () => {
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "choose by notes, effort, availability");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "not pool order");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "call `agent_roles`");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "multi-model roles require a choice");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "ordinary top-level T3 conversations");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Never use it merely");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "cross-provider");
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "Send each later review round to the same reviewer",
    );
    assert.include(
      T3_CODE_ORCHESTRATION_INSTRUCTIONS,
      "Do not use `t3_thread_send` on `childThreadId`",
    );
  });
});
