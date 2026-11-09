import {
  AgentTaskRequest,
  OrchestratorMcpFailure,
  OrchestratorMcpSchedule,
} from "@t3tools/contracts";
import { OrchestratorToolkit } from "./tools.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../../../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../../../peer/PeerLinks.ts";
import * as ThreadHandoff from "../../../peer/handoff/ThreadHandoff.ts";
import { assertBelowDelegationLimit, loadCaller, readCaller } from "../../threadAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../../ThreadMetadataMcpService.ts";
import * as ThreadDirectory from "../../../peers/ThreadDirectory.ts";

const decodeScheduledTaskSchedule = Schema.decodeUnknownEffect(OrchestratorMcpSchedule);
const decodeAgentTask = Schema.decodeUnknownEffect(AgentTaskRequest);

export const handlers = {
  agent_task_outcome: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.recordAgentOutcome(scope, input);
    }),
  ),
  agent_session_attach: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.attachAgentSession(scope, input);
    }),
  ),
  agent_roles: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.agentRoles(scope, input);
    }),
  ),
  orchestrator_capabilities: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.capabilities(scope, input);
    }),
  ),
  delegate_task: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const agentTask =
        input.agentTask === undefined
          ? undefined
          : yield* decodeAgentTask(input.agentTask).pipe(
              Effect.mapError(
                () =>
                  new OrchestratorMcpFailure({
                    code: "invalid_request",
                    message:
                      "agentTask must carry role, taskClass, workId, attemptId and workspacePath.",
                  }),
              ),
            );
      return yield* service.delegateTask(scope, { ...input, agentTask });
    }),
  ),
  task_status: McpToolAccess.readsTask(({ taskId, timeoutMs }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.taskStatus(scope, taskId, timeoutMs);
    }),
  ),
  task_cancel: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.cancelTask(scope, input);
    }),
  ),
  t3_workflow_stop: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const { threads } = yield* readCaller();
        return yield* threads.stopWorkflow(input).pipe(
          Effect.as({}),
          Effect.mapError(
            (cause) =>
              new OrchestratorMcpFailure({
                code:
                  cause.reason === "unavailable" || cause.reason === "stop-failed"
                    ? "orchestration_error"
                    : "invalid_request",
                message: cause.message,
              }),
          ),
        );
      }),
  ),
  t3_background_wait: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { scope, threads } = yield* readCaller();
      const caller = yield* McpInvocationContext.requireThreadScope(scope, "t3_background_wait");
      return yield* threads
        .awaitBackgroundTasks({
          threadId: caller.thread.threadId,
          taskIds: input.taskIds,
          awaited: input.waiting ?? true,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorMcpFailure({
                code: cause.reason === "unsupported" ? "invalid_request" : "orchestration_error",
                message: cause.message,
              }),
          ),
        );
    }),
  ),
  schedule_task: McpToolAccess.either(
    (input) => input.scheduledTaskId === undefined,
    McpToolAccess.startsThreads(
      () => ({}),
      ({ prompt, schedule, purpose, ...input }) =>
        Effect.gen(function* () {
          if (prompt === undefined || schedule === undefined || purpose === undefined) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "A new scheduled task needs `prompt`, `schedule` and `purpose`.",
            });
          }
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          return yield* service.scheduleTask(scope, {
            ...input,
            prompt,
            purpose,
            schedule: yield* decodeScheduledTaskSchedule(schedule).pipe(
              Effect.mapError(
                () =>
                  new OrchestratorMcpFailure({
                    code: "invalid_request",
                    message: "schedule must use the shape schedule_task accepts.",
                  }),
              ),
            ),
          });
        }),
      // A scheduled run starts long after its caller, with nothing to carry the link.
      { refused: "schedule tasks in this environment" },
    ),
    McpToolAccess.writes(({ scheduledTaskId, schedule, ...rest }) =>
      Effect.gen(function* () {
        if (scheduledTaskId === undefined) return yield* Effect.die("unreachable");
        // Changing a schedule shapes a run that starts later, so it obeys the delegation limit too.
        const { threads, caller } = yield* loadCaller();
        if (caller !== undefined) yield* assertBelowDelegationLimit(threads, caller);
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.updateScheduledTask(scope, {
          scheduledTaskId,
          ...rest,
          ...(schedule === undefined
            ? {}
            : {
                schedule: yield* decodeScheduledTaskSchedule(schedule).pipe(
                  Effect.mapError(
                    () =>
                      new OrchestratorMcpFailure({
                        code: "invalid_request",
                        message: "schedule must use the shape schedule_task accepts.",
                      }),
                  ),
                ),
              }),
        });
      }),
    ),
  ),
  list_scheduled_tasks: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.listScheduledTasks(scope, input);
    }),
  ),
  delete_scheduled_task: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.deleteScheduledTask(scope, input);
    }),
  ),
  request_secret: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.requestSecret(scope, input);
    }),
  ),
  request_release_approval: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.requestReleaseApproval(scope, input);
    }),
  ),
  create_threads: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const { caller, threads } = yield* loadCaller();
      if (caller !== undefined) yield* assertBelowDelegationLimit(threads, caller);
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.createThreads(scope, input);
    }),
  ),
  t3_thread_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      if (!scope.capabilities.has("orchestration"))
        return yield* new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "This MCP credential does not grant orchestration capabilities.",
        });
      if (
        input.environmentId !== undefined &&
        input.environmentId !== "all" &&
        input.environmentId !== scope.environmentId &&
        scope.client?.access !== "peer-threads"
      ) {
        const links = yield* Effect.serviceOption(PeerLinks.PeerLinks);
        const link = Option.isNone(links)
          ? Option.none()
          : yield* links.value.get(input.environmentId).pipe(
              Effect.mapError(
                (error) =>
                  new OrchestratorMcpFailure({
                    code: "orchestration_error",
                    message: error.message,
                  }),
              ),
            );
        if (Option.isSome(link)) {
          const forwarding = yield* Effect.serviceOption(PeerForwarding.PeerForwarding);
          if (Option.isSome(forwarding))
            return yield* forwarding.value.call(
              scope,
              OrchestratorToolkit.tools.t3_thread_list,
              input.environmentId,
              input,
            );
        }
      }
      const directory = yield* ThreadDirectory.ThreadDirectory;
      return yield* directory.listAcross({
        query: input,
        localId: scope.environmentId,
        fromPeer: scope.client?.access === "peer-threads",
        local: service.listThreads(scope, input),
      });
    }),
  ),
  t3_thread_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const directory = yield* ThreadDirectory.ThreadDirectory;
      const { environmentId, ...local } = input;
      return yield* directory.readAcross({
        environmentId,
        localId: scope.environmentId,
        fromPeer: scope.client?.access === "peer-threads",
        arguments: local,
        local: service.readThread(scope, local),
      });
    }),
  ),
  t3_thread_update: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* ThreadMetadataMcpService.ThreadMetadataMcpService;
        return yield* service.update(scope, input);
      }),
  ),
  t3_thread_send: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.sendToThread(scope, input);
      }),
  ),
  t3_thread_wait: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.waitForThread(scope, input);
    }),
  ),
  watch: McpToolAccess.writesThreads(
    () => [],
    (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.watchThread(scope, input, true);
      }),
  ),
  unwatch: McpToolAccess.writesThreads(
    () => [],
    (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.watchThread(scope, input, false);
      }),
  ),
  t3_thread_handoff: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const handoff = yield* ThreadHandoff.ThreadHandoff;
        const state = yield* handoff
          .start({
            threadId: input.threadId,
            callerThreadId: scope.thread?.threadId,
            environmentId: input.environmentId,
            projectId: input.projectId,
            continuationPrompt: input.continuationPrompt,
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({
                  code:
                    error.reason === "not_found"
                      ? "thread_not_found"
                      : error.reason === "refused"
                        ? "invalid_request"
                        : "orchestration_error",
                  message: error.message,
                }),
            ),
          );
        return {
          state: state.state,
          environmentId: state.environmentId,
          label: state.label,
          threadId: state.state === "departed" ? state.threadId : null,
          message:
            state.state === "pending"
              ? `This thread moves to ${state.label} when this turn ends. End the turn now; a message to this thread before then cancels the move.`
              : state.state === "departed"
                ? `The thread moved to ${state.label}.`
                : state.state === "failed"
                  ? `The move failed: ${state.lastError}`
                  : `The thread is moving to ${state.label}.`,
        };
      }),
  ),
  t3_environment_links: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const forwarding = yield* PeerForwarding.PeerForwarding;
      return yield* forwarding.links(scope);
    }),
  ),
  // A link lets every agent here reach the other environment, so it is an
  // environment setting: full access, and never for linked work.
  t3_environment_link: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const requests = yield* PeerLinkRequests.PeerLinkRequests;
      return yield* requests.request(scope, input);
    }),
  ),
  t3_environment_unlink: McpToolAccess.writesEnvironment(({ environmentId }) =>
    Effect.gen(function* () {
      const links = yield* PeerLinks.PeerLinks;
      const removed = yield* links
        .unlink(environmentId)
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
          ),
        );
      return { environmentId, removed };
    }),
  ),
  t3_thread_interrupt: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.interruptThread(scope, input);
      }),
  ),
} satisfies McpToolAccess.Handlers<typeof OrchestratorToolkit.tools>;

export const layer = McpToolAccess.toLayer(OrchestratorToolkit, handlers);
