import {
  OrchestratorMcpAdvice,
  type OrchestratorMcpAskAdviceInput,
  type OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpFailure,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as Advice from "../agents/AdviceService.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { McpInvocationContext, type McpInvocationScope } from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import * as OrchestratorMcp from "./OrchestratorMcpService.ts";

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });
const denied = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });
export interface PeerAdviceInput {
  readonly action: "read" | "answer" | "delivered" | "wait" | "cancel";
  readonly workerThreadId: ThreadId;
  readonly parentThreadId: ThreadId;
  readonly requestId?: string | undefined;
  readonly answer?: string | undefined;
  readonly seen?: string | undefined;
}

export class AdviceMcpService extends Context.Service<
  AdviceMcpService,
  {
    readonly execute: (
      scope: McpInvocationScope,
      input: OrchestratorMcpAskAdviceInput,
    ) => Effect.Effect<
      OrchestratorMcpAdvice | OrchestratorMcpDelegateTaskResult,
      OrchestratorMcpFailure
    >;
    readonly peer: (
      scope: McpInvocationScope,
      input: PeerAdviceInput,
    ) => Effect.Effect<ReadonlyArray<OrchestratorMcpAdvice>, OrchestratorMcpFailure>;
  }
>()("t3/mcp/AdviceMcpService") {}

