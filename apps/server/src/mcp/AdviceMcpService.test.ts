import { expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId, type AgentTaskBinding } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Advice from "../agents/AdviceService.ts";
import * as AdviceMcp from "./AdviceMcpService.ts";
import * as Mcp from "./OrchestratorMcpService.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

const workerId = ThreadId.make("reader");

it.effect("fresh peer and worker endpoint services retain environment-owned advice state", () =>
  Effect.gen(function* () {
    const requests: Array<never> = [];
    const environmentAdvice = Layer.mock(Advice.AdviceService)({
      peerRead: () => Effect.succeed(requests),
    });
    const read = Effect.gen(function* () {
      const service = yield* AdviceMcp.AdviceMcpService;
      return yield* service.peer(scope, {
        action: "read",
        workerThreadId: workerId,
        parentThreadId: ThreadId.make("parent"),
      });
    });
    for (const endpoint of ["peer", "worker"]) {
      const result = yield* read.pipe(
        Effect.provide(
          Layer.fresh(McpHttpServer.layerAdviceMcpService).pipe(
            Layer.provide(environmentAdvice),
            Layer.provide(Layer.mock(Mcp.OrchestratorMcpService)({})),
            Layer.provide(Layer.mock(Threads.ThreadManagementService)({})),
          ),
        ),
      );
      expect(result, endpoint).toBe(requests);
    }
  }),
);
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("here"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "reader",
  client: undefined,
  endpointKey: "editor",
  toolProfile: "implementation",
  thread: {
    threadId: workerId,
    providerInstanceId: liveThreadShell(workerId).providerInstanceId,
    providerSessionId: "reader",
  },
};
const question = {
  action: "ask" as const,
  destination: "advisor" as const,
  clientRequestId: "advice",
  question: "Which contract?",
  evidence: "Read",
  recommendation: "Keep",
  blocking: false,
  advisor: { workId: "work", workspacePath: "/source", sourceRevision: "revision" },
};

it.effect.each([
  question,
  { ...question, advisor: { ...question.advisor, taskId: "task" as never } },
  { action: "cancel" as const, requestId: "advice" },
])("a recorded read-only worker cannot acquire or control advisor authority with %o", (input) =>
  Effect.gen(function* () {
    const service = yield* AdviceMcp.AdviceMcpService;
    const result = yield* service.execute(scope, input).pipe(Effect.flip);
    expect(result.code).toBe("capability_denied");
    expect(result.message).toContain("read-only worker");
  }).pipe(
    Effect.provide(
      AdviceMcp.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(Advice.AdviceService)({
              advisor: () =>
                Effect.succeed({ requestId: "advice", task: { taskId: "task" } as never }),
            }),
            Layer.mock(Mcp.OrchestratorMcpService)({
              delegateTask: () => Effect.die("must not launch"),
              cancelTask: () => Effect.die("must not cancel"),
              taskStatus: () => Effect.die("must not control"),
            }),
            Layer.mock(Threads.ThreadManagementService)({
              getThreadShell: () =>
                Effect.succeed({
                  ...liveThreadShell(workerId),
                  agentTask: {
                    sourceAccess: "read-only",
                    toolProfile: "source-reader",
                    role: "scout",
                  } as AgentTaskBinding,
                }),
            }),
          ),
        ),
      ),
    ),
  ),
);
