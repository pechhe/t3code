import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { buildCodexAdditionalContext } from "./CodexDeveloperInstructions.ts";

describe("Codex orchestration context", () => {
  it("delegates by role with delegate_task and names no native subagent path", () => {
    const orchestration = Object.entries(buildCodexAdditionalContext({ model: "gpt-6.1-sol" }))
      .filter(([key]) => key.startsWith("t3_code_orchestration_"))
      .map(([, entry]) => entry.value)
      .join("\n");

    NodeAssert.ok(orchestration.includes("call `agent_roles`"));
    NodeAssert.ok(orchestration.includes("then `delegate_task` with `agentTask`"));
    NodeAssert.ok(orchestration.includes("Honour user-named models"));
    NodeAssert.ok(!orchestration.includes("use your native tool"));
    NodeAssert.ok(!orchestration.includes("run_in_background:false"));
    NodeAssert.ok(orchestration.includes("Send each later review round to the same reviewer"));
    NodeAssert.ok(
      orchestration.includes(
        "Do not use `t3_thread_send` on `childThreadId` to continue a delegated review.",
      ),
    );
    NodeAssert.ok(!orchestration.includes("inheritedOptions"));
    NodeAssert.ok(!orchestration.includes("Prefer native"));
    // The ACP terminal fallback is ACP-only; Codex agents never need it.
    NodeAssert.ok(!orchestration.includes("acp-mcp-call"));
  });
});
