import * as VideoFrames from "../videoFrames/VideoFrames.ts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import {
  CommandId,
  latestProviderTurnForAttempt,
  resolveClaudeCompactionSetting,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2ReplacedWorkspaceOutcome,
  type OrchestrationV2TurnItem,
  type ProjectId,
  RunId,
  TextGenerationError,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  hostReleaseRunner,
  isSlipJayWorkspacePath,
  restoreSlipJayWorkspace,
  unresolvedRelease,
} from "../slipJayRelease.ts";

import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ServerConfig from "../config.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeIsManagedWorktreePath } from "../worktreesDirectory.ts";
import * as EventSink from "./EventSink.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import { planClaudeCompaction } from "./ClaudeCompactionPlan.ts";
import {
  clampCompactionSummary,
  COMPACTION_SUMMARY_MAX_BYTES,
  DEFAULT_COMPACTION_WINDOW_TOKENS,
  renderCompactionTranscript,
} from "./CompactionTranscript.ts";
import {
  DEFAULT_HANDOFF_TOKEN_CAP,
  handoffTokenCapConfig,
  handoffBudget,
  attachmentTokenAllowance,
  contextUsageForHandoff,
  historicalMessage,
  latestNativeContextUsage,
} from "@t3tools/provider-core/server/handoffBudget";
import { deliverContextHandoffs } from "./ContextHandoffDelivery.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import {
  knownProviderFailureMessage,
  makeProviderFailure,
} from "@t3tools/provider-core/server/failure";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import {
  isRestartNoteContinuation,
  pendingRestartCancelledBackgroundWork,
  restartCancelledBackgroundWorkNote,
} from "./RestartBackgroundNote.ts";
import { SCHEDULED_TASK_NOTE, SCHEDULED_TASK_PROMPT_LABEL } from "./ScheduledTaskPrompt.ts";

/** Sent with each side chat turn; the side chat card is narrow and meant for quick answers. */
export const SIDE_CHAT_NOTE =
  "This is a side chat: the user is asking a quick question beside the main conversation. Be extra concise unless the user asks for more detail.";

/**
 * Sent with each turn of a No project chat until its agent suggests a project,
 * so it can offer a better home for the chat once one is clear.
 */
export const NO_PROJECT_NOTE =
  "This chat is in No project: it runs in its own scratch folder and cannot see project code. When the user's request is work in one of their projects (t3_project_list), call t3_thread_move_to_project with that project before doing the work, then end your turn; this chat moves into the project and T3 starts its next turn there with the conversation carried over. Pass continuationPrompt only for a one-sentence next step the conversation does not already say, never a summary or handoff of the work so far. When the work spans projects, move into the one holding most of it and attach the others with t3_worktree_attach. When the fit is likely but unclear, call t3_thread_suggest_project once with a one-line reason instead; the user then chooses Move or Keep.";

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"];

/** One of a thread's workspaces, as the workspaces note lists it. */
export interface TurnWorkspace {
  readonly project: string;
  readonly path: string;
  readonly branch: string | null;
  readonly role: "primary" | "attached" | "released";
  readonly instructionFiles: ReadonlyArray<string>;
}

/**
 * Managed agents cannot rely on inherited configuration to load workspace instructions.
 */
const workspacesNote = (workspaces: ReadonlyArray<TurnWorkspace>, managed = false): string =>
  [
    managed
      ? "This thread works in these workspaces. Read a workspace's instruction files before working there."
      : "This thread works in these workspaces. Read a workspace's instruction files before working there, and land each repository from its own workspace.",
    ...workspaces.map((workspace) => {
      const role =
        workspace.role === "primary"
          ? "primary, where this session runs"
          : workspace.role === "attached"
            ? "attached"
            : "released by SlipJay; attach a fresh workspace to work in this project again";
      const branch = workspace.branch === null ? "" : ` on ${workspace.branch}`;
      const instructions =
        workspace.instructionFiles.length === 0
          ? ""
          : `; instructions: ${workspace.instructionFiles.join(", ")}`;
      return `- ${workspace.project} (${role}): ${workspace.path}${branch}${instructions}`;
    }),
  ].join("\n");

/**
 * Sent with the turn that runs in a SlipJay workspace allocated after SlipJay removed the
 * thread's previous one, which it does only once that workspace holds no unlanded work.
 */
export const replacedWorkspaceNote = (
  workspacePath: string,
  outcome: OrchestrationV2ReplacedWorkspaceOutcome,
  detail?: string,
): string => {
  const where =
    outcome === "fresh"
      ? `This turn runs in a fresh checkout at the integration head: ${workspacePath}.`
      : outcome === "resumed"
        ? `This turn runs in an existing workspace that SlipJay resumed rather than created: ${workspacePath}. It may hold work from earlier sessions, so check its state before assuming it is at the integration head.`
        : `This turn runs in ${workspacePath}. SlipJay did not say whether it created that checkout or resumed an existing one, so check its state before assuming it is fresh at the integration head.`;
  return `SlipJay removed this thread's previous workspace while it was idle; it held no unlanded work. ${where} Work landed from earlier turns is on the integration branch; read the workspace's instruction files before working.${detail === undefined ? "" : ` ${detail}`}`;
};

/**
 * Sent instead when no replacement could be allocated, so the turn runs in the project's own
 * checkout, which other threads share.
 */
