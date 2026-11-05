import {
  CommandId,
  OrchestratorMcpFailure,
  isOrchestrationV2WorkActive,
  type NodeId,
  type ThreadId,
  type ProjectId,
  type RuntimeMode,
  type ProviderInteractionMode,
  type OrchestratorMcpDelegateTaskResult,
  type OrchestratorMcpTaskCancelResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import {
  DispatchModeLimit,
  type DispatchModeRefusal,
} from "../orchestration-v2/DispatchModeLimit.ts";
import { resolveRuntimeMode, resolveInteractionMode } from "../mcp/delegatedTaskModes.ts";
import * as ManagedAgent from "./ManagedAgentService.ts";

// Internal authority only; never a schema accepted from an RPC or MCP payload.
export interface CancellationIntent {
  readonly ownerThreadId: ThreadId;
  readonly projectId: ProjectId;
  readonly taskId: NodeId;
  readonly childThreadId: ThreadId;
  readonly requestId: string;
  readonly requestNamespace: string;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly reason?: string | undefined;
}
const validatedPrincipal: unique symbol = Symbol("validated-managed-cancellation");
type ValidatedCancellation = CancellationIntent & { readonly [validatedPrincipal]: true };
type CancellationView = Pick<
  OrchestratorMcpDelegateTaskResult,
  "status" | "workState" | "childRunId"
>;
export class ManagedTaskControl extends Context.Service<
  ManagedTaskControl,
  {
    readonly cancel: (
      principal: CancellationIntent,
      current: CancellationView,
    ) => Effect.Effect<OrchestratorMcpTaskCancelResult, OrchestratorMcpFailure>;
    /** Internal MCP path already holds ManagedAgentService.exclusive around view acquisition. */
    readonly cancelWithinExclusive: (
      principal: CancellationIntent,
      current: CancellationView,
    ) => Effect.Effect<OrchestratorMcpTaskCancelResult, OrchestratorMcpFailure>;
  }
>()("t3/agents/ManagedTaskControl") {}
const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
const threadManagementFailure = (cause: unknown) =>
  failure("orchestration_error", errorMessage(cause));
const agentStopReason = (reason: string | undefined) =>
  reason === undefined ? "Stopped by an agent" : `Stopped by an agent: ${reason}`;
const isTerminalTaskStatus = (
  status: OrchestratorMcpDelegateTaskResult["status"],
): status is "completed" | "failed" | "cancelled" | "interrupted" =>
  ["completed", "failed", "cancelled", "interrupted"].includes(status);
export const layer = Layer.effect(
  ManagedTaskControl,
  Effect.gen(function* () {
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const policy = yield* Effect.serviceOption(ManagedAgent.ManagedAgentService);
    const loadProjection = (threadId: ThreadId, subagentIds: ReadonlyArray<NodeId> = []) =>
      threadManagement
        .getThreadRecords(threadId, ["runs", "subagents"], { subagentIds })
        .pipe(Effect.mapError(threadManagementFailure));
    const cancel = Effect.fn("ManagedTaskControl.cancel")(function* (
      intent: CancellationIntent,
      current: Pick<OrchestratorMcpDelegateTaskResult, "status" | "workState" | "childRunId">,
    ) {
      const input = { taskId: intent.taskId };
      const childThreadId = intent.childThreadId;
      const stableCommandId = ({ operation }: { operation: string }) =>
        CommandId.make(
          [
            "command",
            "mcp",
            encodeURIComponent(principal.requestNamespace),
            encodeURIComponent(operation),
            encodeURIComponent(principal.requestId),
          ].join(":"),
        );
      const owner = yield* threadManagement
        .getThreadShell(intent.ownerThreadId)
        .pipe(Effect.mapError(threadManagementFailure));
      if (owner === null || owner.deletedAt !== null || owner.projectId !== intent.projectId)
        return yield* failure(
          "capability_denied",
          "Cancellation owner is unavailable or no longer owns this project.",
        );
      const owned = yield* loadProjection(intent.ownerThreadId, [intent.taskId]);
      const task = owned.subagents.find(
        (task) =>
          task.id === intent.taskId &&
          task.origin === "app_owned" &&
          task.childThreadId === intent.childThreadId,
      );
      if (task === undefined)
        return yield* failure(
          "task_not_found",
          "Cancellation task and child no longer belong to this owner.",
        );
      const principal: ValidatedCancellation = { ...intent, [validatedPrincipal]: true };
      const withCurrentAuthority = Effect.fn("ManagedTaskControl.withCurrentAuthority")(function* <
        A,
        E,
        R,
      >(threadId: ThreadId, effect: Effect.Effect<A, E, R>) {
        const currentOwner = yield* threadManagement
          .getThreadShell(principal.ownerThreadId)
          .pipe(Effect.mapError(threadManagementFailure));
        if (
          !currentOwner ||
          currentOwner.deletedAt !== null ||
          currentOwner.projectId !== principal.projectId
        )
          return yield* failure("capability_denied", "Cancellation owner is no longer available.");
        const target = yield* threadManagement
          .getThreadShell(threadId)
          .pipe(Effect.mapError(threadManagementFailure));
        if (target !== null && target.deletedAt === null) {
          yield* resolveRuntimeMode(principal.runtimeMode, target.runtimeMode);
          yield* resolveRuntimeMode(currentOwner.runtimeMode, target.runtimeMode);
          yield* resolveInteractionMode(principal.interactionMode, target.interactionMode);
          yield* resolveInteractionMode(currentOwner.interactionMode, target.interactionMode);
        }
        const inherited = yield* DispatchModeLimit;
        return yield* effect.pipe(
          Effect.provideService(DispatchModeLimit, {
            ...inherited,
            runtimeMode: yield* resolveRuntimeMode(
              principal.runtimeMode,
              currentOwner.runtimeMode,
            ).pipe(Effect.orElseSucceed(() => principal.runtimeMode)),
            interactionMode: yield* resolveInteractionMode(
              principal.interactionMode,
              currentOwner.interactionMode,
            ).pipe(Effect.orElseSucceed(() => principal.interactionMode)),
          }),
        );
      });
      const dispatch = Effect.fn("ManagedTaskControl.dispatch")(
        (
          command: Parameters<
            ThreadManagementService.ThreadManagementService["Service"]["dispatch"]
          >[0],
        ) =>
          withCurrentAuthority(
            "threadId" in command ? command.threadId : principal.ownerThreadId,
            threadManagement.dispatch(command),
          ),
      );
      const effective = {
        runtimeMode: yield* resolveRuntimeMode(principal.runtimeMode, owner.runtimeMode).pipe(
          Effect.orElseSucceed(() => principal.runtimeMode),
        ),
        interactionMode: yield* resolveInteractionMode(
          principal.interactionMode,
          owner.interactionMode,
        ).pipe(Effect.orElseSucceed(() => principal.interactionMode)),
      };
      const parentProjection = yield* loadProjection(principal.ownerThreadId, [principal.taskId]);
      // Cancelling stops the child and every task under it, each a write to a
      // thread its user may have raised above the parent's modes since it was
      // delegated. All of them are checked before anything is stopped.
      const assertStoppable = Effect.fn("OrchestratorMcpService.assertStoppable")(function* (
        threadId: ThreadId,
      ): Effect.fn.Return<void, OrchestratorMcpFailure> {
        const shell = yield* threadManagement
          .getThreadShell(threadId)
          .pipe(Effect.mapError(threadManagementFailure));
        // A deleted thread takes no stop, but the tasks under it still do.
        if (shell !== null && shell.deletedAt === null) {
          yield* resolveRuntimeMode(parentProjection.thread.runtimeMode, shell.runtimeMode);
          yield* resolveRuntimeMode(principal.runtimeMode, shell.runtimeMode);
          yield* resolveInteractionMode(
            parentProjection.thread.interactionMode,
            shell.interactionMode,
          );
          yield* resolveInteractionMode(principal.interactionMode, shell.interactionMode);
        }
        const { subagents } = yield* threadManagement
          .getThreadRecords(threadId, ["subagents"], { omitSettledSubagents: true })
          .pipe(Effect.mapError(threadManagementFailure));
        for (const task of subagents) {
          if (task.origin === "app_owned" && task.childThreadId !== null) {
            yield* assertStoppable(task.childThreadId);
          }
        }
      });
      yield* assertStoppable(childThreadId);
      const parentTask = parentProjection.subagents.find(
        (task) => task.id === input.taskId && task.origin === "app_owned",
      );
      const disposeCompletionDelivery =
        parentTask?.completionDelivery?.state === "disposed"
          ? Effect.void
          : dispatch({
              type: "delegated_task.completion-delivery.dispose",
              commandId: stableCommandId({
                operation: "cancel-task-completion-delivery",
              }),
              parentThreadId: principal.ownerThreadId,
              taskId: input.taskId,
            }).pipe(
              Effect.asVoid,
              Effect.mapError((error) =>
                failure(
                  "orchestration_error",
                  `Unable to dispose delegated task ${input.taskId} completion delivery: ${errorMessage(error)}`,
                ),
              ),
            );
      // Cancelling stops the child thread the way Stop does, including work that came
      // after a published result: follow-up runs, pull request watch wakes, and the
      // tasks it delegated. The published result stays terminal.
      const stopChild = Effect.gen(function* () {
        const commandId = stableCommandId({ operation: "cancel-task" });
        const reason = agentStopReason(principal.reason);
        yield* dispatch({
          type: "thread.stop",
          commandId,
          threadId: childThreadId,
          stopDelegatedTasks: false,
          reason,
        }).pipe(
          Effect.mapError((error) =>
            failure(
              "task_not_cancellable",
              `Unable to stop delegated task ${input.taskId}: ${errorMessage(error)}`,
            ),
          ),
        );
        // A retry with the same clientRequestId repeats only the stops that failed.
        yield* withCurrentAuthority(
          childThreadId,
          threadManagement.stopDelegatedTasks({ threadId: childThreadId, commandId, reason }),
        ).pipe(
          Effect.mapError((error) =>
            failure(
              "task_not_cancellable",
              `Stopped delegated task ${input.taskId}, but not every task it delegated: ${errorMessage(error)}`,
            ),
          ),
        );
        const stopped = yield* threadManagement
          .getThreadRecords(childThreadId, ["runs"])
          .pipe(Effect.mapError(threadManagementFailure));
        for (const run of stopped.runs) {
          if (
            run.status !== "queued" ||
            (run.delegatedTaskId !== input.taskId && run.id !== current.childRunId)
          )
            continue;
          // Stop preserves the queue for Resume. Cancelling a task must also
          // remove that task's queued turn, including a previously held one.
          yield* dispatch({
            type: "queued-run.cancel",
            commandId: stableCommandId({
              operation: `cancel-task-queued-run:${run.id}`,
            }),
            threadId: childThreadId,
            runId: run.id,
          }).pipe(Effect.mapError(threadManagementFailure));
        }
        // Release a closed task's idle provider process now, not at the idle timeout, so it frees
        // its workspace (T3-264); a follow-up resumes in a fresh session. A turn Stop is still
        // interrupting keeps its session, since releasing it mid-turn could fail the run.
        yield* Effect.gen(function* () {
          const child = yield* threadManagement.getThreadRecords(childThreadId, [
            "runs",
            "providerSessions",
          ]);
          const turnLive = child.runs.some(
            (run) =>
              run.status === "preparing" || run.status === "starting" || run.status === "running",
          );
          if (turnLive) return;
          for (const session of child.providerSessions) {
            if (session.status === "stopped" || session.status === "error") continue;
            yield* dispatch({
              type: "provider-session.detach",
              commandId: stableCommandId({
                operation: `cancel-task-provider-session:${session.id}`,
              }),
              threadId: childThreadId,
              providerSessionId: session.id,
              reason: "Delegated task closed.",
            });
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("task_cancel could not release the closed task's provider session", {
              taskId: input.taskId,
              cause,
            }),
          ),
        );
      });
      // Checked above; a user raising one of these threads meanwhile is
      // caught again under that thread's lock, which leaves it running.
      const refused = yield* Ref.make<DispatchModeRefusal | undefined>(undefined);
      const stopWithinLimit = stopChild.pipe(
        Effect.provideService(DispatchModeLimit, {
          runtimeMode: effective.runtimeMode,
          interactionMode: effective.interactionMode,
          refused,
        }),
        Effect.catch((error) =>
          Effect.flatMap(Ref.get(refused), (refusal) =>
            Effect.fail(
              refusal === undefined
                ? error
                : failure(
                    refusal.mode === "runtime"
                      ? "runtime_mode_escalation_denied"
                      : "interaction_mode_escalation_denied",
                    `Thread ${refusal.threadId} now runs in ${refusal.runtimeMode}/${refusal.interactionMode} mode, above this thread's; its user changed it while the task was being cancelled.`,
                  ),
            ),
          ),
        ),
      );
      // A follow-up that lost its child run stays running on the parent, while its status
      // here comes from the child's last run. Stop on the parent cancels that task.
      const cancelOrphan = Effect.gen(function* () {
        if (parentTask?.runId == null || !isOrchestrationV2WorkActive(parentTask.status))
          return false;
        yield* dispatch({
          type: "subagent.stop",
          commandId: stableCommandId({
            operation: "cancel-task-orphan",
          }),
          threadId: principal.ownerThreadId,
          runId: parentTask.runId,
          subagentId: parentTask.id,
        });
        const { subagents } = yield* threadManagement.getThreadRecords(
          principal.ownerThreadId,
          ["subagents"],
          { subagentIds: [input.taskId] },
        );
        return subagents.some((task) => task.id === input.taskId && task.status === "cancelled");
      }).pipe(Effect.mapError(threadManagementFailure));
      if (isTerminalTaskStatus(current.status)) {
        // The child can still run work for another turn, so it is stopped either way.
        yield* stopWithinLimit;
        const cancelled = yield* cancelOrphan;
        yield* disposeCompletionDelivery;
        return {
          taskId: input.taskId,
          status: cancelled ? ("cancelled" as const) : current.status,
        } satisfies OrchestratorMcpTaskCancelResult;
      }
      // A task waiting on its own delegates has work to stop below it. One with neither
      // a running turn nor delegates (such as one awaiting a restart) keeps its delivery.
      const child = yield* loadProjection(childThreadId);
      if (
        current.workState !== "waiting_for_children" &&
        ThreadManagementService.latestActiveRun(child) === undefined &&
        !child.runs.some(
          (run) =>
            run.status === "queued" &&
            (run.delegatedTaskId === input.taskId || run.id === current.childRunId),
        )
      ) {
        if (yield* cancelOrphan) return { taskId: input.taskId, status: "cancelled" as const };
        return yield* failure(
          "task_not_cancellable",
          `Delegated task ${input.taskId} has no interruptible child run.`,
        );
      }
      yield* stopWithinLimit;
      yield* disposeCompletionDelivery.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestrator-mcp.cancel-task.delivery-dispose-failed", {
            taskId: input.taskId,
            cause,
          }),
        ),
      );
      return {
        taskId: input.taskId,
        status: "cancel_requested" as const,
      };
    });
    return ManagedTaskControl.of({
      cancelWithinExclusive: cancel,
      cancel: Effect.fn("ManagedTaskControl.cancelExclusive")((principal, current) =>
        Option.isSome(policy)
          ? policy.value.exclusive(cancel(principal, current))
          : cancel(principal, current),
      ),
    });
  }),
);
