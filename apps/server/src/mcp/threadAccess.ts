import type {
  ProjectionRecordField,
  ProjectionRecordFilter,
} from "../orchestration-v2/ProjectionStore.ts";
import {
  CommandId,
  type EnvironmentId,
  OrchestratorMcpFailure,
  type ProjectId,
  type AgentTaskBinding,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type RuntimeMode,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import {
  hasThreadLinks,
  parseThreadLinkHref,
  threadLinkCandidates,
  threadLinkRefs,
} from "@t3tools/shared/threadLinks";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";

import type { OrchestratorV2Error } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { resolveInteractionMode, resolveRuntimeMode } from "./delegatedTaskModes.ts";
import { fencingLinkOrigin } from "./linkOrigin.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

const delegatedTaskPrefix = "thread:delegated-task:";

const suggestedThreadId = (threadId: ThreadId) => {
  if (!threadId.startsWith(delegatedTaskPrefix)) return ThreadId.make(`mcp:${threadId}`);
  const rest = threadId.slice(delegatedTaskPrefix.length);
  // encodeURIComponent throws on lone surrogates, which a JSON string can carry.
  if (!rest.isWellFormed()) return null;
  const encoded = encodeURIComponent(rest);
  return encoded === rest ? null : ThreadId.make(`${delegatedTaskPrefix}${encoded}`);
};

// A pasted link (bare, Markdown, or hosted) names its thread; only this environment's can be read here.
const candidateThreadIds = (threadId: ThreadId, environmentId: EnvironmentId) => {
  if (!hasThreadLinks(threadId)) {
    const suggested = suggestedThreadId(threadId);
    return suggested === null ? [] : [suggested];
  }
  const link = parseThreadLinkHref(threadId);
  const refs =
    link === null
      ? threadLinkRefs(threadId, environmentId)
      : threadLinkCandidates(link, environmentId);
  return refs.filter((ref) => ref.environmentId === environmentId).map((ref) => ref.threadId);
};

/**
 * Agents paste bare uuids for `mcp:<uuid>` threads, unencoded delegated-task ids, and thread links.
 * The id is never rewritten, so permission checks keyed on it still hold; the miss
 * only names a live thread the caller could read by its full id. Ids from another
 * machine miss here too. The link hint is static: listing links probes peers.
 */
export const threadNotFound = Effect.fn("OrchestratorMcpService.threadNotFound")(function* (
  threads: Pick<ThreadManagement.ThreadManagementService["Service"], "getThreadShell">,
  scope: McpInvocationContext.McpInvocationScope,
  threadId: ThreadId,
  message: string,
) {
  let suggested: ThreadId | null = null;
  for (const candidate of candidateThreadIds(threadId, scope.environmentId)) {
    const shell = yield* threads.getThreadShell(candidate).pipe(Effect.orElseSucceed(() => null));
    if (shell !== null && shell.deletedAt === null) {
      suggested = candidate;
      break;
    }
  }
  if (suggested !== null && hasThreadLinks(threadId)) {
    return yield* new OrchestratorMcpFailure({
      code: "thread_not_found",
      message: `\`${threadId}\` is a thread link, not a thread id. Pass \`${suggested}\` instead.`,
    });
  }
  const mcpHint = suggested === null ? "" : ` Did you mean \`${suggested}\`?`;
  const caller =
    scope.thread === undefined
      ? null
      : yield* threads.getThreadShell(scope.thread.threadId).pipe(Effect.orElseSucceed(() => null));
  // A peer link's caller would be pointed at this machine's links, and a fenced one may not use them.
  const linksHint =
    scope.linkedEnvironments === false ||
    scope.client?.linked === true ||
    fencingLinkOrigin({ scope, caller: caller ?? undefined }) !== undefined
      ? ""
      : " Thread ids belong to one environment: for a thread on a linked one, find it with `t3_environment_links` and pass its `environmentId` to a tool that takes one.";
  return yield* new OrchestratorMcpFailure({
    code: "thread_not_found",
    message: `${message}${mcpHint}${linksHint}`,
  });
});

export const unavailable = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "The operation could not be completed.",
  });

export const dispatchFailure = (
  error: OrchestratorV2Error | ThreadManagement.ThreadManagementProviderInstanceDisabledError,
) =>
  error._tag === "ThreadManagementProviderInstanceDisabledError" ||
  error._tag === "OrchestratorRuntimeModeAboveCeilingError" ||
  error._tag === "OrchestratorProviderSelectionBusyError"
    ? new OrchestratorMcpFailure({ code: "invalid_request", message: error.message })
    : (error._tag === "OrchestratorDispatchError" ||
          error._tag === "OrchestratorCommandRejectedError") &&
        typeof error.cause === "string" &&
        error.cause.length > 0
      ? new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: Array.from(error.cause).slice(0, 1000).join(""),
        })
      : unavailable();

