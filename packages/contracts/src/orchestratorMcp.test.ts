import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpScheduleTaskInput,
  OrchestratorMcpScheduledTask,
  OrchestratorMcpThreadSearchPage,
  OrchestratorMcpUpdateScheduledTaskInput,
} from "./orchestratorMcp.ts";

const decodeScheduleTaskInput = Schema.decodeSync(OrchestratorMcpScheduleTaskInput);
const decodeScheduleTaskInputLoose = Schema.decodeUnknownSync(OrchestratorMcpScheduleTaskInput);
const decodeScheduledTask = Schema.decodeSync(OrchestratorMcpScheduledTask);
const decodeUpdateScheduledTaskInput = Schema.decodeSync(OrchestratorMcpUpdateScheduledTaskInput);

const decodeDelegateTaskInput = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskInput);
const decodeDelegateTaskResult = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskResult);

describe("orchestrator MCP contracts", () => {
  it("decodes cross-provider delegated task requests and durable results", () => {
    const request = decodeDelegateTaskInput({
      task: "Inspect the workspace and report the result.",
      target: {
        providerInstanceId: "claudeAgent",
        model: "claude-sonnet-4-6",
      },
      mode: "wait",
      timeoutMs: 5_000,
      clientRequestId: "delegate-1",
      runtimeMode: "inherit",
      interactionMode: "inherit",
    });
    const result = decodeDelegateTaskResult({
      taskId: "node-task-1",
      childThreadId: "thread-child-1",
      childRunId: "run-child-1",
      childNodeId: "node-task-1",
      status: "completed",
      workState: "result_available",
      hasPendingChildRuns: false,
      providerInstanceId: "claudeAgent",
      model: "claude-sonnet-4-6",
      summary: "Workspace inspected.",
      resultContextTransferId: "context-transfer-result-1",
      latestTerminalRunId: "run-child-1",
      latestTerminalStatus: "completed",
      latestTerminalSummary: "Workspace inspected.",
      latestTerminalResultContextTransferId: "context-transfer-result-1",
      hasPendingQuestion: false,
      pendingApproval: null,
      waitTimedOut: false,
    });

    expect(request.target?.providerInstanceId).toBe("claudeAgent");
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("Workspace inspected.");
    expect(result.pendingApproval).toBeNull();
    const pendingApproval = {
      requestId: "request-approval-1",
      kind: "command",
      runId: "run-child-1",
    };
    expect(
      decodeDelegateTaskResult({
        ...result,
        pendingApproval: { ...pendingApproval, input: { command: "private command" } },
      }).pendingApproval,
    ).toEqual(pendingApproval);
    expect(() =>
      decodeDelegateTaskResult({
        ...result,
        pendingApproval: { ...pendingApproval, kind: "user_input" },
      }),
    ).toThrow();
  });
});

describe("scheduled task MCP contracts", () => {
  const schedule = { type: "interval" as const, everyMs: 3_600_000 };

  it("names a subagent role instead of a model", () => {
    const created = decodeScheduleTaskInput({
      prompt: "Check for issues.",
      schedule,
      agentRole: "chore-worker",
    });
    expect(created.agentRole).toBe("chore-worker");
    // Omitted leaves the choice to the server, which names its default role.
    expect(decodeScheduleTaskInput({ prompt: "Check.", schedule }).agentRole).toBeUndefined();
    expect(() =>
      decodeScheduleTaskInputLoose({
        prompt: "Check.",
        schedule,
        agentRole: "not-a-role",
      }),
    ).toThrow();
  });

  it("moves an existing task to another role and reports it back", () => {
    const update = decodeUpdateScheduledTaskInput({
      scheduledTaskId: "scheduled-task:1",
      agentRole: "spec-reviewer",
    });
    expect(update.agentRole).toBe("spec-reviewer");
    const summary = decodeScheduledTask({
      scheduledTaskId: "scheduled-task:1",
      title: "Review",
      prompt: "Review the Spec.",
      enabled: true,
      projectId: "project:1",
      boundThreadId: null,
      agentRole: "spec-reviewer",
      schedule,
      nextRunAt: null,
      lastRunStatus: "never",
    });
    expect(summary.agentRole).toBe("spec-reviewer");
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
        schedule,
        nextRunAt: null,
        lastRunStatus: "never",
      }).agentRole,
    ).toBeNull();
  });
});

describe("thread search MCP contracts", () => {
  const decodePage = Schema.decodeUnknownSync(OrchestratorMcpThreadSearchPage);

  it("carries a thread title match beside its environment", () => {
    expect(
      decodePage({
        matches: [
          {
            threadId: "thread-1",
            projectId: "project-1",
            title: "Rollover handling",
            source: "title",
            environmentId: "environment-local",
          },
        ],
      }).matches,
    ).toEqual([
      {
        threadId: "thread-1",
        projectId: "project-1",
        title: "Rollover handling",
        source: "title",
        environmentId: "environment-local",
      },
    ]);
  });

  // A linked environment on a build from before the palette search sends only
  // message matches, without a title; its page must still decode.
  it("decodes a peer's page from a build that sent message matches alone", () => {
    expect(
      decodePage({
        matches: [
          {
            threadId: "thread-1",
            projectId: "project-1",
            source: "user",
            snippet: "the rollover message",
            messageCreatedAt: "2026-10-01T00:00:00.000Z",
            environmentId: "environment-remote",
          },
        ],
      }).matches,
    ).toEqual([
      {
        threadId: "thread-1",
        projectId: "project-1",
        source: "user",
        snippet: "the rollover message",
        messageCreatedAt: "2026-10-01T00:00:00.000Z",
        environmentId: "environment-remote",
      },
    ]);
  });
});
