import {
  CommandId,
  type EnvironmentId,
  type ModelSelection,
  type NodeId,
  OrchestratorMcpAdvice,
  type OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpFailure,
  type OrchestratorMcpThreadRun,
  type OrchestrationV2RemoteTaskChild,
  type OrchestrationV2Subagent,
  type ProviderInstanceId,
  ProviderDriverKind,
  type ProviderInteractionMode,
  type RunId,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { adviceVersion } from "../agents/adviceDelivery.ts";
import * as AdviceService from "../agents/AdviceService.ts";
import type * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import type * as PeerForwarding from "./PeerForwarding.ts";
import type * as PeerLinks from "./PeerLinks.ts";
import type * as PeerMcpClient from "./PeerMcpClient.ts";

type ThreadScope = McpInvocationContext.McpThreadInvocationScope;
type DelegateTarget = NonNullable<OrchestratorMcpDelegateTaskInput["target"]> & {
  readonly environmentId: EnvironmentId;
};
type ThreadModes = {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
};

/** The managed-role methods RemoteDelegation adds to upstream's remote delegate, cancel and follow. */
export interface RemoteManagedDelegationApi {
  readonly pendingAdvice: (
    workerThreadId: ThreadId,
  ) => Effect.Effect<OrchestratorMcpAdvice | undefined, OrchestratorMcpFailure>;
  /**
   * Continues a finished managed task in its thread there, which keeps its role, model,
   * workspace and permissions, and records the new run as a task here.
   */
  readonly followup: (
    scope: ThreadScope,
    task: OrchestrationV2Subagent,
    input: {
      readonly text: string;
      readonly clientRequestId: string;
      readonly mode: OrchestratorMcpDelegateTaskInput["mode"];
    },
  ) => Effect.Effect<{ readonly taskId: NodeId }, OrchestratorMcpFailure>;
  /**
   * Whether a running task's thread there waits on a question or an approval, which is
   * answered there. Unreachable reads as not waiting.
   */
  readonly pendingThere: (
    scope: ThreadScope,
    task: OrchestrationV2Subagent,
  ) => Effect.Effect<boolean>;
}

/**
 * A role, its model and its tool profile are resolved by the environment that runs the
 * task, under its own policy: this side sends the role and at most a requested model,
 * never a workspace, and refuses before anything starts there if that side cannot.
 */
export const admit = Effect.fn("RemoteManagedDelegation.admit")(function* (
  links: PeerLinks.PeerLinks["Service"],
  input: OrchestratorMcpDelegateTaskInput & { readonly target: DelegateTarget },
) {
  const managed = input.agentTask;
  const { target } = input;
  // No revision crosses the link: the other checkout may not hold it.
  if (managed?.sourceRevision !== undefined || managed?.review !== undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        "A task in a linked environment cannot be pinned to a source revision, which that checkout may not hold. Run a pinned reader or a reviewer here, or omit sourceRevision.",
    });
  }
  if (managed?.role === "lead") {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message:
        "A Spec (an `implementer` given forgeItem) runs only in its own environment. Launch a thread there with t3_thread_launch and its forgeItem, or hand the Spec out here.",
    });
  }
  if (managed !== undefined && input.offPolicyReason !== undefined && target.model === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "offPolicyReason with agentTask requires target.model to name the alternate model.",
    });
  }
  if (managed !== undefined) {
    const resolved = yield* links
      .resolve(target.environmentId)
      .pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({ code: "capability_denied", message: error.message }),
        ),
      );
    if (resolved.capabilities.linkedRoleDelegation !== true) {
      return yield* new OrchestratorMcpFailure({
        code: "capability_denied",
        message: `${resolved.link.label} runs a T3 Code version that cannot resolve a managed role, so nothing was started there. Update it, or omit target.environmentId to run this role here.`,
      });
    }
  }
  return managed;
});