export interface CallerLimits {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

export interface Caller {
  readonly scope: McpInvocationContext.McpInvocationScope;
  readonly threads: ThreadManagement.ThreadManagementService["Service"];
  readonly caller: OrchestrationV2ThreadShell | undefined;
  readonly limits: CallerLimits;
}

export const readCaller = Effect.fn("mcp.readCaller")(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (!scope.capabilities.has("orchestration")) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential cannot control threads.",
    });
  }
  return yield* loadCaller();
});

export const loadCaller = Effect.fn("mcp.loadCaller")(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const threads = yield* ThreadManagement.ThreadManagementService;
  if (scope.thread === undefined) {
    return {
      scope,
      threads,
      caller: undefined,
      limits: McpInvocationContext.clientModeCeiling(scope.client),
    } satisfies Caller;
  }
  const caller = yield* threads
    .getThreadShell(scope.thread.threadId)
    .pipe(Effect.mapError(unavailable));
  if (caller === null || caller.deletedAt !== null) {
    return yield* new OrchestratorMcpFailure({
      code: "thread_not_found",
      message: "The calling thread was not found.",
    });
  }
  return {
    scope,
    threads,
    caller,
    limits: { runtimeMode: caller.runtimeMode, interactionMode: caller.interactionMode },
  } satisfies Caller;
});

const MAX_DELEGATION_DEPTH = 2;

/**
 * How many delegations a thread sits below a top-level thread. Counts `subagent` edges from the
 * server's lineage, starting from the depth a linked environment stated for a task it delegated
 * here; a fork sits at its source's depth. A launched thread has no parent, so it starts a fresh
 * count, visible in the sidebar.
 */
export const delegationDepth = Effect.fn("mcp.delegationDepth")(function* (
  threads: Pick<ThreadManagement.ThreadManagementService["Service"], "getThreadShell">,
  shell: Pick<OrchestrationV2ThreadShell, "id" | "lineage" | "delegatedFrom">,
) {
  const seen = new Set<ThreadId>([shell.id]);
  let depth = 0;
  let current: Pick<OrchestrationV2ThreadShell, "lineage" | "delegatedFrom"> = shell;
  while (true) {
    const lineage = current.lineage;
    if (lineage.parentThreadId === null) {
      depth += current.delegatedFrom?.depth ?? 0;
      break;
    }
    if (lineage.relationshipToParent === "subagent") depth += 1;
    if (depth >= MAX_DELEGATION_DEPTH || seen.has(lineage.parentThreadId)) break;
    seen.add(lineage.parentThreadId);
    const parent = yield* threads
      .getThreadShell(lineage.parentThreadId)
      .pipe(Effect.mapError(unavailable));
    if (parent === null) return yield* unavailable();
    current = parent;
  }
  return depth;
});

/** Refuses a thread already two delegations below a top-level thread, by every route that starts another agent. */
export const assertBelowDelegationLimit = Effect.fn("mcp.assertBelowDelegationLimit")(function* (
  threads: Pick<ThreadManagement.ThreadManagementService["Service"], "getThreadShell">,
  shell: Pick<OrchestrationV2ThreadShell, "id" | "lineage" | "delegatedFrom">,
) {
  if ((yield* delegationDepth(threads, shell)) >= MAX_DELEGATION_DEPTH)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message:
        "This thread is at the delegation limit, two levels below a top-level thread, so it can't delegate, launch or schedule. Do the work yourself, or say in your result what is left for the thread that delegated you.",
    });
});

/**
 * An agent inside a thread must say why a new top-level thread beats a delegated
 * child; an outside client, with no calling thread, needs no reason.
 */
export const requireWhyNotDelegated = (
  caller: { readonly id: ThreadId } | undefined,
  whyNotDelegated: string | undefined,
): Effect.Effect<void, OrchestratorMcpFailure> =>
  caller === undefined || (whyNotDelegated !== undefined && whyNotDelegated.trim() !== "")
    ? Effect.void
    : Effect.fail(
        new OrchestratorMcpFailure({
          code: "invalid_request",
          message:
            "Is this better as a delegated task? Use `delegate_task` for work this thread owns, including a whole Spec in another project (`implementer` with forgeItem). If it must be its own thread, say why in `whyNotDelegated`.",
        }),
      );

/** The reason is logged on the server: no thread record carries it and none should. */
export const logWhyNotDelegated = (input: {
  readonly launchedFrom: ThreadId;
  readonly threadId: ThreadId;
  readonly whyNotDelegated: string | undefined;
}) =>
  input.whyNotDelegated === undefined
    ? Effect.void
    : Effect.logInfo("orchestrator-mcp.thread.launched-instead-of-delegated", {
        launchedFrom: input.launchedFrom,
        threadId: input.threadId,
        whyNotDelegated: input.whyNotDelegated,
      });

export const assertTargetWithinLimits = (
  limits: CallerLimits,
  target: Pick<OrchestrationV2ThreadShell, "id" | "runtimeMode" | "interactionMode">,
) =>
  resolveRuntimeMode(limits.runtimeMode, target.runtimeMode).pipe(
    Effect.andThen(resolveInteractionMode(limits.interactionMode, target.interactionMode)),
    Effect.asVoid,
    Effect.mapError(
      (error) =>
        new OrchestratorMcpFailure({
          code: error.code,
          message: `Thread "${target.id}" runs in ${target.runtimeMode}/${target.interactionMode}, above this caller's ${limits.runtimeMode}/${limits.interactionMode} limit. For linked calls, this limit is also capped by the link's approved access. This call does not create an approval request. Have the user act directly in the target thread through an authorized client.`,
        }),
    ),
  );