const make = Effect.gen(function* () {
  const advice = yield* Advice.AdviceService;
  const orchestrator = yield* OrchestratorMcp.OrchestratorMcpService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const peers = yield* Effect.serviceOption(PeerMcpClient.PeerMcpClient);

  const advisorAccess = (scope: McpInvocationScope) =>
    McpToolAccess.advisorAccess.pipe(
      Effect.provideService(McpInvocationContext, scope),
      Effect.provideService(ThreadManagement.ThreadManagementService, threads),
    );

  const execute: AdviceMcpService["Service"]["execute"] = Effect.fn("AdviceMcpService.execute")(
    function* (scope, input) {
      if (input.action === "ask") {
        if (input.destination === "advisor") yield* advisorAccess(scope);
        const pendingAdvisor = yield* advice.advisor(scope);
        if (pendingAdvisor !== undefined) {
          const task = yield* orchestrator.taskStatus(scope, pendingAdvisor.task.taskId);
          yield* advice.recordAdvisor(scope, pendingAdvisor.requestId, task);
        }
        yield* advice.reserve(scope, input);
        const dispatch = Effect.gen(function* () {
          if (input.destination !== "advisor")
            return yield* advice.ask(scope, input.clientRequestId, input);
          if (scope.endpointKey === "research" || scope.endpointKey === "preview")
            return yield* denied(
              "This role may ask its parent for advice but cannot launch an advisor.",
            );
          const recorded = yield* advice.advisor(scope, input.clientRequestId);
          if (recorded !== undefined) {
            const task = yield* orchestrator.taskStatus(scope, recorded.task.taskId);
            yield* advice.recordAdvisor(scope, input.clientRequestId, task);
            return task;
          }
          const advisor = input.advisor;
          if (advisor.taskId !== undefined) {
            const task = yield* orchestrator.taskStatus(scope, advisor.taskId);
            if (task.agentTask?.role !== "advisor")
              return yield* invalid("Advisor follow-up must name an existing managed advisor.");
          }
          const result = yield* orchestrator.delegateTask(scope, {
            ...(advisor.taskId === undefined
              ? {
                  agentTask: {
                    role: "advisor" as const,
                    taskClass: "non-ui" as const,
                    workId: advisor.workId,
                    attemptId: input.clientRequestId,
                    workspacePath: advisor.workspacePath,
                    sourceRevision: advisor.sourceRevision,
                  },
                  ...(advisor.target === undefined ? {} : { target: advisor.target }),
                }
              : {
                  followup: {
                    taskId: advisor.taskId,
                    sourceRevision: advisor.sourceRevision,
                    changes: input.newEvidence ?? input.evidence,
                  },
                }),
            clientRequestId: input.clientRequestId,
            mode: input.blocking ? "wait" : "async",
            task: `Question: ${input.question}\nEvidence: ${input.evidence}\nRecommendation: ${input.recommendation}\n${input.newEvidence ?? ""}`,
          });
          yield* advice.recordAdvisor(scope, input.clientRequestId, result);
          return result;
        });
        return yield* dispatch.pipe(
          Effect.tapError(() => advice.release(scope, input.clientRequestId)),
        );
      }
      if (input.workerThreadId === undefined || input.workerThreadId === scope.thread?.threadId) {
        const advisor = yield* advice.advisor(scope, input.requestId);
        if (advisor !== undefined) {
          if (input.action === "answer")
            return yield* invalid("An advisor answers through its managed task result.");
          if (input.action === "cancel") {
            yield* advisorAccess(scope);
            yield* orchestrator.cancelTask(scope, {
              taskId: advisor.task.taskId,
              clientRequestId: `advice-cancel:${input.requestId}`,
            });
          }
          const task = yield* orchestrator.taskStatus(scope, advisor.task.taskId);
          yield* advice.recordAdvisor(scope, input.requestId, task);
          return task;
        }
      }
      const workerThreadId = input.workerThreadId ?? scope.thread?.threadId;
      if (workerThreadId === undefined) return yield* denied("Advice requires a T3 thread.");
      if (input.environmentId !== undefined && input.environmentId !== scope.environmentId) {
        if (scope.thread === undefined || scope.client !== undefined)
          return yield* denied("Only the actual parent can route advice to its remote child.");
        const parent = yield* threads
          .getThreadRecords(scope.thread.threadId, ["subagents"])
          .pipe(Effect.mapError(() => invalid("Cannot read delegation ownership.")));
        if (
          !parent.subagents.some(
            (task) =>
              task.origin === "app_owned" &&
              task.remoteChild?.threadId === workerThreadId &&
              task.remoteChild.environmentId === input.environmentId &&
              task.result === null,
          )
        )
          return yield* denied("This parent does not own that live remote worker.");
        if (Option.isNone(peers)) return yield* invalid("Linked advice delivery is unavailable.");
        const result = yield* peers.value
          .call({
            environmentId: input.environmentId,
            tool: "t3_advice_peer",
            arguments: {
              action: input.action,
              workerThreadId,
              parentThreadId: scope.thread.threadId,
              requestId: input.requestId,
              ...(input.action === "answer" ? { answer: input.answer } : {}),
            },
            limits: {
              runtimeMode: parent.thread.runtimeMode,
              interactionMode: parent.thread.interactionMode,
            },
            success: Schema.Array(OrchestratorMcpAdvice),
          })
          .pipe(
            Effect.catch((error) => {
              if (input.action !== "read") return Effect.fail(error);
              return advice.remoteUnavailable(workerThreadId).pipe(
                Effect.andThen(advice.read(scope, workerThreadId, input.requestId)),
                Effect.map((value) => [value]),
                Effect.mapError(() => error),
              );
            }),
          );
        const found = result.find((item) => item.requestId === input.requestId);
        if (found === undefined) return yield* invalid("Advice request not found.");
        yield* advice.receiveRemote(input.environmentId, found);
        return found;
      }
      if (input.action === "answer")
        return yield* advice.answer(scope, workerThreadId, input.requestId, input.answer);
      if (input.action === "cancel")
        return yield* advice.cancel(scope, workerThreadId, input.requestId);
      return yield* advice.read(scope, workerThreadId, input.requestId);
    },
  );
  const peer: AdviceMcpService["Service"]["peer"] = Effect.fn("AdviceMcpService.peer")(
    function* (scope, input) {
      if (input.action === "wait")
        return yield* advice.waitPeer(
          scope,
          input.workerThreadId,
          input.parentThreadId,
          input.seen,
        );
      const records = yield* advice.peerRead(scope, input.workerThreadId, input.parentThreadId);
      if (input.action === "answer") {
        if (input.requestId === undefined || input.answer === undefined)
          return yield* invalid("An answer requires requestId and answer.");
        yield* advice.answer(
          scope,
          input.workerThreadId,
          input.requestId,
          input.answer,
          input.parentThreadId,
        );
      } else if (input.action === "cancel") {
        if (input.requestId === undefined)
          return yield* invalid("Cancellation requires requestId.");
        yield* advice.cancel(scope, input.workerThreadId, input.requestId, input.parentThreadId);
      } else if (input.action === "delivered") {
        if (input.requestId === undefined) return yield* invalid("Delivery requires requestId.");
        yield* advice.delivered(input.workerThreadId, input.requestId);
      } else return records;
      return yield* advice.peerRead(scope, input.workerThreadId, input.parentThreadId);
    },
  );
  return AdviceMcpService.of({ execute, peer });
});
export const layer = Layer.effect(AdviceMcpService, make);