/** The launch's model, or for a managed task the role that side resolves, with what the caller named. */
export const launchSelection = (
  input: OrchestratorMcpDelegateTaskInput & { readonly target: DelegateTarget },
  selection: {
    readonly instanceId: ProviderInstanceId;
    readonly model: string | undefined;
    readonly options: DelegateTarget["options"];
  },
) => {
  const managed = input.agentTask;
  const { target } = input;
  const { instanceId, model, options } = selection;
  return {
    ...(managed !== undefined || model === undefined
      ? {}
      : { modelSelection: { instanceId, model, ...(options === undefined ? {} : { options }) } }),
    ...(managed === undefined
      ? {}
      : {
          delegatedRole: {
            role: managed.role,
            taskClass: managed.taskClass,
            workId: managed.workId,
            attemptId: managed.attemptId,
            ...(managed.browser === undefined ? {} : { browser: managed.browser }),
            ...(managed.executionRequirement === undefined
              ? {}
              : { executionRequirement: managed.executionRequirement }),
            ...(managed.readOnly === undefined ? {} : { readOnly: managed.readOnly }),
            ...(managed.authorModel === undefined ? {} : { authorModel: managed.authorModel }),
            ...(input.offPolicyReason === undefined
              ? {}
              : { offPolicyReason: input.offPolicyReason }),
            ...(target.providerInstanceId === undefined &&
            target.model === undefined &&
            target.options === undefined
              ? {}
              : {
                  selection: {
                    ...(target.providerInstanceId === undefined
                      ? {}
                      : { instanceId: target.providerInstanceId }),
                    ...(target.model === undefined ? {} : { model: target.model }),
                    ...(target.options === undefined ? {} : { options: target.options }),
                  },
                }),
          },
        }),
  };
};

/** That side resolved no role, as only an older peer would: stop what it started. */
export const refuseUnresolvedRole = Effect.fn("RemoteManagedDelegation.refuseUnresolvedRole")(
  function* <E>(
    stop: (started: OrchestrationV2RemoteTaskChild) => Effect.Effect<void, E>,
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) {
    yield* stop({ environmentId, threadId, label: environmentId }).pipe(
      Effect.ignoreCause({ log: true }),
    );
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message:
        "The linked environment did not resolve the role, so its thread there was stopped. Update it, or omit target.environmentId to run this role here.",
    });
  },
);

/** A writer's result names the workspace and revision it handed back there. */
export const withHandback = (
  text: string,
  run: OrchestratorMcpThreadRun | undefined,
  label: string,
) =>
  run?.handoff === undefined
    ? text
    : `${text}\n\n(Workspace in ${label}: ${run.handoff.workspacePath}${
        run.handoff.revision === null ? ", no revision recorded" : ` at ${run.handoff.revision}`
      }. The change stays there.)`;

export interface RemoteManagedDelegationDeps {
  readonly threads: ThreadManagement.ThreadManagementService["Service"];
  readonly forwarding: PeerForwarding.PeerForwarding["Service"];
  readonly peers: Option.Option<PeerMcpClient.PeerMcpClient["Service"]>;
  readonly followScope: (
    parent: { readonly threadId: ThreadId; readonly providerInstanceId: ProviderInstanceId },
    remote: OrchestrationV2RemoteTaskChild,
  ) => ThreadScope;
  readonly stopThere: (
    scope: ThreadScope,
    remote: OrchestrationV2RemoteTaskChild,
    key: string,
  ) => Effect.Effect<void, OrchestratorMcpFailure>;
  /** Starts following the task in the background, once. */
  readonly follow: (parentThreadId: ThreadId, taskId: NodeId) => Effect.Effect<void>;
}

