import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  OrchestratorMcpScheduleTaskInput,
  OrchestratorMcpScheduledTask,
  OrchestratorMcpUpdateScheduledTaskInput,
} from "./orchestratorMcp.ts";
import { OrchestratorMcpAskAdviceInput } from "./orchestratorMcpDelegation.ts";

const decodeScheduleTaskInput = Schema.decodeSync(OrchestratorMcpScheduleTaskInput);
const decodeScheduleTaskInputLoose = Schema.decodeUnknownSync(OrchestratorMcpScheduleTaskInput);
const decodeScheduledTask = Schema.decodeSync(OrchestratorMcpScheduledTask);
const decodeUpdateScheduledTaskInput = Schema.decodeSync(OrchestratorMcpUpdateScheduledTaskInput);

describe("orchestrator MCP contracts", () => {
  it("accepts a concise parent question without fabricating evidence or a recommendation", () => {
    const decode = Schema.decodeUnknownSync(OrchestratorMcpAskAdviceInput);
    expect(
      decode({ action: "ask", clientRequestId: "contract", question: "Which contract?" }),
    ).toMatchObject({
      evidence: "Not supplied separately.",
      recommendation: "No recommendation supplied.",
      blocking: true,
    });
    expect(
      decode({
        action: "ask",
        clientRequestId: "contract",
        question: "Which contract?",
        evidence: "Read both callers.",
        recommendation: "Keep v1.",
        blocking: false,
      }),
    ).toMatchObject({
      evidence: "Read both callers.",
      recommendation: "Keep v1.",
      blocking: false,
    });
    // A thread with no checkout, such as one in No project, has no revision to pin.
    expect(
      decode({
        action: "ask",
        destination: "advisor",
        clientRequestId: "contract",
        question: "Which design?",
      }),
    ).toMatchObject({ destination: "advisor" });
  });
});

describe("scheduled task MCP contracts", () => {
  const schedule = { type: "interval" as const, everyMs: 3_600_000 };

  it("names a subagent role instead of a model", () => {
    const created = decodeScheduleTaskInput({
      prompt: "Check for issues.",
      schedule,
      purpose: "long_running",
      agentRole: "implementer",
    });
    expect(created.agentRole).toBe("implementer");
    // A caller still naming a retired writing role gets the implementer.
    expect(
      decodeScheduleTaskInput({
        prompt: "Check.",
        schedule,
        purpose: "check_back",
        agentRole: "chore-worker",
      }).agentRole,
    ).toBe("implementer");
    // Omitted leaves the choice to the server, which names its default role.
    expect(
      decodeScheduleTaskInput({ prompt: "Check.", schedule, purpose: "check_back" }).agentRole,
    ).toBeUndefined();
    expect(() =>
      decodeScheduleTaskInputLoose({
        prompt: "Check.",
        schedule,
        purpose: "check_back",
        agentRole: "not-a-role",
      }),
    ).toThrow();
  });

  it("accepts an explicit model on create and update without a role", () => {
    const modelSelection = {
      instanceId: "claudeAgent",
      model: "claude-opus-4-6",
      options: [{ id: "effort", value: "high" }],
    };
    expect(
      decodeScheduleTaskInputLoose({
        prompt: "Review.",
        schedule,
        purpose: "long_running",
        modelSelection,
      }).modelSelection,
    ).toEqual(modelSelection);
    expect(
      decodeUpdateScheduledTaskInput({
        scheduledTaskId: "scheduled-task:1",
        modelSelection,
      }).modelSelection,
    ).toEqual(modelSelection);
    expect(() =>
      decodeScheduleTaskInputLoose({
        prompt: "Review.",
        schedule,
        purpose: "long_running",
        modelSelection: { model: "" },
      }),
    ).toThrow();
  });

  it("makes a new task say why it exists, and an update leave that alone", () => {
    expect(() => decodeScheduleTaskInputLoose({ prompt: "Check.", schedule })).toThrow();
    expect(
      decodeUpdateScheduledTaskInput({ scheduledTaskId: "scheduled-task:1" }).purpose,
    ).toBeUndefined();
  });

  it("moves an existing task to another role and reports it back", () => {
    const update = decodeUpdateScheduledTaskInput({
      scheduledTaskId: "scheduled-task:1",
      agentRole: "reviewer",
    });
    expect(update.agentRole).toBe("reviewer");
    const summary = decodeScheduledTask({
      scheduledTaskId: "scheduled-task:1",
      title: "Review",
      prompt: "Review the Spec.",
      enabled: true,
      projectId: "project:1",
      boundThreadId: null,
      agentRole: "reviewer",
      freshSession: false,
      purpose: "check_back",
      schedule,
      nextRunAt: null,
      lastRunStatus: "never",
    });
    expect(summary.agentRole).toBe("reviewer");
    // A legacy task saved before roles still decodes.
    expect(
      decodeScheduledTask({
        scheduledTaskId: "scheduled-task:2",
        title: "Legacy",
        prompt: "Old task.",
        enabled: true,
        projectId: "project:1",
        boundThreadId: null,
        agentRole: null,
        freshSession: false,
        purpose: "long_running",
        schedule,
        nextRunAt: null,
        lastRunStatus: "never",
      }).agentRole,
    ).toBeNull();
  });
});