export const unreplacedWorkspaceNote = (
  checkout: string,
  detail?: string,
  forgeItem?: number,
): string =>
  `SlipJay removed this thread's previous workspace while it was idle; it held no unlanded work. T3 could not allocate a fresh one${detail === undefined ? "" : ` (${detail})`}, so this turn runs in the project's own checkout: ${checkout}. Before changing any files, allocate a workspace (\`slipjay start --integration --json "<task>"\`) and move this thread into it with t3_worktree_handoff.${
    forgeItem === undefined
      ? ""
      : ` This thread works under Build item #${forgeItem}: attach it to that workspace with \`slipjay attach-issue ${forgeItem}\`.`
  }`;

/**
 * The checkout a turn starts in when T3 replaced the thread's removed SlipJay workspace and no
 * turn has run since: a fresh workspace from this turn's own preparation or from a terminal that
 * opened first, or null when no replacement could be allocated and the turn runs on the project.
 * Null without a replacement to report.
 */
export const replacedWorkspace = (
  thread: Pick<
    OrchestrationV2AppThread,
    "worktreePath" | "workspaceReplacedAt" | "workspaceReplacement" | "workspaceIssue"
  >,
  attempts: ReadonlyArray<Pick<OrchestrationV2RunAttempt, "id" | "runId" | "startedAt">>,
  providerTurns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "runAttemptId">>,
  runId: RunId,
): {
  readonly worktreePath: string | null;
  readonly outcome: OrchestrationV2ReplacedWorkspaceOutcome;
  readonly detail?: string;
  /** The Build item a thread left on the project checkout still works under. */
  readonly forgeItem?: number;
} | null => {
  const replacedAt = thread.workspaceReplacedAt;
  if (replacedAt == null) return null;
  // Another run's attempt since the replacement already said so, but only if its provider
  // took the prompt: a provider turn exists once the provider reports one.
  const told = new Set(providerTurns.map((turn) => turn.runAttemptId));
  const toldEarlier = attempts.some(
    (attempt) =>
      attempt.runId !== runId &&
      attempt.startedAt !== null &&
      DateTime.toEpochMillis(attempt.startedAt) >= DateTime.toEpochMillis(replacedAt) &&
      told.has(attempt.id),
  );
  const detail = thread.workspaceReplacement?.detail;
  const recorded = thread.workspaceReplacement?.outcome;
  // A thread replaced before outcomes were recorded was a fresh allocation; "unavailable" has
  // no workspace to describe.
  const outcome = recorded === undefined || recorded === "unavailable" ? "fresh" : recorded;
  const forgeItem = thread.worktreePath === null ? thread.workspaceIssue : undefined;
  return toldEarlier
    ? null
    : {
        worktreePath: thread.worktreePath,
        outcome,
        ...(detail === undefined ? {} : { detail }),
        ...(forgeItem == null ? {} : { forgeItem }),
      };
};

export class ProviderTurnStartError extends Schema.TaggedError<ProviderTurnStartError>()(
  "ProviderTurnStartError",
  {
    runId: RunId,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isProviderTurnStartError = Schema.is(ProviderTurnStartError);
const isTextGenerationError = Schema.is(TextGenerationError);

/**
 * Claude refuses these before it reads the prompt: replacing a process running background work,
 * or launch arguments whose appended system prompt cannot be read.
 */
const PROMPT_REFUSAL_TAGS = [
  "ClaudeBackgroundWorkBlocksQueryReplacementError",
  "ClaudeAppendSystemPromptFileError",
  "ClaudeAppendSystemPromptMissingValueError",
] as const;

const refusedBeforePrompt = (error: unknown): boolean =>
  PROMPT_REFUSAL_TAGS.some((tag) => Predicate.isTagged(error, tag)) ||
  (Predicate.hasProperty(error, "cause") && refusedBeforePrompt(error.cause));

export interface ProviderTurnStartServiceV2Shape {
  readonly start: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly willRetry?: boolean;
  }) => Effect.Effect<void, ProviderTurnStartError>;
}

export class ProviderTurnStartServiceV2 extends Context.Service<
  ProviderTurnStartServiceV2,
  ProviderTurnStartServiceV2Shape
>()("t3/orchestration-v2/ProviderTurnStartService/ProviderTurnStartServiceV2") {}

export const layer: Layer.Layer<
  ProviderTurnStartServiceV2,
  never,
  | EventSink.EventSinkV2
  | ContextHandoffService.ContextHandoffServiceV2
  | IdAllocator.IdAllocatorV2
  | FileSystem.FileSystem
  | Path.Path
  | ServerConfig.ServerConfig
  | ServerSettings.ServerSettingsService
  | GitWorkflowService.GitWorkflowService
  | ProjectService.ProjectService
  | ProviderAuthService.ProviderAuthService
  | ProviderInstanceRegistry.ProviderInstanceRegistry
  | ProjectionStore.ProjectionStoreV2
  | ProviderSessionManager.ProviderSessionManagerV2
  | RunExecutionService.RunExecutionServiceV2
  | RuntimePolicy.RuntimePolicyV2
  | VideoFrames.VideoFrames
> = Layer.effect(
  ProviderTurnStartServiceV2,
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const contextHandoffService = yield* ContextHandoffService.ContextHandoffServiceV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig.ServerConfig;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
    const projects = yield* ProjectService.ProjectService;
    const providerAuth = yield* ProviderAuthService.ProviderAuthService;
    const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
    const runtimePolicy = yield* RuntimePolicy.RuntimePolicyV2;
    const videoFramesService = yield* VideoFrames.VideoFrames;
    const isManagedWorktreePath = yield* makeIsManagedWorktreePath;

    // Build draining callbacks outside startup scope so they cannot retain full thread history.
    const makeRunControls = (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly attemptId: OrchestrationV2RunAttempt["id"];
      readonly providerThreadId: OrchestrationV2ProviderThread["id"];
      readonly runOrdinal: number;
      readonly projectId: ProjectId;
      readonly worktreePath: string | null;
      readonly inheritedBackgroundTurnItems: ReturnType<
        typeof RunExecutionService.selectInheritedBackgroundTurnItems
      >;
    }) => {
      const isCurrentAttemptInStatus = (expectedStatus: OrchestrationV2Run["status"]) =>
        projectionStore.getRuntimeRecoveryProjection(input.threadId).pipe(
          Effect.map((current) => {
            const run = current.runs.find((candidate) => candidate.id === input.runId);
            return run?.activeAttemptId === input.attemptId && run.status === expectedStatus;
          }),
        );
      return {
        isCurrentAttemptInStatus,
        loadInheritedBackgroundTurnItems: () =>
          projectionStore.getRuntimeRecoveryProjection(input.threadId).pipe(
            Effect.map((current) =>
              RunExecutionService.selectInheritedBackgroundTurnItems({
                threadId: input.threadId,
                currentProviderThreadId: input.providerThreadId,
                currentRunOrdinal: input.runOrdinal,
                runs: current.runs,
                turnItems: current.turnItems,
              }),
            ),
            Effect.catchCause(() => Effect.succeed(input.inheritedBackgroundTurnItems)),
          ),
        shouldStartProviderTurn: () => isCurrentAttemptInStatus("running"),
        shouldFinalizeRun: () =>
          projectionStore.getRuntimeRecoveryProjection(input.threadId).pipe(
            Effect.map((current) => {
              const run = current.runs.find((candidate) => candidate.id === input.runId);
              return (
                run?.activeAttemptId === input.attemptId &&
                (run.status === "starting" || run.status === "running")
              );
            }),
          ),
        hasUnpairedRunInterruptRequest: () =>
          projectionStore
            .hasUnpairedRunInterruptRequest(
              input.threadId,
              idAllocator.derive.runSignalTurnItem({
                runId: input.runId,
                signal: "interrupt-request",
              }),
              idAllocator.derive.runSignalTurnItem({
                runId: input.runId,
                signal: "interrupt-result",
              }),
            )
            .pipe(Effect.catchCause(() => Effect.succeed(false))),
        // A move detaches the session mid-turn; the run says where the thread went
        // rather than blaming the user.
        movedTo: () =>
          projectionStore.getThreadShell(input.threadId).pipe(
            Effect.flatMap((thread) =>
              thread === null
                ? Effect.succeed(undefined)
                : thread.projectId !== input.projectId
                  ? projects.getById(thread.projectId).pipe(
                      Effect.map((project) =>
                        Option.match(project, {
                          onNone: () => "Moved to another project",
                          onSome: ({ title }) => `Moved to project ${title}`,
                        }),
                      ),
                    )
                  : thread.worktreePath !== input.worktreePath
                    ? Effect.succeed(
                        thread.worktreePath === null
                          ? "Moved to the project root"
                          : `Moved to workspace ${path.basename(thread.worktreePath)}`,
                      )
                    : Effect.succeed(undefined),
            ),
            Effect.catchCause(() => Effect.succeed(undefined)),
          ),
        loadRunInterruptReason: () =>
          projectionStore
            .getThreadRecords(input.threadId, ["turnItems"], {
              turnItemTypes: ["run_interrupt_request"],
              turnItemRunIds: [input.runId],
            })
            .pipe(
              Effect.map(({ turnItems }) => {
                const request = turnItems.find((item) => item.type === "run_interrupt_request");
                return request?.type === "run_interrupt_request" ? request.message : undefined;
              }),
              Effect.catchCause(() => Effect.succeed(undefined)),
            ),
      };
    };

    const makeDeliverySession = (
      session: ProviderAdapter.ProviderAdapterV2SessionRuntime,
      startWithHandoffs: (
        input: Parameters<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>[0],
        compact?: boolean,
      ) => ReturnType<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>,
    ) => {
      let deliver: typeof startWithHandoffs | undefined = startWithHandoffs;
      const start = (
        input: Parameters<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>[0],
        compact = false,
      ) =>
        Effect.suspend(() => {
          if (deliver !== undefined) return deliver(input, compact);
          return compact && session.compactThread !== undefined
            ? session.compactThread(input)
            : session.startTurn(input);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              deliver = undefined;
            }),
          ),
        );
      return {
        ...session,
        startTurn: (input: Parameters<typeof session.startTurn>[0]) => start(input),
        ...(session.compactThread === undefined
          ? {}
          : {
              compactThread: (input: Parameters<typeof session.startTurn>[0]) => start(input, true),
            }),
      };
    };

    const start = Effect.fn("orchestrationV2.providerTurnStart.start")(function* (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly willRetry?: boolean;
    }) {
      const { runId } = input;
      const projection = yield* projectionStore.getTurnStartContext(input.threadId, runId);
      const run = projection.runs.find((candidate) => candidate.id === runId);
      if (run === undefined) {
        return yield* new ProviderTurnStartError({ runId, cause: `Run ${runId} was not found.` });
      }
      if (run.status !== "starting") {
        return;
      }
      const rootNode = projection.nodes.find((candidate) => candidate.id === run.rootNodeId);
      const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId);
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === run.providerThreadId,
      );
      const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
      const checkpointScope = projection.checkpointScopes.find(
        (candidate) => candidate.id === rootNode?.checkpointScopeId,
      );
      // Older versions also stored subagent replies as history handoffs. Their
      // queued completion messages carry the results without a history budget.
      const subagentResultTransfers = new Set(
        projection.contextTransfers
          .filter((transfer) => transfer.type === "subagent_result")
          .map((transfer) => transfer.id),
      );
      const handoffs = projection.contextHandoffs.filter(
        (handoff) =>
          (handoff.transferId == null || !subagentResultTransfers.has(handoff.transferId)) &&
          handoff.status === "ready" &&
          (handoff.targetRunId === run.id ||
            (handoff.toProviderThreadId === run.providerThreadId &&
              projection.runs.some(
                (source) =>
                  source.id === handoff.targetRunId &&
                  (source.status === "failed" ||
                    source.status === "interrupted" ||
                    (source.status === "completed" &&
                      handoff.delivery === undefined &&
                      projection.messages.some(
                        (message) =>
                          message.id === source.userMessageId &&
                          message.attachments.length === 0 &&
                          message.text.trim().toLowerCase() === "/compact",
                      ))),
              ))),
      );
      const nativeForkTransfer = projection.contextTransfers.find(
        (transfer) =>
          transfer.type === "fork" &&
          transfer.targetThreadId === input.threadId &&
          transfer.targetRunId === run.id &&
          transfer.status === "pending" &&
          transfer.resolution === null,
      );
      if (
        rootNode === undefined ||
        attempt === undefined ||
        providerThread === undefined ||
        providerThread.providerSessionId === null ||
        message === undefined ||
        checkpointScope === undefined
      ) {
        return yield* new ProviderTurnStartError({
          runId,
          cause: `Run ${runId} is missing its execution projection state.`,
        });
      }
      const settleRunBeforeStart = Effect.fn("orchestrationV2.providerTurnStart.settleBeforeStart")(
        function* (input: {
          readonly signal: string;
          readonly status: "completed" | "failed";
          readonly now: DateTime.Utc;
          readonly startedAt?: DateTime.Utc;
          readonly providerInstanceId: OrchestrationV2Run["providerInstanceId"];
          readonly itemProviderThreadId: OrchestrationV2ProviderThread["id"];
          readonly item:
            | Pick<
                Extract<OrchestrationV2TurnItem, { type: "error" }>,
                "type" | "title" | "failure"
              >
            | Pick<
                Extract<OrchestrationV2TurnItem, { type: "command_execution" }>,
                "type" | "title" | "input" | "output" | "exitCode"
              >
            | Pick<
                Extract<OrchestrationV2TurnItem, { type: "compaction" }>,
                | "type"
                | "driver"
                | "title"
                | "summary"
                | "model"
                | "beforeTokenCount"
                | "afterTokenCount"
                | "windowTooSmall"
              >;
          readonly providerThreadUpdate?: OrchestrationV2ProviderThread;
          /** A handoff this run leaves behind, written with the run's own events. */
          readonly handoff?: OrchestrationV2ContextHandoff;
        }) {
          const { now, status } = input;
          const started = input.startedAt === undefined ? {} : { startedAt: input.startedAt };
          const item: OrchestrationV2TurnItem = {
            id: idAllocator.derive.runSignalTurnItem({ runId, signal: input.signal }),
            threadId: projection.thread.id,
            runId,
            nodeId: rootNode.id,
            providerThreadId: input.itemProviderThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal:
              Math.max(
                0,
                ...projection.turnItems
                  .filter((item) => item.runId === runId)
                  .map((item) => item.ordinal),
              ) + 1,
            status,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            ...input.item,
          };
          const eventPayloads = [
            { type: "turn-item.updated", payload: item },
            ...(input.handoff === undefined
              ? []
              : [{ type: "context-handoff.updated" as const, payload: input.handoff }]),
            { type: "run.updated", payload: { ...run, status, ...started, completedAt: now } },
            {
              type: "run-attempt.updated",
              payload: { ...attempt, status, ...started, completedAt: now },
            },
            {
              type: "node.updated",
              payload: { ...rootNode, status, ...started, completedAt: now },
            },
            ...(input.providerThreadUpdate === undefined
              ? []
              : [
                  {
                    type: "provider-thread.updated" as const,
                    payload: input.providerThreadUpdate,
                  },
                ]),
          ] as const;
          const events = yield* Effect.forEach(eventPayloads, (event) =>
            Effect.gen(function* () {
              return {
                ...event,
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                threadId: projection.thread.id,
                runId,
                nodeId: rootNode.id,
                providerInstanceId: input.providerInstanceId,
                occurredAt: now,
              } satisfies OrchestrationV2DomainEvent;
            }),
          );
          yield* eventSink.writeIfRunCurrent({
            threadId: projection.thread.id,
            runId,
            activeAttemptId: attempt.id,
            expectedStatus: "starting",
            events,
          });
        },
      );
      if (message.attachments.length === 0 && message.text.trimStart().startsWith("/")) {
        const isEmptyCompaction =
          message.text.trim().toLowerCase() === "/compact" && !projection.hasConversation;
        // Preparation may select a new provider; account commands still target the last native session.
        const nativeThreads = new Map(
          projection.providerThreads
            .filter(
              (candidate) => candidate.ownerNodeId === null && candidate.nativeThreadRef !== null,
            )
            .map((candidate) => [candidate.id, candidate]),
        );
        const previousNativeRun = projection.runs.reduce<OrchestrationV2Run | undefined>(
          (previous, candidate) =>
            candidate.ordinal < run.ordinal &&
            candidate.providerThreadId !== null &&
            nativeThreads.has(candidate.providerThreadId) &&
            (previous === undefined || candidate.ordinal > previous.ordinal)
              ? candidate
              : previous,
          undefined,
        );
        const nativeThread = nativeThreads.get(
          previousNativeRun?.providerThreadId ??
            projection.thread.activeProviderThreadId ??
            providerThread.id,
        );
        const authInstanceId = nativeThread?.providerInstanceId ?? run.providerInstanceId;
        const authResult = isEmptyCompaction
          ? null
          : yield* Effect.result(
              providerAuth.tryHandlePromptCommand({
                instanceId: authInstanceId,
                text: projectComposerContextForProvider({
                  text: message.text,
                  records: message.context?.records ?? [],
                }),
                hasAttachments: false,
              }),
            );
        if (isEmptyCompaction || authResult?._tag === "Failure" || authResult?.success) {
          const now = yield* DateTime.now;
          const failure = isEmptyCompaction
            ? makeProviderFailure({
                class: "validation_error",
                message: "Start a conversation before compacting this thread.",
              })
            : authResult?._tag === "Failure"
              ? makeProviderFailure({
                  class: "permission_error",
                  message: authResult.failure.detail,
                })
              : undefined;
          const status = failure === undefined ? "completed" : "failed";
          yield* settleRunBeforeStart({
            signal: isEmptyCompaction ? "empty-compaction" : "provider-sign-out",
            status,
            now,
            startedAt: now,
            providerInstanceId: authInstanceId,
            itemProviderThreadId: nativeThread?.id ?? providerThread.id,
            item:
              failure !== undefined
                ? {
                    type: "error",
                    title: isEmptyCompaction
                      ? "Cannot compact an empty thread"
                      : "Provider sign-out failed",
                    failure,
                  }
                : {
                    type: "command_execution",
                    title: "Provider signed out",
                    input: message.text.trim(),
                    output: "Provider signed out",
                    exitCode: 0,
                  },
            providerThreadUpdate: {
              ...providerThread,
              status: providerThread.nativeThreadRef === null ? "not_loaded" : "idle",
              updatedAt: now,
            },
          });
          return;
        }
      }
      const { worktreePath, branch } = projection.thread;
      const isSlipJayWorkspace =
        worktreePath !== null &&
        isSlipJayWorkspacePath(path.resolve(worktreePath), process.env.HOME ?? "", path.sep);
      if (worktreePath !== null && (branch !== null || isSlipJayWorkspace)) {
        const exists = yield* fileSystem
          .exists(worktreePath)
          .pipe(Effect.orElseSucceed(() => true));
        // A released SlipJay workspace comes back from its archive, never from the branch:
        // the branch has none of the files the thread wrote outside history.
        if (!exists && isSlipJayWorkspace) {
          const restored = yield* Effect.promise(() =>
            restoreSlipJayWorkspace({
              workspacePath: path.resolve(worktreePath),
              run: hostReleaseRunner,
            }),
          );
          if (restored.kind === "restored") {
            yield* Effect.logInfo("provider turn start restored a released SlipJay workspace", {
              threadId: projection.thread.id,
              worktreePath: restored.workspacePath,
            });
          }
          // No archive, or SlipJay could not restore it: leave the path missing so the run
          // fails visibly, instead of a checkout that silently lacks the thread's own files.
          yield* Effect.logWarning(
            "provider turn start could not restore a released SlipJay workspace",
            {
              threadId: projection.thread.id,
              worktreePath,
              reason: restored.kind === "unavailable" ? restored.reason : "unknown",
            },
          );
        }
        if (!exists && branch !== null && (yield* isManagedWorktreePath(worktreePath))) {
          const project = yield* projects.getById(projection.thread.projectId).pipe(
            Effect.map(Option.getOrUndefined),
            Effect.orElseSucceed(() => undefined),
          );
          if (project !== undefined) {
            yield* Effect.logWarning("provider turn start recreating missing worktree", {
              threadId: projection.thread.id,
              worktreePath,
              branch,
            });
            yield* gitWorkflow.pruneWorktrees({ cwd: project.workspaceRoot }).pipe(
              Effect.andThen(
                gitWorkflow.createWorktree({
                  cwd: project.workspaceRoot,
                  refName: branch,
                  path: worktreePath,
                }),
              ),
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.failCause(cause)
                  : Effect.logWarning("provider turn start failed to recreate worktree", {
                      threadId: projection.thread.id,
                      worktreePath,
                      cause: Cause.pretty(cause),
                    }),
              ),
            );
          }
        }
      }
      // A checkout whose release never finished must not be used: SlipJay recorded the
      // operation, and starting a turn on it would build on a half-removed workspace.
      if (worktreePath !== null && isSlipJayWorkspace) {
        const unresolved = yield* Effect.promise(() =>
          unresolvedRelease({
            workspacePath: path.resolve(worktreePath),
            threadId: projection.thread.id,
            settledAt:
              projection.thread.settledAt === null ? null : String(projection.thread.settledAt),
            run: hostReleaseRunner,
          }),
        );
        if (unresolved !== null) {
          const now = yield* DateTime.now;
          yield* settleRunBeforeStart({
            signal: "workspace-missing",
            status: "failed",
            now,
            providerInstanceId: run.providerInstanceId,
            itemProviderThreadId: providerThread.id,
            item: {
              type: "error",
              title: "Release unresolved",
              failure: makeProviderFailure({
                message: unresolved,
                code: "release_unresolved",
              }),
            },
          });
          return;
        }
      }
      // A provider never starts in a missing directory: it would run somewhere
      // else or fail without saying why. The run fails with the reason instead.
      if (
        worktreePath !== null &&
        !(yield* fileSystem.exists(worktreePath).pipe(Effect.orElseSucceed(() => true)))
      ) {
        const now = yield* DateTime.now;
        yield* settleRunBeforeStart({
          signal: "workspace-missing",
          status: "failed",
          now,
          providerInstanceId: run.providerInstanceId,
          itemProviderThreadId: providerThread.id,
          item: {
            type: "error",
            title: "Workspace missing",
            failure: makeProviderFailure({
              class: "validation_error",
              message: `The thread's workspace ${worktreePath} no longer exists.${
                projection.thread.agentTask === undefined
                  ? ""
                  : " T3 does not replace a delegated task's workspace, which belongs to the work that assigned it: ask its lead to assign the work again in a workspace of its own."
              }`,
            }),
          },
        });
        return;
      }
      const selectInheritedBackgroundItems = (
        current: ProjectionStore.ProjectionRuntimeRecoveryState,
      ): ReturnType<typeof RunExecutionService.selectInheritedBackgroundTurnItems> =>
        RunExecutionService.selectInheritedBackgroundTurnItems({
          threadId: current.thread.id,
          currentProviderThreadId: providerThread.id,
          currentRunOrdinal: run.ordinal,
          runs: current.runs,
          turnItems: current.turnItems,
        });
      const inheritedBackgroundTurnItems = yield* projectionStore
        .getRuntimeRecoveryProjection(projection.thread.id)
        .pipe(Effect.map(selectInheritedBackgroundItems));
      const providerSessionId = providerThread.providerSessionId;
      const runControls = makeRunControls({
        threadId: projection.thread.id,
        runId: run.id,
        attemptId: attempt.id,
        providerThreadId: providerThread.id,
        runOrdinal: run.ordinal,
        projectId: projection.thread.projectId,
        worktreePath: projection.thread.worktreePath,
        inheritedBackgroundTurnItems,
      });
      const { isCurrentAttemptInStatus } = runControls;

      const settleStartFailure = Effect.fn("ProviderTurnStartService.settleStartFailure")(
        function* (failed: {
          readonly signal: string;
          readonly title: string;
          readonly error: Error;
        }) {
          const nestedCause = "cause" in failed.error ? failed.error.cause : undefined;
          yield* settleRunBeforeStart({
            signal: failed.signal,
            status: "failed",
            now: yield* DateTime.now,
            providerInstanceId: run.providerInstanceId,
            itemProviderThreadId: providerThread.id,
            item: {
              type: "error",
              title: failed.title,
              failure: makeProviderFailure({
                cause: failed.error,
                message:
                  knownProviderFailureMessage(failed.error) ??
                  (nestedCause instanceof Error
                    ? nestedCause.message
                    : typeof nestedCause === "string"
                      ? nestedCause
                      : failed.error.message),
                class: "provider_error",
              }),
            },
          });
        },
      );
      // A managed task's workspace can change between dispatch and turn start, so run-start
      // validation can refuse it; the run must settle rather than sit in starting.
      const policyResult = yield* Effect.result(
        runtimePolicy.resolve({
          thread: projection.thread,
          modelSelection: run.modelSelection,
        }),
      );
      if (policyResult._tag === "Failure") {
        if (input.willRetry === true) return yield* policyResult.failure;
        yield* settleStartFailure({
          signal: "runtime-policy-resolve-failure",
          title: "Provider turn failed to start",
          error: policyResult.failure,
        });
        return;
      }
      const resolvedRuntimePolicy = policyResult.success;
      if (!(yield* isCurrentAttemptInStatus("starting"))) return;
      // The server cannot tell a typed /compact from compact-on-send or idle compaction, so all
      // of them follow the instance's "Compact with" setting.
      const compactionUsages = projection.providerTurns.flatMap((turn) =>
        turn.providerThreadId === providerThread.id && turn.tokenUsage !== undefined
          ? [turn.tokenUsage]
          : [],
      );
      const compactionPlan =
        providerThread.driver === "claudeAgent" &&
        message.attachments.length === 0 &&
        message.text.trim().toLowerCase() === "/compact"
          ? planClaudeCompaction({
              setting: resolveClaudeCompactionSetting(
                yield* serverSettings.getSettings.pipe(
                  Effect.orElseSucceed(() => ({ providerInstances: {} })),
                ),
                run.providerInstanceId,
              ),
              runInstanceId: run.providerInstanceId,
              modelSelection: run.modelSelection,
              usages: compactionUsages,
              nowMs: DateTime.toEpochMillis(yield* DateTime.now),
            })
          : ({ kind: "conversation" } as const);
      if (compactionPlan.kind === "summary") {
        const summariser = compactionPlan.modelSelection;
        const modelName = summariser.model;
        const busy =
          (providerThread.pendingBackgroundTasks ?? []).length > 0 ||
          projection.subagents.some(
            (subagent) =>
              subagent.providerThreadId === providerThread.id && subagent.status === "running",
          );
        const settledAt = yield* DateTime.now;
        if (busy) {
          yield* settleRunBeforeStart({
            signal: "compaction-session-busy",
            status: "failed",
            now: settledAt,
            startedAt: settledAt,
            providerInstanceId: run.providerInstanceId,
            itemProviderThreadId: providerThread.id,
            item: {
              type: "error",
              title: `Cannot compact with ${modelName} while this thread's work is running`,
              failure: makeProviderFailure({
                class: "validation_error",
                message: `Stop this thread's background work, then compact again. A compaction on ${modelName} replaces the conversation's session, which the running work is using.`,
              }),
            },
          });
          return;
        }
        const summaryResult = yield* Effect.result(
          Effect.gen(function* () {
            const summariserInstance = yield* providerInstances.getInstance(summariser.instanceId);
            if (summariserInstance === undefined) {
              return yield* Effect.fail(
                new ProviderTurnStartError({
                  runId,
                  cause: `The account chosen to compact this thread is no longer available.`,
                }),
              );
            }
            const summariserSnapshot = yield* summariserInstance.snapshot.getSnapshot.pipe(
              Effect.orElseSucceed(() => undefined),
            );
            const windowTokens =
              summariserSnapshot?.models.find((model) => model.slug === summariser.model)
                ?.contextWindowTokens ?? DEFAULT_COMPACTION_WINDOW_TOKENS;
            const transcript = renderCompactionTranscript({
              items: projection.turnItems.filter((item) => item.runId !== run.id),
              windowTokens,
            });
            const threadTitle = projection.thread.title?.trim() ?? "";
            const generated = yield* summariserInstance.textGeneration.generateCompactionSummary({
              cwd: resolvedRuntimePolicy.cwd ?? "",
              transcript: transcript.text,
              ...(threadTitle === "" ? {} : { threadTitle }),
              modelSelection: summariser,
            });
            const summary = clampCompactionSummary(generated.summary, COMPACTION_SUMMARY_MAX_BYTES);
            if (summary === "") {
              return yield* Effect.fail(
                new ProviderTurnStartError({
                  runId,
                  cause: `${modelName} returned no summary.`,
                }),
              );
            }
            return summary;
          }),
        );
        if (summaryResult._tag === "Failure") {
          if (input.willRetry === true) return yield* summaryResult.failure;
          const detail =
            knownProviderFailureMessage(summaryResult.failure) ??
            (isProviderTurnStartError(summaryResult.failure)
              ? String(summaryResult.failure.cause)
              : isTextGenerationError(summaryResult.failure)
                ? summaryResult.failure.detail
                : "The summary could not be written.");
          yield* settleRunBeforeStart({
            signal: "compaction-summary-failed",
            status: "failed",
            now: settledAt,
            startedAt: settledAt,
            providerInstanceId: run.providerInstanceId,
            itemProviderThreadId: providerThread.id,
            item: {
              type: "error",
              title: `Compacting context with ${modelName} failed`,
              failure: makeProviderFailure({ class: "provider_error", message: detail }),
            },
          });
          return;
        }
        const summary = summaryResult.success;
        // Dropping the session is decided on state read before a minutes-long model call, so
        // re-read it: a turn that started meanwhile owns work this write must not strand.
        const reread = yield* projectionStore
          .getThreadRecords(projection.thread.id, ["providerThreads", "subagents"])
          .pipe(Effect.orElseSucceed(() => undefined));
        const currentThread =
          reread?.providerThreads.find((candidate) => candidate.id === providerThread.id) ??
          undefined;
        const threadMoved =
          currentThread === undefined ||
          currentThread.nativeThreadRef?.nativeId !== providerThread.nativeThreadRef?.nativeId;
        const threadBusy =
          !threadMoved &&
          ((currentThread.pendingBackgroundTasks ?? []).length > 0 ||
            reread?.subagents.some(
              (subagent) =>
                subagent.providerThreadId === providerThread.id && subagent.status === "running",
            ) === true);
        if (threadMoved || threadBusy) {
          yield* settleRunBeforeStart({
            signal: threadMoved ? "compaction-session-moved" : "compaction-session-busy",
            status: "failed",
            now: settledAt,
            startedAt: settledAt,
            providerInstanceId: run.providerInstanceId,
            itemProviderThreadId: providerThread.id,
            item: {
              type: "error",
              title: `Cannot compact with ${modelName} while this thread's work is running`,
              failure: makeProviderFailure({
                class: "validation_error",
                message: threadMoved
                  ? `This conversation's session changed while ${modelName} wrote the summary. Compact again.`
                  : `Stop this thread's background work, then compact again. A compaction on ${modelName} replaces the conversation's session, which the running work is using.`,
              }),
            },
          });
          return;
        }
        // The provider's own session still holds every token the summary replaces, so the next
        // turn opens a fresh one and this handoff is the whole conversation it starts from.
        const handoff = yield* contextHandoffService.prepareCompactionSummary({
          threadId: projection.thread.id,
          targetRunId: run.id,
          fromProviderThreadIds: [providerThread.id],
          toProviderThreadId: providerThread.id,
          fromProviderInstanceId: providerThread.providerInstanceId,
          toProviderInstanceId: run.providerInstanceId,
          coveredRunOrdinals: {
            from: projection.runs.at(0)?.ordinal ?? run.ordinal,
            to: run.ordinal,
          },
          summaryText: summary,
          createdAt: settledAt,
        });
        yield* settleRunBeforeStart({
          signal: "compaction-on-another-account",
          status: "completed",
          now: settledAt,
          startedAt: settledAt,
          providerInstanceId: run.providerInstanceId,
          itemProviderThreadId: providerThread.id,
          item: {
            type: "compaction",
            driver: providerThread.driver,
            title: `Context compacted with ${modelName}`,
            summary,
            model: modelName,
            ...(compactionUsages.length === 0
              ? {}
              : {
                  beforeTokenCount: compactionUsages.reduce(
                    (latest, usage) =>
                      Date.parse(usage.updatedAt) > Date.parse(latest.updatedAt) ? usage : latest,
                    compactionUsages[0]!,
                  ).usedTokens,
                }),
            afterTokenCount: Math.ceil(Buffer.byteLength(summary) / 4),
          },
          handoff,
          providerThreadUpdate: {
            ...currentThread,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            contextUsage: null,
            status: "not_loaded",
            handoffIds: [...currentThread.handoffIds, handoff.id],
            updatedAt: settledAt,
          },
        });
        return;
      }
      const existingSessionProjection = projection.providerSessions.find(
        (candidate) => candidate.id === providerSessionId,
      );
      const failedRuns = new Map(
        projection.runs
          .filter(
            (previous) =>
              previous.ordinal < run.ordinal &&
              previous.providerThreadId === providerThread.id &&
              previous.status === "failed",
          )
          .map((previous) => [previous.activeAttemptId, previous] as const),
      );
      const abandonedTurns = projection.providerTurns.flatMap((turn) => {
        const previous = failedRuns.get(turn.runAttemptId);
        return turn.providerThreadId === providerThread.id &&
          turn.status === "running" &&
          previous !== undefined &&
          turn.nodeId === previous.rootNodeId
          ? [{ turn, run: previous }]
          : [];
      });
      const abandonedTurn = abandonedTurns.at(-1)?.turn;
      if (abandonedTurn !== undefined) {
        const liveSession = yield* providerSessions.get(providerSessionId);
        if (Option.isSome(liveSession)) {
          // Older versions could fail the run without stopping its provider.
          // Recover that exact turn before reusing its native conversation.
          const recovered = yield* Effect.result(
            liveSession.value.interruptTurn({
              providerThread,
              providerTurnId: abandonedTurn.id,
              requestRuntimeRestart: true,
            }),
          );
          if (recovered._tag === "Failure") {
            if (input.willRetry === true) return yield* recovered.failure;
            yield* settleStartFailure({
              signal: "provider-turn-recovery-failure",
              title: "Provider turn recovery failed",
              error: recovered.failure,
            });
            return;
          }
        }
        const completedAt = yield* DateTime.now;
        const repaired = yield* eventSink.writeIfRunCurrent({
          threadId: projection.thread.id,
          runId: run.id,
          activeAttemptId: attempt.id,
          expectedStatus: "starting",
          events: yield* Effect.forEach(abandonedTurns, ({ turn, run: failedRun }) =>
            Effect.gen(function* () {
              return {
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                type: "provider-turn.updated" as const,
                threadId: projection.thread.id,
                runId: failedRun.id,
                nodeId: turn.nodeId,
                providerInstanceId: failedRun.providerInstanceId,
                occurredAt: completedAt,
                payload: { ...turn, status: "interrupted" as const, completedAt },
              };
            }),
          ),
        });
        if (!repaired.committed) return;
      }
      const sessionResult = yield* Effect.result(
        providerSessions.open({
          threadId: projection.thread.id,
          providerSessionId,
          modelSelection: run.modelSelection,
          runtimePolicy: resolvedRuntimePolicy,
          ...(existingSessionProjection === undefined
            ? {}
            : { resumeFromSession: existingSessionProjection }),
          ...(providerThread.nativeThreadRef?.nativeId == null
            ? {}
            : { initialNativeThreadId: providerThread.nativeThreadRef.nativeId }),
          ...(providerThread.nativeMetadata?.itemIdentityVersion === undefined
            ? {}
            : {
                initialProviderItemIdentityVersion:
                  providerThread.nativeMetadata.itemIdentityVersion,
              }),
        }),
      );
      if (sessionResult._tag === "Failure") {
        if (input.willRetry === true) return yield* sessionResult.failure;
        yield* settleStartFailure({
          signal: "provider-session-open-failure",
          title: "Provider session failed to open",
          error: sessionResult.failure,
        });
        return;
      }
      const session = sessionResult.success;
      if (!(yield* isCurrentAttemptInStatus("starting"))) return;
      const loadFromProvider = Effect.fn("ProviderTurnStartService.loadFromProvider")(function* (
        load: Effect.Effect<OrchestrationV2ProviderThread, ProviderAdapter.ProviderAdapterV2Error>,
      ) {
        const loaded = yield* Effect.result(load);
        if (loaded._tag === "Success") return loaded.success;
        if (input.willRetry === true) return yield* loaded.failure;
        yield* settleStartFailure({
          signal: "provider-thread-load-failure",
          title: "Provider turn failed to start",
          error: loaded.failure,
        });
        return undefined;
      });
      let effectiveHandoffs = handoffs;
      const loadedProviderThread = yield* Effect.gen(function* () {
        if (nativeForkTransfer !== undefined) {
          const sourceProjection = yield* projectionStore.getThreadRecords(
            nativeForkTransfer.sourceThreadId,
            ["runs", "providerThreads", "attempts", "providerTurns"],
          );
          const sourceRun = sourceProjection.runs.find(
            (candidate) => candidate.id === nativeForkTransfer.sourcePoint.runId,
          );
          const sourceProviderThread = sourceProjection.providerThreads.find(
            (candidate) => candidate.id === sourceRun?.providerThreadId,
          );
          const sourceAttempt = sourceProjection.attempts.find(
            (candidate) => candidate.id === sourceRun?.activeAttemptId,
          );
          const sourceProviderTurn =
            latestProviderTurnForAttempt(sourceProjection.providerTurns, sourceAttempt?.id) ??
            sourceProjection.providerTurns.find(
              (candidate) => candidate.id === sourceAttempt?.providerTurnId,
            );
          if (sourceRun === undefined || sourceProviderThread === undefined) {
            return yield* new ProviderTurnStartError({
              runId,
              cause: `Native fork transfer ${nativeForkTransfer.id} has no source provider execution.`,
            });
          }
          return yield* loadFromProvider(
            session.forkThread({
              sourceProviderThread,
              sourceProviderTurns: sourceProjection.providerTurns,
              targetThreadId: projection.thread.id,
              modelSelection: run.modelSelection,
              runtimePolicy: resolvedRuntimePolicy,
              ...(sourceProviderTurn === undefined
                ? {}
                : { providerTurnId: sourceProviderTurn.id }),
            }),
          );
        }
        if (providerThread.nativeThreadRef === null) {
          // Pass the stored provider row for adoption; adapter-minted duplicates make activeProviderThreadId flap.
          return yield* loadFromProvider(
            session.ensureThread({
              threadId: projection.thread.id,
              title: projection.thread.title,
              modelSelection: run.modelSelection,
              runtimePolicy: resolvedRuntimePolicy,
              providerSessionId,
              existingProviderThread: providerThread,
            }),
          );
        }
        const uncertainDelivery = projection.contextHandoffs.some(
          (handoff) =>
            handoff.toProviderThreadId === providerThread.id &&
            handoff.delivery?.nativeThreadId === providerThread.nativeThreadRef?.nativeId &&
            handoff.delivery?.status === "pending",
        );
        const resumed = yield* Effect.result(
          uncertainDelivery
            ? Effect.fail(
                new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: session.driver,
                  threadId: projection.thread.id,
                  providerThreadId: providerThread.id,
                  runId,
                  cause: "Uncertain native history injection",
                }),
              )
            : session.resumeThread({
                providerThread,
                threadId: projection.thread.id,
                modelSelection: run.modelSelection,
                runtimePolicy: resolvedRuntimePolicy,
              }),
        );
        if (resumed._tag === "Success") {
          return resumed.success;
        }

        yield* Effect.logWarning("Provider resume failed; attempting a fresh native session", {
          driver: session.driver,
          providerThreadId: providerThread.id,
          runId,
          reason: uncertainDelivery ? "uncertain_history_delivery" : "resume_failed",
          errorTag: resumed.failure._tag,
        });
        const replacement = yield* loadFromProvider(
          session.ensureThread({
            threadId: projection.thread.id,
            title: projection.thread.title,
            modelSelection: run.modelSelection,
            runtimePolicy: resolvedRuntimePolicy,
            providerSessionId,
            // Clear the native ref to force a fresh session while preserving row identity.
            existingProviderThread: { ...providerThread, nativeThreadRef: null },
          }),
        );
        if (replacement === undefined) return undefined;
        const transferId = yield* idAllocator.allocate.contextTransfer({
          sourceThreadId: projection.thread.id,
          targetThreadId: projection.thread.id,
          type: "provider_resume_fallback",
        });
        const createdAt = yield* DateTime.now;
        const handoff = yield* contextHandoffService.prepareProviderHandoff({
          threadId: projection.thread.id,
          targetRunId: run.id,
          transferId,
          fromProviderThreadIds: [providerThread.id],
          toProviderThreadId: providerThread.id,
          fromProviderInstanceId: providerThread.providerInstanceId,
          toProviderInstanceId: run.providerInstanceId,
          coveredRunOrdinals: { from: 1, to: Math.max(1, run.ordinal - 1) },
          strategy: "full_thread_summary",
          runs: projection.runs,
          items: (yield* projectionStore.getTurnStartHistory(input.threadId)).filter(
            (item) =>
              item.runId === null ||
              projection.runs.some(
                (source) => source.id === item.runId && source.ordinal < run.ordinal,
              ),
          ),
          createdAt,
        });
        effectiveHandoffs = [handoff, ...effectiveHandoffs];
        yield* eventSink.write({
          events: [
            {
              id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
              type: "context-handoff.updated",
              threadId: projection.thread.id,
              runId: run.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: createdAt,
              payload: handoff,
            },
            {
              id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
              type: "context-transfer.updated",
              threadId: projection.thread.id,
              runId: run.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: createdAt,
              payload: {
                id: transferId,
                type: "provider_handoff",
                sourceThreadId: projection.thread.id,
                targetThreadId: projection.thread.id,
                sourcePoint: { threadId: projection.thread.id },
                basePoint: null,
                sourceProviderInstanceId: providerThread.providerInstanceId,
                targetProviderInstanceId: run.providerInstanceId,
                targetRunId: run.id,
                status: "resolved_portable",
                resolution: { strategy: "portable_context", contextHandoffId: handoff.id },
                createdBy: "system",
                error: null,
                createdAt,
                updatedAt: createdAt,
                consumedAt: null,
              },
            },
          ],
        });
        return replacement;
      });
      if (loadedProviderThread === undefined) return;
      if (!(yield* isCurrentAttemptInStatus("starting"))) {
        return;
      }
      const now = yield* DateTime.now;
      const measuredContext = latestNativeContextUsage(projection, providerThread);
      const previousSelection =
        measuredContext?.modelSelection ??
        projection.runs.findLast(
          (source) =>
            source.ordinal < run.ordinal &&
            source.startedAt !== null &&
            source.providerThreadId === providerThread.id,
        )?.modelSelection;
      const sameSelection =
        previousSelection === undefined ||
        modelSelectionsEqual(previousSelection, run.modelSelection);
      const sameNativeThread =
        loadedProviderThread.nativeThreadRef?.nativeId === providerThread.nativeThreadRef?.nativeId;
      const threadUsage = loadedProviderThread.contextUsage ?? providerThread.contextUsage;
      const previousUsage = measuredContext
        ? { ...threadUsage, ...measuredContext.usage }
        : threadUsage;
      const reuseTelemetry =
        sameSelection ||
        (previousSelection !== undefined &&
          session.canReuseContextUsage?.(previousSelection, run.modelSelection) === true);
      const knownModelWindow = session.getModelContextWindow?.(
        run.modelSelection,
        resolvedRuntimePolicy.cwd,
      );
      const handoffUsage = contextUsageForHandoff({
        sameNativeThread,
        sameSelection,
        reuseTelemetry,
        previousUsage,
        knownModelWindow,
      });
      const runningProviderThread: OrchestrationV2ProviderThread = {
        ...loadedProviderThread,
        contextUsage: handoffUsage,
        id: providerThread.id,
        driver: session.driver,
        providerInstanceId: run.providerInstanceId,
        providerSessionId,
        appThreadId: projection.thread.id,
        ownerNodeId: providerThread.ownerNodeId,
        firstRunOrdinal: providerThread.firstRunOrdinal ?? run.ordinal,
        lastRunOrdinal: run.ordinal,
        handoffIds: providerThread.handoffIds,
        forkedFrom: providerThread.forkedFrom,
        status: "active",
        createdAt: providerThread.createdAt,
        updatedAt: now,
      };
      const runningRun: OrchestrationV2Run = {
        ...run,
        status: "running",
        startedAt: now,
      };
      const runningAttempt: OrchestrationV2RunAttempt = {
        ...attempt,
        ...(runningProviderThread.nativeThreadRef?.nativeId == null
          ? {}
          : { nativeThreadId: runningProviderThread.nativeThreadRef.nativeId }),
        status: "running",
        startedAt: now,
      };
      const runningRootNode: OrchestrationV2ExecutionNode = {
        ...rootNode,
        status: "running",
        startedAt: now,
      };
      const events: Array<OrchestrationV2DomainEvent> = [
        {
          id: yield* idAllocator.allocate.event({
            threadId: projection.thread.id,
            providerSessionId,
          }),
          type: "provider-session.updated",
          threadId: projection.thread.id,
          driver: session.driver,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: session.providerSession,
        },
        {
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "provider-thread.updated",
          threadId: projection.thread.id,
          driver: session.driver,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningProviderThread,
        },
        ...(nativeForkTransfer === undefined || runningProviderThread.nativeThreadRef === null
          ? []
          : [
              {
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                type: "context-transfer.updated" as const,
                threadId: projection.thread.id,
                runId: run.id,
                driver: session.driver,
                providerInstanceId: run.providerInstanceId,
                occurredAt: now,
                payload: {
                  ...nativeForkTransfer,
                  targetProviderInstanceId: run.providerInstanceId,
                  targetRunId: run.id,
                  status: "consumed" as const,
                  resolution: {
                    strategy: "native_fork" as const,
                    providerThreadRef: runningProviderThread.nativeThreadRef,
                  },
                  error: null,
                  updatedAt: now,
                  consumedAt: now,
                },
              },
            ]),
        {
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "run.updated",
          threadId: projection.thread.id,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningRun,
        },
        {
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "run-attempt.updated",
          threadId: projection.thread.id,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningAttempt,
        },
        {
          id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
          type: "node.updated",
          threadId: projection.thread.id,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: runningRootNode,
        },
      ];
      const runningWrite = yield* eventSink.writeIfRunCurrent({
        threadId: projection.thread.id,
        runId: run.id,
        activeAttemptId: attempt.id,
        expectedStatus: "starting",
        events,
      });
      if (!runningWrite.committed) {
        return;
      }
      const routableSubagents = projection.subagents.filter((subagent) =>
        RunExecutionService.canRouteRelatedSubagent(subagent.status),
      );
      const userText = projectComposerContextForProvider({
        text: message.text,
        records: message.context?.records ?? [],
      });
      // The provider turn marks cancellation work delivered; restart continuations use their own text or resume natively.
      const noteContinuation = isRestartNoteContinuation(
        run,
        projection.runs,
        projection.providerTurns,
        projection.attempts,
      );
      const restartCancelledWork = pendingRestartCancelledBackgroundWork({
        runs: projection.runs,
        providerTurns: projection.providerTurns,
        compactionMessageIds: new Set(
          projection.messages
            .filter(
              (candidate) =>
                candidate.attachments.length === 0 &&
                candidate.text.trim().toLowerCase() === "/compact",
            )
            .map((candidate) => candidate.id),
        ),
        run,
        attempts: projection.attempts,
      });
      const restartNote =
        restartCancelledWork.length === 0
          ? ""
          : restartCancelledBackgroundWorkNote(restartCancelledWork);
      const tokenCap = yield* handoffTokenCapConfig.pipe(
        Effect.orElseSucceed(() => DEFAULT_HANDOFF_TOKEN_CAP),
      );
      const settledHandoffs = projection.contextHandoffs.filter(
        (handoff) =>
          handoff.toProviderThreadId === providerThread.id &&
          handoff.delivery?.nativeThreadId === runningProviderThread.nativeThreadRef?.nativeId &&
          handoff.delivery?.status !== "pending",
      );
      const deliveredItemIds = new Set(
        settledHandoffs.flatMap((handoff) => handoff.delivery?.itemIds ?? []),
      );
      const coveredItemIds = new Set([
        ...deliveredItemIds,
        ...settledHandoffs.flatMap((handoff) => handoff.delivery?.omittedItemIds ?? []),
      ]);
      const deliveredAttemptIds = new Set(
        projection.providerTurns.map((turn) => turn.runAttemptId),
      );
      const acceptedAttempts = projection.attempts.filter(
        (source) =>
          source.providerThreadId === providerThread.id && deliveredAttemptIds.has(source.id),
      );
      const nativeInputRunIds = new Set(
        acceptedAttempts
          .filter(
            (source) =>
              source.nativeThreadId !== undefined &&
              source.nativeThreadId === runningProviderThread.nativeThreadRef?.nativeId,
          )
          .map((source) => source.runId),
      );
      const legacyInputRunIds = new Set(
        acceptedAttempts
          .filter((source) => source.nativeThreadId === undefined)
          .map((source) => source.runId),
      );
      const legacyRecoveredRunIds = new Set(
        projection.runs
          .filter(
            (source) =>
              source.providerThreadId === providerThread.id &&
              settledHandoffs.some(
                (handoff) =>
                  handoff.strategy === "full_thread_summary" &&
                  handoff.fromProviderThreadIds.includes(providerThread.id) &&
                  source.ordinal >= handoff.coveredRunOrdinals.from &&
                  source.ordinal <= handoff.coveredRunOrdinals.to,
              ),
          )
          .map((source) => source.id),
      );
      // Legacy attempts lack native ids; exclude recovered attachments absent from the replacement thread.
      const nativeContextEstimate = Effect.gen(function* () {
        return sameNativeThread
          ? (yield* projectionStore.getTurnStartHistory(input.threadId)).reduce((sum, item) => {
              if (
                item.runId === run.id ||
                (item.runId !== null &&
                  missedRunIds.has(item.runId) &&
                  !deliveredItemIds.has(item.id)) ||
                (item.providerThreadId !== providerThread.id && !deliveredItemIds.has(item.id))
              )
                return sum;
              const historical = historicalMessage(item);
              const nativeAttachments =
                item.type === "user_message" &&
                item.providerThreadId === providerThread.id &&
                item.runId !== null &&
                (nativeInputRunIds.has(item.runId) ||
                  (legacyInputRunIds.has(item.runId) &&
                    !coveredItemIds.has(item.id) &&
                    !legacyRecoveredRunIds.has(item.runId)))
                  ? attachmentTokenAllowance(item.attachments)
                  : 0;
              return (
                sum +
                (historical === null ? 0 : Buffer.byteLength(historical.text)) +
                nativeAttachments
              );
            }, 0)
          : 0;
      });
      const modelContextWindow =
        knownModelWindow ??
        (handoffUsage !== null || reuseTelemetry ? previousUsage?.maxTokens : undefined);
      const budgetProviderThread = {
        ...runningProviderThread,
        contextUsage: handoffUsage,
      };
      const missedRuns = projection.runs.filter(
        (source) =>
          source.ordinal < run.ordinal &&
          source.providerThreadId === providerThread.id &&
          (source.status === "failed" || source.status === "interrupted") &&
          !deliveredAttemptIds.has(source.activeAttemptId),
      );
      const missedRunIds = new Set(missedRuns.map((source) => source.id));
      const missedItems =
        missedRunIds.size === 0
          ? []
          : (yield* projectionStore.getTurnStartHistory(input.threadId, [...missedRunIds])).filter(
              (item) =>
                item.runId !== null &&
                missedRunIds.has(item.runId) &&
                !coveredItemIds.has(item.id) &&
                historicalMessage(item) !== null,
            );
      // The notes this turn adds to the user's message. A turn with any of them goes through
      // context delivery, which writes them.
      const offersProjectSuggestion =
        projection.thread.sideChat !== true &&
        projection.thread.projectSuggestion == null &&
        (yield* projects.getById(projection.thread.projectId).pipe(
          Effect.map(
            Option.exists(
              (project) =>
                path.resolve(project.workspaceRoot) ===
                ManagedProjectFolders.scratchFolder(path, serverConfig.baseDir),
            ),
          ),
          Effect.orElseSucceed(() => false),
        ));
      const scheduled = message.scheduledTaskId !== undefined;
      const replaced = replacedWorkspace(
        projection.thread,
        projection.attempts,
        projection.providerTurns,
        run.id,
      );
      const attachments = projection.thread.workspaceAttachments ?? [];
      const turnWorkspaces =
        attachments.length === 0 && resolvedRuntimePolicy.managedAgent !== true
          ? []
          : yield* Effect.forEach(
              [
                {
                  projectId: projection.thread.projectId,
                  path: projection.thread.worktreePath,
                  branch: projection.thread.branch,
                  role: "primary" as const,
                },
                ...attachments.map((attachment) => ({
                  projectId: attachment.projectId,
                  path: attachment.workspacePath,
                  branch: attachment.branch,
                  role:
                    attachment.releasedAt === null ? ("attached" as const) : ("released" as const),
                })),
              ],
              (workspace) =>
                Effect.gen(function* () {
                  const project = Option.getOrUndefined(
                    yield* projects
                      .getById(workspace.projectId)
                      .pipe(Effect.orElseSucceed(() => Option.none())),
                  );
                  const root = workspace.path ?? project?.workspaceRoot ?? "";
                  const instructionFiles =
                    workspace.role === "released"
                      ? []
                      : yield* Effect.filter(INSTRUCTION_FILES, (file) =>
                          fileSystem
                            .exists(path.join(root, file))
                            .pipe(Effect.orElseSucceed(() => false)),
                        );
                  return {
                    project: project?.title ?? workspace.projectId,
                    path: root,
                    branch: workspace.branch,
                    role: workspace.role,
                    instructionFiles,
                  } satisfies TurnWorkspace;
                }),
            );
      const startWithHandoffs = Effect.fn("ProviderTurnStartService.startWithHandoffs")(
        function* (turnInput: Parameters<typeof session.startTurn>[0], compact = false) {
          const retryHandoff =
            missedItems.length === 0
              ? []
              : [
                  yield* contextHandoffService.prepareProviderHandoff({
                    threadId: projection.thread.id,
                    targetRunId: run.id,
                    transferId: null,
                    fromProviderThreadIds: [providerThread.id],
                    toProviderThreadId: providerThread.id,
                    fromProviderInstanceId: run.providerInstanceId,
                    toProviderInstanceId: run.providerInstanceId,
                    coveredRunOrdinals: {
                      from: missedRuns[0]!.ordinal,
                      to: missedRuns.at(-1)!.ordinal,
                    },
                    strategy: "delta_since_target_last_seen",
                    items: missedItems,
                    runs: projection.runs,
                    createdAt: yield* DateTime.now,
                  }),
                ];
          const delivery = yield* deliverContextHandoffs({
            handoffs: [...effectiveHandoffs, ...retryHandoff],
            deferInline: compact,
            providerThread: runningProviderThread,
            budget: Effect.gen(function* () {
              return handoffBudget({
                tokenCap,
                modelContextWindow,
                userText: restartNote === "" ? userText : `${restartNote}\n\n${userText}`,
                attachments: message.attachments,
                providerThread: budgetProviderThread,
                nativeContextEstimate:
                  budgetProviderThread.contextUsage?.usedTokens === undefined
                    ? yield* nativeContextEstimate
                    : 0,
              });
            }),
            alreadyDeliveredItemIds: deliveredItemIds,
            ...(session.injectHistory === undefined
              ? {}
              : {
                  inject: (history: ProviderAdapter.ProviderAdapterV2HistoricalContext) =>
                    session.injectHistory!({
                      providerThread: runningProviderThread,
                      ...history,
                    }),
                }),
            persist: Effect.fn("ProviderTurnStartService.persist")(function* (handoff) {
              const updatedAt = yield* DateTime.now;
              yield* eventSink.write({
                events: [
                  {
                    id: yield* idAllocator.allocate.event({
                      threadId: projection.thread.id,
                    }),
                    type: "context-handoff.updated",
                    threadId: projection.thread.id,
                    runId: run.id,
                    providerInstanceId: run.providerInstanceId,
                    occurredAt: updatedAt,
                    payload: { ...handoff, updatedAt },
                  },
                ],
              });
            }),
          });
          if (!(yield* isCurrentAttemptInStatus("running"))) return;
          const start = compact ? session.compactThread! : session.startTurn;
          const context = [
            delivery.context,
            restartNote,
            projection.thread.sideChat === true ? SIDE_CHAT_NOTE : "",
            offersProjectSuggestion ? NO_PROJECT_NOTE : "",
            turnWorkspaces.length === 0
              ? ""
              : workspacesNote(
                  turnWorkspaces,
                  resolvedRuntimePolicy.managedAgent === true && attachments.length === 0,
                ),
            replaced === null
              ? ""
              : replaced.worktreePath === null
                ? unreplacedWorkspaceNote(
                    resolvedRuntimePolicy.cwd ?? "",
                    replaced.detail,
                    replaced.forgeItem,
                  )
                : replacedWorkspaceNote(replaced.worktreePath, replaced.outcome, replaced.detail),
            scheduled ? SCHEDULED_TASK_NOTE : "",
          ]
            .filter((part) => part !== "")
            .join("\n\n");
          const messageLabel = scheduled ? SCHEDULED_TASK_PROMPT_LABEL : "User message";
          const { restartContinuationOfRunId: _resumedRunId, ...promptedInput } = turnInput;
          yield* start({
            ...(noteContinuation ? promptedInput : turnInput),
            message: {
              ...turnInput.message,
              text: context === "" ? userText : `${context}\n\n${messageLabel}:\n${userText}`,
            },
          }).pipe(
            // Clear pending handoff markers for refused prompts so the next turn retains the native session.
            Effect.tapError((error) =>
              refusedBeforePrompt(error)
                ? delivery.unsent.pipe(
                    Effect.catchCause(() =>
                      Effect.logWarning("Failed to restore unsent context handoffs", {
                        runId: run.id,
                      }),
                    ),
                  )
                : Effect.void,
            ),
          );
          // After provider acceptance, failed delivery bookkeeping must not stop live ingestion.
          yield* delivery.delivered.pipe(
            Effect.catchCause(() =>
              Effect.logWarning("Failed to record accepted context handoff delivery", {
                runId: run.id,
                deliveryStatus: "pending",
              }),
            ),
          );
        },
        Effect.mapError((cause) =>
          cause._tag === "ProviderAdapterTurnStartError"
            ? cause
            : new ProviderAdapter.ProviderAdapterTurnStartError({
                driver: session.driver,
                threadId: projection.thread.id,
                providerThreadId: providerThread.id,
                runId: run.id,
                cause,
              }),
        ),
      );
      const deliverySession =
        effectiveHandoffs.length === 0 &&
        missedItems.length === 0 &&
        restartNote === "" &&
        !noteContinuation &&
        projection.thread.sideChat !== true &&
        !scheduled &&
        !offersProjectSuggestion &&
        turnWorkspaces.length === 0 &&
        replaced === null
          ? session
          : makeDeliverySession(session, startWithHandoffs);
      const videoFrames = yield* videoFramesService.framesForMessage(message.attachments);
      const compaction =
        compactionPlan.kind === "provider"
          ? { modelSelection: compactionPlan.modelSelection }
          : compactionPlan.kind === "windowTooSmall"
            ? { windowTooSmall: true }
            : undefined;
      return runExecution.startRootRun({
        commandId: CommandId.make(`command:effect:provider-turn.start:${run.id}`),
        appThread: projection.thread,
        providerSessionId,
        session: deliverySession,
        run: runningRun,
        rootNode: runningRootNode,
        checkpointScope,
        providerThread: runningProviderThread,
        attempt: runningAttempt,
        attemptId: attempt.id,
        loadInheritedBackgroundTurnItems: runControls.loadInheritedBackgroundTurnItems,
        relatedThreadIds: routableSubagents.flatMap((subagent) =>
          subagent.childThreadId === null ? [] : [subagent.childThreadId],
        ),
        relatedProviderThreadIds: routableSubagents.flatMap((subagent) =>
          subagent.providerThreadId === null ? [] : [subagent.providerThreadId],
        ),
        providerTurnOrdinal:
          Math.max(
            0,
            ...projection.providerTurns
              .filter((turn) => turn.providerThreadId === providerThread.id)
              .map((turn) => turn.ordinal),
          ) + 1,
        nativeThreadHasTurns:
          nativeInputRunIds.size > 0 ||
          (legacyInputRunIds.size > 0 &&
            sameNativeThread &&
            !acceptedAttempts.some((source) => source.nativeThreadId !== undefined)),
        shouldStartProviderTurn: runControls.shouldStartProviderTurn,
        shouldFinalizeRun: runControls.shouldFinalizeRun,
        hasUnpairedRunInterruptRequest: runControls.hasUnpairedRunInterruptRequest,
        movedTo: runControls.movedTo,
        loadRunInterruptReason: runControls.loadRunInterruptReason,
        message: {
          messageId: message.id,
          text: userText,
          attachments: message.attachments,
          ...(videoFrames.length === 0 ? {} : { videoFrames }),
          createdBy: message.createdBy,
          creationSource: message.creationSource,
          ...(message.scheduledTaskId === undefined
            ? {}
            : { scheduledTaskId: message.scheduledTaskId }),
          ...(message.senderThreadId === undefined
            ? {}
            : { senderThreadId: message.senderThreadId }),
        },
        modelSelection: run.modelSelection,
        ...(compaction === undefined ? {} : { compaction }),
        runtimePolicy: resolvedRuntimePolicy,
      });
    });

    return ProviderTurnStartServiceV2.of({
      start: Effect.fn("ProviderTurnStartService.start")(
        function* (input) {
          // Storage cleanup removes worktrees under the same lease. Only startup
          // holds it; the provider turn runs after it is released.
          const { thread } = yield* projectionStore.getThreadRecords(input.threadId, []);
          const providerTurn = yield* thread.worktreePath === null
            ? start(input)
            : withWorkspaceLease(path.resolve(thread.worktreePath), start(input));
          if (providerTurn !== undefined) yield* providerTurn;
        },
        (effect, input) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isProviderTurnStartError(cause)
                ? cause
                : new ProviderTurnStartError({ runId: input.runId, cause }),
            ),
          ),
      ),
    });
  }),
);