export const make = Effect.fn("RemoteManagedDelegation.make")(function* (
  deps: RemoteManagedDelegationDeps,
) {
  const { threads, forwarding, peers, followScope, stopThere, follow } = deps;
  const advice = yield* Effect.serviceOption(AdviceService.AdviceService);

  /** Records a task here for `remoteChild`'s run there, or finds the one a replay recorded. */
  const record = Effect.fn("RemoteDelegation.record")(function* (
    scope: ThreadScope,
    input: {
      readonly parentRunId: RunId;
      readonly parentNodeId: NodeId;
      readonly commandId: CommandId;
      readonly task: string;
      readonly title: string | undefined;
      readonly modelSelection: ModelSelection;
      readonly remoteChild: OrchestrationV2RemoteTaskChild;
      readonly completionWake: "settled_only" | "always";
    },
  ) {
    const { commandId, task, remoteChild } = input;
    const parentRunId = input.parentRunId;
    const parentNodeId = input.parentNodeId;
    const recorded = yield* threads
      .dispatch({
        type: "delegated_task.remote.request",
        commandId,
        parentThreadId: scope.thread.threadId,
        parentRunId,
        parentNodeId,
        task,
        ...(input.title === undefined ? {} : { title: input.title }),
        // The driver runs there; this side only labels the task with it.
        driver: ProviderDriverKind.make("remote"),
        modelSelection: input.modelSelection,
        remoteChild,
        completionWake: input.completionWake,
      })
      .pipe(
        // The cause goes to the log; the caller learns only that recording failed.
        Effect.tapError((cause) =>
          Effect.logWarning("remote-delegation.record-failed", {
            parentThreadId: scope.thread.threadId,
            cause,
          }),
        ),
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: "Unable to record the delegated task.",
            }),
        ),
        // Nothing here follows a thread the task was never recorded for, so stop it there.
        // A crash between the launch and this record still leaves it running there
        // until a retry with the same clientRequestId records it.
        Effect.tapError(() =>
          stopThere(followScope(scope.thread, remoteChild), remoteChild, "stop").pipe(
            Effect.ignoreCause({ log: true }),
          ),
        ),
      );
    const taskEvent = recorded.storedEvents.find(
      (stored) => stored.event.type === "subagent.updated",
    );
    const taskId =
      taskEvent?.event.type === "subagent.updated"
        ? taskEvent.event.payload.id
        : // A replayed request recorded the task the first time.
          yield* threads.getThreadRecords(scope.thread.threadId, ["subagents"]).pipe(
            Effect.map(
              ({ subagents }) =>
                subagents.find(
                  (task) =>
                    task.remoteChild?.threadId === remoteChild.threadId &&
                    task.remoteChild.runId === remoteChild.runId,
                )?.id,
            ),
            Effect.orElseSucceed(() => undefined),
          );
    if (taskId === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: "The delegated task was not recorded.",
      });
    }
    return taskId;
  });

  const followup: RemoteManagedDelegationApi["followup"] = Effect.fn("RemoteDelegation.followup")(
    function* (scope, task, input) {
      const remote = task.remoteChild;
      if (remote?.agentTask === undefined || task.result === null) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            remote === undefined
              ? `Delegated task ${task.id} is not remote.`
              : remote.agentTask === undefined
                ? "Only a managed task can continue its conversation."
                : "The agent is busy or awaiting result publication. Retry after publication.",
        });
      }
      const parent = yield* threads.getThreadRecords(scope.thread.threadId, ["runs"]).pipe(
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "thread_not_found",
              message: "The calling thread was not found.",
            }),
        ),
      );
      const parentRun = parent.runs
        .filter(ThreadManagement.isActiveRun)
        .toSorted((left, right) => right.ordinal - left.ordinal)[0];
      if (
        parentRun === undefined ||
        parentRun.rootNodeId === null ||
        parentRun.providerInstanceId !== scope.thread.providerInstanceId
      ) {
        return yield* new OrchestratorMcpFailure({
          code: "parent_not_active",
          message: "Delegated tasks require an active run owned by this MCP provider session.",
        });
      }
      const sent = yield* forwarding.sendThread(scope, remote.environmentId, {
        threadId: remote.threadId,
        message: input.text,
        mode: "queue",
        clientRequestId: `followup:${scope.thread.threadId}:${input.clientRequestId}`,
      });
      const remoteChild: OrchestrationV2RemoteTaskChild = {
        environmentId: remote.environmentId,
        threadId: remote.threadId,
        label: remote.label,
        ...(remote.title === undefined ? {} : { title: remote.title }),
        runId: sent.runId,
        agentTask: remote.agentTask,
      };
      const taskId = yield* record(scope, {
        parentRunId: parentRun.id,
        parentNodeId: parentRun.rootNodeId,
        commandId: CommandId.make(
          `command:mcp:${encodeURIComponent(scope.requestNamespace)}:remote-followup:${encodeURIComponent(input.clientRequestId)}`,
        ),
        task: input.text,
        title: task.title ?? undefined,
        modelSelection: task.modelSelection ?? remote.agentTask.effective,
        remoteChild,
        completionWake: input.mode === "wait" ? "settled_only" : "always",
      });
      yield* follow(scope.thread.threadId, taskId);
      return { taskId };
    },
  );

  const pendingThere: RemoteManagedDelegationApi["pendingThere"] = (scope, task) => {
    const remote = task.remoteChild;
    if (remote === undefined || task.result !== null) return Effect.succeed(false);
    return forwarding
      .readThread(followScope(scope.thread, remote), remote.environmentId, {
        threadId: remote.threadId,
        limit: 1,
        runLimit: 1,
      })
      .pipe(
        Effect.map((read) => read.thread.pendingRequestCount > 0),
        Effect.orElseSucceed(() => false),
      );
  };

  const readAdvice = Effect.fn("RemoteDelegation.readAdvice")(function* (
    parentThreadId: ThreadId,
    remote: OrchestrationV2RemoteTaskChild,
    thread: ThreadModes,
  ) {
    let inspection: { readonly blocking: boolean; readonly seen: string } | undefined;
    if (remote.agentTask !== undefined && Option.isSome(advice) && Option.isSome(peers)) {
      yield* peers.value
        .call({
          environmentId: remote.environmentId,
          tool: "t3_advice_peer",
          arguments: { action: "read", workerThreadId: remote.threadId, parentThreadId },
          limits: { runtimeMode: thread.runtimeMode, interactionMode: thread.interactionMode },
          success: Schema.Array(OrchestratorMcpAdvice),
        })
        .pipe(
          Effect.flatMap((requests) => {
            inspection = {
              blocking: requests.some(
                (request) => request.status === "pending" && request.blocking,
              ),
              seen: adviceVersion(requests),
            };
            return Effect.forEach(
              requests,
              (request) =>
                advice.value.receiveRemote(remote.environmentId, request).pipe(
                  Effect.andThen(
                    peers.value.call({
                      environmentId: remote.environmentId,
                      tool: "t3_advice_peer",
                      arguments: {
                        action: "delivered",
                        workerThreadId: remote.threadId,
                        parentThreadId,
                        requestId: request.requestId,
                      },
                      limits: {
                        runtimeMode: thread.runtimeMode,
                        interactionMode: thread.interactionMode,
                      },
                      success: Schema.Array(OrchestratorMcpAdvice),
                    }),
                  ),
                ),
              { discard: true },
            );
          }),
          Effect.tapError(() => advice.value.remoteUnavailable(remote.threadId)),
        );
    }
    return inspection;
  });

  type Inspection = Effect.Success<ReturnType<typeof readAdvice>>;

  /** A worker there blocked on advice: wait for its answer instead of its run. True when it waited. */
  const awaitBlockingAdvice = Effect.fnUntraced(function* <E>(
    parentThreadId: ThreadId,
    remote: OrchestrationV2RemoteTaskChild,
    thread: ThreadModes,
    inspection: Inspection,
    endedHere: Effect.Effect<{ readonly endedHere: true }, E>,
  ) {
    if (!inspection?.blocking || Option.isNone(peers) || Option.isNone(advice)) return false;
    const result = yield* peers.value
      .call({
        environmentId: remote.environmentId,
        tool: "t3_advice_peer",
        arguments: { action: "wait", workerThreadId: remote.threadId, parentThreadId },
        limits: { runtimeMode: thread.runtimeMode, interactionMode: thread.interactionMode },
        success: Schema.Array(OrchestratorMcpAdvice),
      })
      .pipe(
        Effect.tapError(() => advice.value.remoteUnavailable(remote.threadId)),
        Effect.raceFirst(endedHere),
      );
    if (!("endedHere" in result))
      yield* Effect.forEach(
        result,
        (request) => advice.value.receiveRemote(remote.environmentId, request),
        { discard: true },
      );
    return true;
  });

  /** Ends a wait on the run there when the worker's advice requests change. */
  const adviceChanged = (
    parentThreadId: ThreadId,
    remote: OrchestrationV2RemoteTaskChild,
    thread: ThreadModes,
    inspection: Inspection,
  ) =>
    inspection === undefined || Option.isNone(peers) || Option.isNone(advice)
      ? Effect.never
      : peers.value
          .call({
            environmentId: remote.environmentId,
            tool: "t3_advice_peer",
            arguments: {
              action: "wait",
              workerThreadId: remote.threadId,
              parentThreadId,
              seen: inspection.seen,
            },
            limits: { runtimeMode: thread.runtimeMode, interactionMode: thread.interactionMode },
            success: Schema.Array(OrchestratorMcpAdvice),
          })
          .pipe(
            Effect.flatMap((requests) =>
              Effect.forEach(
                requests,
                (request) => advice.value.receiveRemote(remote.environmentId, request),
                { discard: true },
              ),
            ),
            Effect.as({ adviceChanged: true } as const),
            Effect.tapError(() => advice.value.remoteUnavailable(remote.threadId)),
          );

  const api: RemoteManagedDelegationApi = {
    pendingAdvice: Effect.fn("RemoteDelegation.pendingAdvice")((workerThreadId) =>
      Option.isSome(advice) ? advice.value.pending(workerThreadId) : Effect.undefined,
    ),
    followup,
    pendingThere,
  };
  return { api, record, readAdvice, awaitBlockingAdvice, adviceChanged };
});