/** Background subagents retain credentials until provider exit; archived threads and other instances cannot act. */
export const isLiveCallerShell = (
  shell: Pick<
    OrchestrationV2ThreadShell,
    "archivedAt" | "activeRunId" | "providerInstanceId" | "pendingBackgroundTasks"
  > | null,
  providerInstanceId: ProviderInstanceId | undefined,
) =>
  shell !== null &&
  shell.archivedAt === null &&
  shell.providerInstanceId === providerInstanceId &&
  (shell.activeRunId !== null ||
    (shell.pendingBackgroundTasks?.some(
      (task) => task.kind === "subagent" && task.providerInstanceId === providerInstanceId,
    ) ??
      false));

/** Thread callers need a live run or its background subagent in an unarchived thread. OAuth clients rely on their session and ceiling. */
export function assertLiveCaller({ caller, scope }: Caller) {
  if (caller === undefined) return Effect.void;
  return isLiveCallerShell(caller, scope.thread?.providerInstanceId)
    ? Effect.void
    : Effect.fail(
        new OrchestratorMcpFailure({
          code: "parent_not_active",
          message: "The calling provider no longer owns an active thread run.",
        }),
      );
}

export const assertFullAccess = (context: Caller, message: string) =>
  context.limits.runtimeMode === "full-access" && context.limits.interactionMode === "default"
    ? Effect.void
    : Effect.fail(new OrchestratorMcpFailure({ code: "capability_denied", message }));

export const resolveProjectId = (context: Caller, projectId: ProjectId | undefined) =>
  projectId !== undefined
    ? Effect.succeed(projectId)
    : context.caller !== undefined
      ? Effect.succeed(context.caller.projectId)
      : Effect.fail(
          new OrchestratorMcpFailure({
            code: "target_required",
            message: "Pass projectId: this MCP client is not running inside a T3 thread.",
          }),
        );

const resolveThreadId = (context: Caller, threadId: ThreadId | undefined) =>
  threadId !== undefined
    ? Effect.succeed(threadId)
    : context.caller !== undefined
      ? Effect.succeed(context.caller.id)
      : Effect.fail(
          new OrchestratorMcpFailure({
            code: "target_required",
            message: "Pass threadId: this MCP client is not running inside a T3 thread.",
          }),
        );

export const readThread = Effect.fn("mcp.readThread")(function* <
  K extends ProjectionRecordField = never,
>(threadId?: ThreadId, fields: ReadonlyArray<K> = [], filter?: ProjectionRecordFilter) {
  const context = yield* readCaller();
  const targetId = yield* resolveThreadId(context, threadId);
  const shell = yield* context.threads.getThreadShell(targetId).pipe(Effect.mapError(unavailable));
  if (shell === null || shell.deletedAt !== null) {
    return yield* threadNotFound(
      context.threads,
      context.scope,
      targetId,
      "The thread was not found.",
    );
  }
  yield* assertExternalWorkOwner(context.scope, shell);
  const projection = yield* context.threads
    .getProjectThreadRecords({ projectId: shell.projectId, threadId: targetId }, fields, {
      turnItemTypes: ["user_input_request"],
      ...filter,
    })
    .pipe(
      Effect.mapError((error) =>
        error._tag === "ThreadManagementThreadNotFoundError"
          ? new OrchestratorMcpFailure({
              code: "thread_not_found",
              message: "The thread was not found.",
            })
          : unavailable(),
      ),
    );
  return { ...context, projection };
});

export const newCommandId = Effect.fn("mcp.newCommandId")(function* () {
  const random = yield* SecureRandom.SecureRandom;
  return CommandId.make(`mcp:${yield* random.uuidV4()}`);
});

/** External work remains private to the approved OAuth session, including raw thread tools. */
export const canReadExternalWork = (
  scope: McpInvocationContext.McpInvocationScope,
  target: {
    readonly id: ThreadId;
    readonly agentTask?: AgentTaskBinding | undefined;
  },
): boolean => {
  const owner = target.agentTask?.externalOwner;
  return (
    owner === undefined ||
    scope.thread?.threadId === target.id ||
    (scope.client?.sessionId === owner.clientSessionId &&
      scope.environmentId === owner.environmentId)
  );
};
export const assertExternalWorkOwner = (
  scope: McpInvocationContext.McpInvocationScope,
  target: {
    readonly id: ThreadId;
    readonly agentTask?: AgentTaskBinding | undefined;
  },
) =>
  canReadExternalWork(scope, target)
    ? Effect.void
    : Effect.fail(
        new OrchestratorMcpFailure({
          code: "task_not_found",
          message: "The requested work is not owned by this caller.",
        }),
      );
