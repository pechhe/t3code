import { describeArcRun } from "./arcRun.ts";
import { ARC_RUN_WAKE_MESSAGE_PREFIX } from "./serverContinuation.ts";
import * as AgentMcpServers from "@t3tools/provider-core/server/AgentMcpServers";
import * as ProcessRunner from "../processRunner.ts";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { managedWorkspaceInvalid, turnWorkspaceNotes } from "./ProviderTurnWorkspaceNotes.ts";
import * as VideoFrames from "../videoFrames/VideoFrames.ts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import { expandAssistantCitationsForProvider } from "@t3tools/shared/assistantCitations";
import {
  buildStatusLabel,
  CommandId,
  type ForgeWorkItemKind,
  type ForgeWorkItemSummary,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  latestProviderTurnForAttempt,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2ReplacedWorkspaceOutcome,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type ProjectId,
  isSideChatThread,
  isCompactionCommandMessage,
  parseGoalCommand,
  RunId,
  RunAttemptId,
  NodeId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  hostReleaseRunner,
  isSlipJayWorkspacePath,
  restoreSlipJayWorkspace,
  unresolvedRelease,
} from "../slipJayRelease.ts";

import {
  CLAUDE_PROVIDER,
  CLAUDE_QUERY_ENDED_BEFORE_TURN_DETAIL,
} from "./Adapters/ClaudeAdapterV2.ts";
import { withTurnStartReservation, withWorkspaceLease } from "../workspace/workspaceLease.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ServerConfig from "../config.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ManagedAgent from "../agents/ManagedAgentService.ts";
import { threadStanceNote } from "../agents/delegationStanceNote.ts";
import * as ForgeWorkItems from "../weave/ForgeWorkItems.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeRestoreMissingWorktree } from "../workspace/restoreMissingWorktree.ts";
import * as EventSink from "./EventSink.ts";
import * as ProviderUsageAnalytics from "../telemetry/ProviderUsageAnalytics.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as ClaudeCompactionTurnStart from "./ClaudeCompactionTurnStart.ts";
import { reopenWithCanonicalCatalogue } from "./agentMcpCatalogueReopen.ts";
import { canForkBusySourceNatively, isActiveRun } from "./CommandPolicy.ts";
import { contextBoundaryOrdinal, isScheduledFreshRun } from "./contextBoundary.ts";
import {
  DEFAULT_HANDOFF_TOKEN_CAP,
  handoffTokenCapConfig,
  handoffBudget,
  attachmentTokenAllowance,
  historicalTokens,
  contextUsageForHandoff,
  historicalMessage,
  latestNativeContextUsage,
} from "@t3tools/provider-core/server/handoffBudget";
import { deliverContextHandoffs } from "./ContextHandoffDelivery.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import { unsentManualContinuationSource } from "@t3tools/shared/orchestrationV2ManualContinuation";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import {
  ContextHandoffBackgroundWorkError,
  knownProviderFailureMessage,
  makeProviderFailure,
} from "@t3tools/provider-core/server/failure";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";
import {
  isRestartNoteContinuation,
  pendingRestartCancelledBackgroundWork,
  restartCancelledBackgroundWorkNote,
} from "./RestartBackgroundNote.ts";
import {
  SCHEDULED_TASK_NOTE,
  SCHEDULED_TASK_PROMPT_LABEL,
  withSenderNoteUnlessScheduled,
} from "./ScheduledTaskPrompt.ts";

/** Sent with each side chat turn; the side chat card is narrow and meant for quick answers. */
export const SIDE_CHAT_NOTE =
  "This is a side chat: the user is asking a quick question beside the main conversation. Be extra concise unless the user asks for more detail.";

/**
 * Sent with each turn of a No project chat until its agent suggests a project,
 * so it can offer a better home for the chat once one is clear.
 */
export const NO_PROJECT_NOTE =
  "This chat is in No project: it runs in its own scratch folder and cannot see project code. When the user's request is work in one of their projects (t3_project_list), call t3_thread_move_to_project with that project before doing the work, then end your turn; this chat moves into the project and T3 starts its next turn there with the conversation carried over. Pass continuationPrompt only for a one-sentence next step the conversation does not already say, never a summary or handoff of the work so far. When the work spans projects, move into the one holding most of it and attach the others with t3_worktree_attach. When the fit is likely but unclear, call t3_thread_suggest_project once with a one-line reason instead; the user then chooses Move or Keep.";

const FORGE_KIND_LABELS: Record<ForgeWorkItemKind, string> = {
  spec: "Spec",
  ticket: "Ticket",
  arc: "Arc",
};

/**
 * The Forge item a thread is linked to, stated as facts on every turn so it survives compaction.
 * Without a summary T3 already holds, only the number: a turn never waits on Weave for it.
 */
const linkedForgeItemNote = (
  number: number,
  summary: Option.Option<ForgeWorkItemSummary>,
): string =>
  Option.match(summary, {
    onNone: () => `This thread is linked to Forge item #${number}.`,
    onSome: (item) =>
      `This thread is linked to ${FORGE_KIND_LABELS[item.kind]} ${item.ref ?? `#${number}`} "${item.title}" (${buildStatusLabel(item.status)}).`,
  });

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
    attemptId: Schema.optional(RunAttemptId),
    rootNodeId: Schema.optional(NodeId),
  },
) {}

/** Runs that ended without completing: their provider turn may still project as running. */
const NON_COMPLETING_TERMINAL_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "failed",
  "interrupted",
  "cancelled",
  "rolled_back",
]);

export function abandonedProviderTurns(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "attempts" | "providerTurns">,
  run: Pick<OrchestrationV2Run, "ordinal">,
  providerThreadId: OrchestrationV2ProviderThread["id"],
) {
  const attemptsByRun = Map.groupBy(projection.attempts, (attempt) => attempt.runId);
  const abandonedRuns = new Map<string | null, OrchestrationV2Run>();
  for (const previous of projection.runs) {
    if (
      previous.ordinal >= run.ordinal ||
      previous.providerThreadId !== providerThreadId ||
      !NON_COMPLETING_TERMINAL_RUN_STATUSES.has(previous.status)
    ) {
      continue;
    }
    if (previous.activeAttemptId !== null) {
      abandonedRuns.set(previous.activeAttemptId, previous);
    }
    for (const attempt of attemptsByRun.get(previous.id) ?? []) {
      abandonedRuns.set(attempt.id, previous);
    }
  }
  return projection.providerTurns.flatMap((turn) => {
    const previous = abandonedRuns.get(turn.runAttemptId);
    return turn.providerThreadId === providerThreadId &&
      turn.status === "running" &&
      previous !== undefined
      ? [{ turn, run: previous }]
      : [];
  });
}

export const isProviderTurnStartError = Schema.is(ProviderTurnStartError);
const isProviderAdapterProtocolError = Schema.is(ProviderAdapter.ProviderAdapterProtocolError);
const isProviderAdapterOpenSessionError = Schema.is(
  ProviderAdapter.ProviderAdapterOpenSessionError,
);

/**
 * Claude refuses these before it reads the prompt: replacing a process running background work,
 * launch arguments whose appended system prompt or settings cannot be read, or MCP registration
 * that never answers while the query opens. A query that ends before the turn attaches (such as a
 * rejected resume point) never received the prompt either.
 */
const PROMPT_REFUSAL_TAGS = [
  "ClaudeBackgroundWorkBlocksQueryReplacementError",
  "ClaudeAppendSystemPromptFileError",
  "ClaudeAppendSystemPromptMissingValueError",
  "ClaudeSettingsLaunchArgError",
  "ClaudeMcpRegistrationTimeoutError",
] as const;

const refusedBeforePrompt = (error: unknown): boolean =>
  PROMPT_REFUSAL_TAGS.some((tag) => Predicate.isTagged(error, tag)) ||
  (isProviderAdapterProtocolError(error) &&
    error.driver === CLAUDE_PROVIDER &&
    error.detail === CLAUDE_QUERY_ENDED_BEFORE_TURN_DETAIL) ||
  (Predicate.hasProperty(error, "cause") && refusedBeforePrompt(error.cause));

/**
 * Whether a non-truncating provider's native session lost the conversation kept before `run`.
 * Rollback resets it: the newest accepted turn was rolled back (works without legacy-missing
 * native ids) or ran under another native id (rollback of runs the provider never accepted).
 */
const nativeSessionMissesKeptTurns = (
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "attempts" | "providerTurns" | "contextHandoffs"
  >,
  providerThread: OrchestrationV2ProviderThread,
  run: OrchestrationV2Run,
): boolean => {
  const nativeId = providerThread.nativeThreadRef?.nativeId;
  if (nativeId === undefined) return false;
  const acceptedAttemptIds = new Set(projection.providerTurns.map((turn) => turn.runAttemptId));
  const accepted = projection.attempts.filter((attempt) => acceptedAttemptIds.has(attempt.id));
  const runsById = new Map(projection.runs.map((source) => [source.id, source]));
  const ordinalOf = (attempt: OrchestrationV2RunAttempt) =>
    runsById.get(attempt.runId)?.ordinal ?? 0;
  const newest = accepted
    .filter((attempt) => attempt.providerThreadId === providerThread.id)
    .toSorted((a, b) => ordinalOf(a) - ordinalOf(b) || a.attemptOrdinal - b.attemptOrdinal)
    .at(-1);
  if (newest === undefined) return false;
  // Inherited fork history is kept even when every local run was rolled back.
  const keepsHistory =
    (projection.thread.forkedFrom?.type === "run" && projection.thread.lineage.sideChat !== true) ||
    accepted.some((attempt) => {
      const source = runsById.get(attempt.runId);
      return (
        source !== undefined && source.ordinal < run.ordinal && source.status !== "rolled_back"
      );
    });
  return (
    keepsHistory &&
    (runsById.get(newest.runId)?.status === "rolled_back" ||
      (newest.nativeThreadId !== undefined && newest.nativeThreadId !== nativeId)) &&
    !projection.contextHandoffs.some(
      (handoff) =>
        handoff.toProviderThreadId === providerThread.id &&
        handoff.delivery?.nativeThreadId === nativeId &&
        handoff.delivery.status !== "pending",
    )
  );
};

/** Missing execution records cannot be repaired by retrying a start. */
export class ProviderTurnStartRunStateMissingError extends Schema.TaggedError<ProviderTurnStartRunStateMissingError>()(
  "ProviderTurnStartRunStateMissingError",
  {
    runId: RunId,
  },
) {}

export const isProviderTurnStartRunStateMissingError = Schema.is(
  ProviderTurnStartRunStateMissingError,
);

const RESUME_PROMPT = "Continue where you left off.";

const START_GAVE_UP_MESSAGE =
  "T3 Code could not start this turn. Send the message again; if it keeps failing, check the server logs.";

const startFailureMessage = (error: Error): string => {
  const nestedCause = "cause" in error ? error.cause : undefined;
  return (
    knownProviderFailureMessage(error) ??
    (nestedCause instanceof Error
      ? nestedCause.message
      : typeof nestedCause === "string"
        ? nestedCause
        : error.message)
  );
};

export interface ProviderTurnStartServiceV2Shape {
  readonly start: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly willRetry?: boolean;
  }) => Effect.Effect<void, ProviderTurnStartError>;
  readonly failStartingRun: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly attemptId: RunAttemptId;
    readonly rootNodeId: NodeId;
  }) => Effect.Effect<void, ProviderTurnStartError | ProviderTurnStartRunStateMissingError>;
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
  | ChildProcessSpawner.ChildProcessSpawner
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
  | TurnItemPositionStore.TurnItemPositionStoreV2
> = Layer.effect(
  ProviderTurnStartServiceV2,
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const turnAnalytics = yield* ProviderUsageAnalytics.ProviderTurnAnalytics;
    const contextHandoffService = yield* ContextHandoffService.ContextHandoffServiceV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig.ServerConfig;
    const projects = yield* ProjectService.ProjectService;
    const processes = yield* ProcessRunner.make();
    const providerAuth = yield* ProviderAuthService.ProviderAuthService;
    // Optional: a layer without managed agents notes no delegation stance.
    const managedAgents = yield* Effect.serviceOption(ManagedAgent.ManagedAgentService);
    // Optional: a layer without Forge links states only the linked item's number.
    const forgeWorkItems = yield* Effect.serviceOption(ForgeWorkItems.ForgeWorkItems);
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
    const runtimePolicy = yield* RuntimePolicy.RuntimePolicyV2;
    const videoFramesService = yield* VideoFrames.VideoFrames;
    const claudeCompaction = yield* ClaudeCompactionTurnStart.make;
    const restoreMissingWorktree = yield* makeRestoreMissingWorktree;
    const turnItemPositions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;

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
      const isCurrentAttemptIn = (statuses: ReadonlyArray<OrchestrationV2Run["status"]>) =>
        projectionStore
          .getRun(input.threadId, input.runId)
          .pipe(
            Effect.map(
              (run) => run?.activeAttemptId === input.attemptId && statuses.includes(run.status),
            ),
          );
      const isCurrentAttemptInStatus = (expectedStatus: OrchestrationV2Run["status"]) =>
        isCurrentAttemptIn([expectedStatus]);
      return {
        isCurrentAttemptInStatus,
        hasWorkspaceMoved: () =>
          projectionStore.getThreadShell(input.threadId).pipe(
            Effect.map((thread) => thread !== null && thread.worktreePath !== input.worktreePath),
            Effect.catchCause(() => Effect.succeed(false)),
          ),
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
        shouldFinalizeRun: () => isCurrentAttemptIn(["starting", "running"]),
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
                ? Effect.undefined
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
                    : Effect.undefined,
            ),
            Effect.catchCause(() => Effect.undefined),
          ),
        loadUnsettledWork: (threadId: ThreadId, nodeIds: ReadonlyArray<NodeId>) =>
          projectionStore
            .getThreadRecords(threadId, ["subagents", "nodes", "turnItems"], {
              nodeIds,
              subagentIds: nodeIds,
              turnItemStatuses: ["pending", "running", "waiting"],
            })
            .pipe(
              Effect.catchTags({
                ProjectionStoreThreadNotFoundError: () =>
                  Effect.succeed({ subagents: [], nodes: [], turnItems: [] }),
              }),
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
              Effect.catchCause(() => Effect.undefined),
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
        ...(session.resumeTurn === undefined
          ? {}
          : {
              resumeTurn: (input: ProviderAdapter.ProviderAdapterV2ResumeTurnInput) =>
                start(ProviderAdapter.resumeTurnInput(input)),
            }),
        ...(session.compactThread === undefined
          ? {}
          : {
              compactThread: (input: Parameters<typeof session.startTurn>[0]) => start(input, true),
            }),
      };
    };

    const settleRunBeforeStart = Effect.fn("orchestrationV2.providerTurnStart.settleBeforeStart")(
      function* (input: {
        readonly run: OrchestrationV2Run;
        readonly rootNode: OrchestrationV2ExecutionNode;
        readonly attempt: OrchestrationV2RunAttempt;
        readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
        readonly signal: string;
        readonly status: "completed" | "failed";
        readonly now: DateTime.Utc;
        readonly startedAt?: DateTime.Utc;
        /** A run already executing, settled in place of the starting one. */
        readonly execution?: {
          readonly run: OrchestrationV2Run;
          readonly attempt: OrchestrationV2RunAttempt;
          readonly node: OrchestrationV2ExecutionNode;
        };
        readonly providerInstanceId: OrchestrationV2Run["providerInstanceId"];
        readonly itemProviderThreadId: OrchestrationV2ProviderThread["id"] | null;
        readonly item:
          | Pick<Extract<OrchestrationV2TurnItem, { type: "error" }>, "type" | "title" | "failure">
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
        const { run, rootNode, attempt, turnItems, now, status } = input;
        const runId = run.id;
        const started = input.startedAt === undefined ? {} : { startedAt: input.startedAt };
        const item: OrchestrationV2TurnItem = {
          id: idAllocator.derive.runSignalTurnItem({ runId, signal: input.signal }),
          threadId: run.threadId,
          runId,
          nodeId: rootNode.id,
          providerThreadId: input.itemProviderThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal:
            Math.max(
              0,
              ...turnItems.filter((item) => item.runId === runId).map((item) => item.ordinal),
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
          {
            type: "run.updated",
            payload: { ...(input.execution?.run ?? run), status, ...started, completedAt: now },
          },
          {
            type: "run-attempt.updated",
            payload: {
              ...(input.execution?.attempt ?? attempt),
              status,
              ...started,
              completedAt: now,
            },
          },
          {
            type: "node.updated",
            payload: {
              ...(input.execution?.node ?? rootNode),
              status,
              ...started,
              completedAt: now,
            },
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
              id: yield* idAllocator.allocate.event({ threadId: run.threadId }),
              threadId: run.threadId,
              runId,
              nodeId: rootNode.id,
              providerInstanceId: input.providerInstanceId,
              occurredAt: now,
            } satisfies OrchestrationV2DomainEvent;
          }),
        );
        const written = yield* eventSink.writeIfRunCurrent({
          threadId: run.threadId,
          runId,
          activeAttemptId: attempt.id,
          expectedStatus: input.execution === undefined ? "starting" : "running",
          events,
        });
        // A steering restart that cannot start still ends a run whose earlier turns counted.
        if (written.committed) {
          yield* turnAnalytics.runSettled({
            runId,
            status,
            completedAt: now,
            childrenRunning: false,
          });
        }
      },
    );

    const start = Effect.fn("orchestrationV2.providerTurnStart.start")(function* (
      input: {
        readonly threadId: ThreadId;
        readonly runId: RunId;
        readonly willRetry?: boolean;
      },
      captureStartingRun: (run: OrchestrationV2Run) => void,
    ) {
      const { runId } = input;
      const projection = yield* projectionStore.getTurnStartContext(input.threadId, runId);
      const run = projection.runs.find((candidate) => candidate.id === runId);
      if (run === undefined) {
        return yield* new ProviderTurnStartError({ runId, cause: `Run ${runId} was not found.` });
      }
      if (run.status !== "starting") {
        return;
      }
      captureStartingRun(run);
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
      const isPendingForRun = (handoff: OrchestrationV2ContextHandoff, anyProviderThread = false) =>
        handoff.status === "ready" &&
        (handoff.targetRunId === run.id ||
          ((anyProviderThread || handoff.toProviderThreadId === run.providerThreadId) &&
            projection.runs.some(
              (source) =>
                source.id === handoff.targetRunId &&
                // A settled delivery retires history of this thread: the session that took it
                // holds it, and a fresh session starts from a full summary of the thread. That
                // summary lacks another thread's history (a fork source, a merge-back).
                (((source.status === "failed" ||
                  source.status === "interrupted" ||
                  source.status === "cancelled") &&
                  !(
                    (handoff.delivery?.status === "injected" ||
                      handoff.delivery?.status === "inline") &&
                    handoff.fromProviderThreadIds.length > 0 &&
                    handoff.fromProviderThreadIds.every((id) =>
                      projection.providerThreads.some((candidate) => candidate.id === id),
                    )
                  )) ||
                  (source.status === "completed" &&
                    handoff.delivery === undefined &&
                    // Compaction and /goal turns defer history to the next turn.
                    projection.messages.some(
                      (message) =>
                        message.id === source.userMessageId &&
                        (isCompactionCommandMessage(message) || parseGoalCommand(message) !== null),
                    ))),
            )));
      const isSideChatHandoff = (handoff: OrchestrationV2ContextHandoff) =>
        projection.thread.lineage.sideChat === true &&
        ContextHandoffService.isSideChatContextHandoff(handoff);
      const handoffs = projection.contextHandoffs.filter(
        (handoff) =>
          !isSideChatHandoff(handoff) &&
          (handoff.transferId == null || !subagentResultTransfers.has(handoff.transferId)) &&
          isPendingForRun(handoff),
      );
      // Carried forward until a provider turn accepts them, also after a provider switch. A fresh
      // session starts without them, and an unscheduled fresh run retires them. A schedule's fresh
      // run is a side conversation, so the thread's next turn still gets them.
      const carriedSideChatHandoffs = projection.contextHandoffs.filter(
        (handoff) =>
          isSideChatHandoff(handoff) &&
          handoff.delivery === undefined &&
          isPendingForRun(handoff, true),
      );
      const sideChatHandoff = run.freshContext === true ? undefined : carriedSideChatHandoffs[0];
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
      const settleRunStartup = (
        input: Omit<
          Parameters<typeof settleRunBeforeStart>[0],
          "run" | "rootNode" | "attempt" | "turnItems"
        >,
      ) =>
        settleRunBeforeStart({ run, rootNode, attempt, turnItems: projection.turnItems, ...input });
      if (
        carriedSideChatHandoffs.length > 0 &&
        run.freshContext === true &&
        !isScheduledFreshRun(run, projection.turnItems)
      ) {
        const updatedAt = yield* DateTime.now;
        const retired = yield* eventSink.writeIfRunCurrent({
          threadId: run.threadId,
          runId,
          activeAttemptId: attempt.id,
          expectedStatus: "starting",
          events: yield* Effect.forEach(carriedSideChatHandoffs, (handoff) =>
            Effect.map(idAllocator.allocate.event({ threadId: projection.thread.id }), (id) => ({
              id,
              type: "context-handoff.updated" as const,
              threadId: projection.thread.id,
              runId: run.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: updatedAt,
              payload: { ...handoff, status: "superseded" as const, updatedAt },
            })),
          ),
        });
        if (!retired.committed) return;
      }
      const manualResume =
        run.manualContinuationOfRunId !== undefined && attempt.reason !== "steering_restart";
      const resumeSource = manualResume
        ? unsentManualContinuationSource(run, projection)
        : undefined;
      const unsentResumeMessage =
        resumeSource !== undefined
          ? projection.messages.find((source) => source.id === resumeSource.userMessageId)
          : undefined;
      const providerMessage = unsentResumeMessage ?? message;
      const settleStartFailure = Effect.fn("ProviderTurnStartService.settleStartFailure")(
        function* (failed: {
          readonly signal: string;
          readonly title: string;
          readonly error: Error;
          readonly message?: string;
        }) {
          yield* settleRunStartup({
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
                message: failed.message ?? startFailureMessage(failed.error),
                class: "provider_error",
              }),
            },
          });
        },
      );
      if (
        expandAssistantCitationsForProvider(providerMessage.text).length >
        PROVIDER_SEND_TURN_MAX_INPUT_CHARS
      ) {
        yield* settleRunBeforeStart({
          run,
          rootNode,
          attempt,
          turnItems: projection.turnItems,
          signal: "expanded-input-too-long",
          status: "failed",
          now: yield* DateTime.now,
          providerInstanceId: run.providerInstanceId,
          itemProviderThreadId: providerThread.id,
          item: {
            type: "error",
            title: "Message is too long",
            failure: makeProviderFailure({
              class: "validation_error",
              message: `Message exceeds ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS.toLocaleString("en-US")} characters after expanding quotes. Shorten it and try again.`,
            }),
          },
        });
        return;
      }
      if (
        providerMessage.attachments.length === 0 &&
        providerMessage.text.trimStart().startsWith("/")
      ) {
        const isEmptyCompaction =
          providerMessage.text.trim().toLowerCase() === "/compact" && !projection.hasConversation;
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
                  text: providerMessage.text,
                  records: providerMessage.context?.records ?? [],
                }),
                hasAttachments: false,
                // A scheduled delivery keeps its task author's createdBy.
                sentByPerson:
                  providerMessage.createdBy === "user" &&
                  providerMessage.scheduledTaskId === undefined,
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
          yield* settleRunStartup({
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
                    input: providerMessage.text.trim(),
                    output: "Provider signed out",
                    exitCode: 0,
                  },
            providerThreadUpdate: {
              ...providerThread,
              status:
                providerThread.status === "error"
                  ? "error"
                  : providerThread.nativeThreadRef === null
                    ? "not_loaded"
                    : "idle",
              updatedAt: now,
            },
          });
          return;
        }
      }
      const { worktreePath } = projection.thread;
      const isSlipJayWorkspace =
        worktreePath !== null &&
        isSlipJayWorkspacePath(
          path.resolve(worktreePath),
          yield* HostProcess.HomeDirectory,
          path.sep,
        );
      if (isSlipJayWorkspace && !(yield* fileSystem.exists(worktreePath))) {
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
        } else {
          yield* Effect.logWarning(
            "provider turn start could not restore a released SlipJay workspace",
            {
              threadId: projection.thread.id,
              worktreePath,
              reason: restored.reason,
            },
          );
        }
      }
      const recreateResult = yield* Effect.result(restoreMissingWorktree(projection.thread));
      if (recreateResult._tag === "Failure") {
        if (input.willRetry === true) return yield* recreateResult.failure;
        yield* settleStartFailure({
          signal: "worktree-recreate-failure",
          title: "Couldn't recreate thread workspace",
          error: recreateResult.failure,
          message: recreateResult.failure.message,
        });
        return;
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
          yield* settleRunStartup({
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
      const workspaceMissing =
        worktreePath !== null &&
        !(yield* fileSystem.exists(worktreePath).pipe(Effect.orElseSucceed(() => true)));
      const invalidWorkspace = yield* managedWorkspaceInvalid({
        thread: projection.thread,
        worktreePath,
        workspaceMissing,
        getProject: projects.getById,
        services: { fileSystem, path, processes },
      });
      // A provider never starts in a missing directory: it would run somewhere
      // else or fail without saying why. The run fails with the reason instead.
      if (worktreePath !== null && (workspaceMissing || invalidWorkspace)) {
        const now = yield* DateTime.now;
        yield* settleRunStartup({
          signal: "workspace-missing",
          status: "failed",
          now,
          providerInstanceId: run.providerInstanceId,
          itemProviderThreadId: providerThread.id,
          item: {
            type: "error",
            title: invalidWorkspace ? "Workspace invalid" : "Workspace missing",
            failure: makeProviderFailure({
              class: "validation_error",
              message: `The thread's workspace ${worktreePath} ${invalidWorkspace ? "could not be confirmed as a checkout of the project's repository" : "no longer exists"}.${
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
      const recoveryResult = yield* Effect.result(
        projectionStore.getRuntimeRecoveryProjection(projection.thread.id),
      );
      if (recoveryResult._tag === "Failure") {
        if (input.willRetry === true) return yield* recoveryResult.failure;
        yield* settleStartFailure({
          signal: "runtime-recovery-read-failure",
          title: "Couldn't read thread state",
          error: recoveryResult.failure,
        });
        return;
      }
      const inheritedBackgroundTurnItems = selectInheritedBackgroundItems(recoveryResult.success);
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

      const resolvedPolicy = yield* runtimePolicy
        .resolve({
          thread:
            isSideChatThread(projection.thread) &&
            (sideChatHandoff !== undefined ||
              !projection.runs.some((previous) => previous.ordinal < run.ordinal))
              ? { ...projection.thread, runtimeMode: "approval-required" }
              : projection.thread,
          modelSelection: run.modelSelection,
        })
        .pipe(Effect.result);
      if (resolvedPolicy._tag === "Failure") {
        const error = resolvedPolicy.failure;
        if (error._tag !== "RuntimePolicyAboveCeilingError") {
          if (input.willRetry === true) return yield* error;
          yield* settleStartFailure({
            signal: "runtime-policy-resolve-failure",
            title: "Provider turn failed to start",
            error,
          });
          return;
        }
        yield* settleStartFailure({
          signal: "runtime-mode-above-ceiling",
          title: "Thread mode is above the policy limit",
          error,
          message: error.message,
        });
        return;
      }
      const resolvedRuntimePolicy = resolvedPolicy.success;
      if (!(yield* isCurrentAttemptInStatus("starting"))) return;
      const plannedCompaction = yield* claudeCompaction.plan({
        projection,
        providerThread,
        run,
        message,
      });
      const compactionPlan = plannedCompaction.plan;
      if (compactionPlan.kind === "summary") {
        const outcome = yield* claudeCompaction.compactOnAnotherAccount({
          projection,
          providerThread,
          run,
          message,
          planned: { ...plannedCompaction, plan: compactionPlan },
          cwd: resolvedRuntimePolicy.cwd ?? "",
          willRetry: input.willRetry === true,
          startError: (cause) => new ProviderTurnStartError({ runId, cause }),
        });
        if (outcome._tag === "Retry") return yield* outcome.error;
        yield* settleRunStartup(outcome.settle);
        return;
      }
      const existingSessionProjection = projection.providerSessions.find(
        (candidate) => candidate.id === providerSessionId,
      );
      // A run that ended without completing can leave its provider turn projected as
      // running when the agent ignored Stop or an interrupt timed out. Every attempt
      // of such a run owns a possible abandoned turn, including attempts a steering
      // restart superseded, and the session cannot be reused until those turns stop.
      const abandonedTurns = abandonedProviderTurns(projection, run, providerThread.id);
      const abandonedTurn = abandonedTurns.at(-1)?.turn;
      if (abandonedTurn !== undefined) {
        const liveSession = yield* providerSessions.get(providerSessionId);
        if (Option.isSome(liveSession)) {
          // The run already ended without stopping its provider — a failed start, an
          // ignored Stop, or an interrupt that never confirmed. Recover that exact
          // turn before reusing its native conversation.
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
          events: yield* Effect.forEach(abandonedTurns, ({ turn, run: abandonedRun }) =>
            Effect.gen(function* () {
              return {
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                type: "provider-turn.updated" as const,
                threadId: projection.thread.id,
                runId: abandonedRun.id,
                nodeId: turn.nodeId,
                providerInstanceId: abandonedRun.providerInstanceId,
                occurredAt: completedAt,
                payload: { ...turn, status: "interrupted" as const, completedAt },
              };
            }),
          ),
        });
        if (!repaired.committed) return;
      }
      const nativeForkSource =
        nativeForkTransfer === undefined
          ? undefined
          : yield* Effect.gen(function* () {
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
              return { sourceProjection, sourceProviderThread, sourceProviderTurn };
            });
      const initialRegistration = AgentMcpServers.registrationForThread(
        nativeForkSource?.sourceProviderThread ?? providerThread,
      );
      const brokenNativeThread = providerThread.status === "error";
      // Opened without the broken native id, a session that was not live starts fresh.
      const opensFreshSession =
        brokenNativeThread &&
        providerThread.nativeThreadRef !== null &&
        !(yield* providerSessions.isLive(providerSessionId));
      const openSession = (registration: AgentMcpServers.Registration, fresh = false) =>
        providerSessions.open({
          agentMcpRegistration: registration,
          threadId: projection.thread.id,
          providerSessionId,
          modelSelection: run.modelSelection,
          runtimePolicy: resolvedRuntimePolicy,
          ...(fresh || existingSessionProjection === undefined
            ? {}
            : { resumeFromSession: existingSessionProjection }),
          ...(fresh || providerThread.nativeThreadRef?.nativeId == null || brokenNativeThread
            ? {}
            : { initialNativeThreadId: providerThread.nativeThreadRef.nativeId }),
          ...(fresh || providerThread.nativeMetadata?.itemIdentityVersion === undefined
            ? {}
            : {
                initialProviderItemIdentityVersion:
                  providerThread.nativeMetadata.itemIdentityVersion,
              }),
        });
      // Opening a session does not prompt the provider, so the workspace is still unchanged.
      const baseline = yield* runExecution.forkBaseline({
        appThread: projection.thread,
        run,
        checkpointScope,
      });
      const sessionResult = yield* Effect.result(openSession(initialRegistration));
      if (sessionResult._tag === "Failure") {
        const failure = sessionResult.failure;
        const requiresSignIn =
          "cause" in failure &&
          isProviderAdapterOpenSessionError(failure.cause) &&
          failure.cause.requiresSignIn === true;
        if (input.willRetry === true && !requiresSignIn) return yield* failure;
        yield* settleStartFailure({
          signal: "provider-session-open-failure",
          title: "Provider session failed to open",
          error: sessionResult.failure,
        });
        return;
      }
      let session = sessionResult.success;
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
      let resumeFellBack = false;
      const userText = withSenderNoteUnlessScheduled(
        providerMessage,
        projectComposerContextForProvider({
          text: providerMessage.text,
          records: providerMessage.context?.records ?? [],
        }),
      );
      // Native goal commands go verbatim; handoff history waits a turn.
      const goalDriver =
        session.driver === "codex" ||
        session.driver === "claudeAgent" ||
        session.providerSession.capabilities.turns.supportsNativeGoals === true;
      const goalCommand = goalDriver && parseGoalCommand(providerMessage) !== null;
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
        compactionMessageIds: () =>
          new Set(
            projection.messages
              .filter(
                (candidate) =>
                  isCompactionCommandMessage(candidate) ||
                  (goalDriver && parseGoalCommand(candidate) !== null),
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
      const handoffContextForThread = (loadedProviderThread: OrchestrationV2ProviderThread) => {
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
          loadedProviderThread.nativeThreadRef?.nativeId ===
          providerThread.nativeThreadRef?.nativeId;
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
        const settledHandoffs = projection.contextHandoffs.filter(
          (handoff) =>
            handoff.toProviderThreadId === providerThread.id &&
            handoff.delivery?.nativeThreadId === loadedProviderThread.nativeThreadRef?.nativeId &&
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
                source.nativeThreadId === loadedProviderThread.nativeThreadRef?.nativeId,
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
        // Row identity survives recovery; only accepted native input and delivered history occupy the new session.
        const nativeContextEstimate = Effect.gen(function* () {
          return sameNativeThread
            ? (yield* projectionStore.getTurnStartHistory(input.threadId)).reduce((sum, item) => {
                const acceptedNatively =
                  item.providerThreadId === providerThread.id &&
                  item.runId !== null &&
                  (nativeInputRunIds.has(item.runId) ||
                    (legacyInputRunIds.has(item.runId) &&
                      !coveredItemIds.has(item.id) &&
                      !legacyRecoveredRunIds.has(item.runId)));
                if (item.runId === run.id || (!acceptedNatively && !deliveredItemIds.has(item.id)))
                  return sum;
                const nativeAttachments =
                  item.type === "user_message" && acceptedNatively
                    ? attachmentTokenAllowance(item.attachments)
                    : 0;
                return sum + historicalTokens(item) + nativeAttachments;
              }, 0)
            : 0;
        });
        const modelContextWindow =
          knownModelWindow ??
          (handoffUsage !== null || reuseTelemetry ? previousUsage?.maxTokens : undefined);
        const budgetProviderThread = {
          ...loadedProviderThread,
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
        return {
          sameNativeThread,
          handoffUsage,
          deliveredItemIds,
          coveredItemIds,
          acceptedAttempts,
          nativeInputRunIds,
          legacyInputRunIds,
          missedRuns,
          missedRunIds,
          budget: Effect.gen(function* () {
            return handoffBudget({
              tokenCap,
              modelContextWindow,
              userText: restartNote === "" ? userText : `${restartNote}\n\n${userText}`,
              attachments: providerMessage.attachments,
              providerThread: budgetProviderThread,
              nativeContextEstimate:
                budgetProviderThread.contextUsage?.usedTokens === undefined
                  ? yield* nativeContextEstimate
                  : 0,
            });
          }),
        };
      };
      const prepareRetryHandoff = Effect.fn("ProviderTurnStartService.prepareRetryHandoff")(
        function* (context: ReturnType<typeof handoffContextForThread>) {
          const { missedRunIds, coveredItemIds, missedRuns, acceptedAttempts } = context;
          const missedHistory =
            missedRunIds.size === 0
              ? []
              : (yield* projectionStore.getTurnStartHistory(input.threadId, [
                  ...missedRunIds,
                ])).filter((item) => item.runId !== null && missedRunIds.has(item.runId));
          const missedItems = missedHistory.filter(
            (item) => !coveredItemIds.has(item.id) && historicalMessage(item) !== null,
          );
          // The resume fallback summary already covers every earlier run in order. A
          // retry copy after it would rank older missed requests as the newest history.
          const handoffs =
            missedItems.length === 0 || resumeFellBack
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
          // History delivery (inline or injected) is text only, so missed images ride on prompts
          // until a later run's is accepted. Compaction and /goal starts carry none. A missed run's
          // own accepted attempt predates its unsent steering input, so it does not count.
          const runsById = new Map(projection.runs.map((source) => [source.id, source]));
          const messagesById = new Map(projection.messages.map((message) => [message.id, message]));
          let lastPromptOrdinal = 0;
          for (const attempt of acceptedAttempts) {
            if (missedRunIds.has(attempt.runId)) continue;
            const source = runsById.get(attempt.runId);
            if (source === undefined) continue;
            const message = messagesById.get(source.userMessageId);
            if (
              message !== undefined &&
              (isCompactionCommandMessage(message) ||
                (goalDriver && parseGoalCommand(message) !== null))
            )
              continue;
            lastPromptOrdinal = Math.max(lastPromptOrdinal, source.ordinal);
          }
          const attachments = missedHistory.flatMap((item) =>
            item.type === "user_message" &&
            item.runId !== null &&
            (runsById.get(item.runId)?.ordinal ?? 0) > lastPromptOrdinal
              ? item.attachments
              : [],
          );
          return { handoffs, attachments };
        },
      );
      const prepareRecoveryHandoff = Effect.fn("ProviderTurnStartService.prepareRecoveryHandoff")(
        function* () {
          const transferId = yield* idAllocator.allocate.contextTransfer({
            sourceThreadId: projection.thread.id,
            targetThreadId: projection.thread.id,
            type: "provider_resume_fallback",
          });
          const createdAt = yield* DateTime.now;
          const history = yield* projectionStore.getTurnStartHistory(input.threadId);
          const boundary = contextBoundaryOrdinal({ runs: projection.runs, turnItems: history });
          const from = Math.max(1, boundary);
          const handoff = yield* contextHandoffService.prepareProviderHandoff({
            threadId: projection.thread.id,
            targetRunId: run.id,
            transferId,
            fromProviderThreadIds: [providerThread.id],
            toProviderThreadId: providerThread.id,
            fromProviderInstanceId: providerThread.providerInstanceId,
            toProviderInstanceId: run.providerInstanceId,
            coveredRunOrdinals: { from, to: Math.max(from, run.ordinal - 1) },
            strategy: "full_thread_summary",
            runs: projection.runs,
            items: [
              ...(boundary === 0
                ? yield* ContextHandoffService.readInheritedHandoffItems(
                    projectionStore,
                    projection.thread,
                  )
                : []),
              ...history.filter((item) =>
                item.runId === null
                  ? boundary === 0
                  : projection.runs.some(
                      (source) =>
                        source.id === item.runId &&
                        source.ordinal >= boundary &&
                        source.ordinal < run.ordinal &&
                        source.status !== "rolled_back",
                    ),
              ),
            ],
            createdAt,
          });
          return { handoff, transferId, createdAt };
        },
      );
      const recoveryHandoff = yield* Effect.cached(prepareRecoveryHandoff());
      const withRecoveryHandoff = (handoff: OrchestrationV2ContextHandoff) => {
        // Delivery ranks later handoffs as newer history. Pending handoffs from
        // earlier runs predate this summary; handoffs for this run (provider-switch
        // delta, merge-back) are newer and must stay last.
        return [
          ...effectiveHandoffs.filter((candidate) => candidate.targetRunId !== run.id),
          handoff,
          ...effectiveHandoffs.filter((candidate) => candidate.targetRunId === run.id),
        ];
      };
      let resumedRetryHandoff: Effect.Success<ReturnType<typeof prepareRetryHandoff>> | undefined;
      let resumedHandoffContext: ReturnType<typeof handoffContextForThread> | undefined;
      let portableForkFallback: OrchestrationV2ContextHandoff | undefined;
      let recoveryTurnItem: OrchestrationV2TurnItem | undefined;
      const loadedProviderThread = yield* Effect.gen(function* () {
        if (nativeForkTransfer !== undefined) {
          let sourceProjection = yield* projectionStore.getThreadRecords(
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
          // The source may have started a turn after dispatch planned this fork.
          const sourceBusy = sourceProjection.runs.some(
            (candidate) => candidate.ordinal > sourceRun.ordinal && isActiveRun(candidate),
          );
          let nativeForkFailure: string | undefined;
          if (
            (sourceRun.status === "completed" || sourceRun.status === "waiting") &&
            (!sourceBusy ||
              canForkBusySourceNatively(
                session.providerSession.capabilities,
                sourceProviderTurn?.nativeTurnRef != null,
              ))
          ) {
            // Rolled-back turns are no longer in the source conversation, so they cannot bound a fork.
            const rolledBackAttemptIds = new Set(
              sourceProjection.attempts
                .filter((attempt) =>
                  sourceProjection.runs.some(
                    (candidate) =>
                      candidate.id === attempt.runId && candidate.status === "rolled_back",
                  ),
                )
                .map((attempt) => attempt.id),
            );
            const forked = yield* Effect.result(
              session.forkThread({
                sourceProviderThread,
                sourceProviderTurns: sourceProjection.providerTurns.filter(
                  (turn) =>
                    turn.runAttemptId === null || !rolledBackAttemptIds.has(turn.runAttemptId),
                ),
                targetThreadId: projection.thread.id,
                modelSelection: run.modelSelection,
                runtimePolicy: resolvedRuntimePolicy,
                ...(sourceProviderTurn === undefined
                  ? {}
                  : { providerTurnId: sourceProviderTurn.id }),
              }),
            );
            if (forked._tag === "Success") return forked.success;
            if (input.willRetry === true) return yield* forked.failure;
            if (!(yield* isCurrentAttemptInStatus("starting"))) return undefined;
            // Retries are spent (e.g. the source's native session is gone): start fresh with portable history.
            yield* Effect.logWarning("Starting a native fork in a fresh native session", {
              driver: session.driver,
              providerThreadId: providerThread.id,
              sourceProviderThreadId: sourceProviderThread.id,
              runId,
              errorTag: forked.failure._tag,
            });
            nativeForkFailure = makeProviderFailure({
              cause: forked.failure,
              message: startFailureMessage(forked.failure),
              class: "provider_error",
            }).message;
            sourceProjection = {
              ...sourceProjection,
              ...(yield* projectionStore.getThreadRecords(nativeForkTransfer.sourceThreadId, [
                "runs",
                "attempts",
              ])),
            };
          }
          const nativeForkFailed = nativeForkFailure !== undefined;
          const sourceItems = yield* ContextHandoffService.readForkHistoryItems(
            projectionStore,
            sourceProjection,
            sourceRun,
          );
          const createdAt = yield* DateTime.now;
          const handoff = yield* contextHandoffService.prepareProviderHandoff({
            threadId: projection.thread.id,
            targetRunId: run.id,
            transferId: nativeForkTransfer.id,
            fromProviderThreadIds: [sourceProviderThread.id],
            toProviderThreadId: providerThread.id,
            fromProviderInstanceId: sourceRun.providerInstanceId,
            toProviderInstanceId: run.providerInstanceId,
            coveredRunOrdinals: ContextHandoffService.visibleDeltaRunOrdinals(
              sourceProjection,
              sourceItems,
            ),
            strategy: "full_thread_summary",
            items: sourceItems,
            runs: sourceProjection.runs,
            createdAt,
          });
          const loaded = yield* loadFromProvider(
            session.ensureThread({
              threadId: projection.thread.id,
              title: projection.thread.title,
              modelSelection: run.modelSelection,
              runtimePolicy: resolvedRuntimePolicy,
              providerSessionId,
              existingProviderThread: nativeForkFailed
                ? { ...providerThread, nativeThreadRef: null, forkedFrom: null }
                : { ...providerThread, forkedFrom: null },
              // The failed fork may have left the adapter's session half-switched.
              ...(nativeForkFailed ? { forceNewNativeThread: true } : {}),
            }),
          );
          if (loaded === undefined) return undefined;
          portableForkFallback = handoff;
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
                  ...nativeForkTransfer,
                  targetProviderInstanceId: run.providerInstanceId,
                  status: "resolved_portable",
                  resolution: { strategy: "portable_context", contextHandoffId: handoff.id },
                  error: null,
                  updatedAt: createdAt,
                },
              },
              ...(nativeForkFailure === undefined
                ? []
                : [
                    {
                      id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                      type: "turn-item.updated" as const,
                      threadId: projection.thread.id,
                      runId: run.id,
                      providerInstanceId: run.providerInstanceId,
                      occurredAt: createdAt,
                      payload: {
                        id: idAllocator.derive.runSignalTurnItem({
                          runId,
                          signal: "native-fork-fallback",
                        }),
                        threadId: projection.thread.id,
                        runId,
                        nodeId: rootNode.id,
                        providerThreadId: providerThread.id,
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
                        status: "completed" as const,
                        title: "Native fork failed",
                        startedAt: createdAt,
                        completedAt: createdAt,
                        updatedAt: createdAt,
                        type: "system_notice" as const,
                        message: `Could not fork the source conversation natively (${nativeForkFailure}). Started a fresh session with its history.`,
                      },
                    },
                  ]),
            ],
          });
          return loaded;
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
        // A provider that cannot truncate rolls back into a fresh native session holding none of the kept turns.
        const nativeSessionLacksKeptTurns =
          !session.providerSession.capabilities.checkpointing.providerCanRollbackConversation &&
          nativeSessionMissesKeptTurns(projection, providerThread, run);
        // Dispatch prepares no import handoff for a session import: its history is in the native session.
        const importedNativeSession =
          projection.thread.historyOrigin === "v1_import" &&
          !projection.providerTurns.some((turn) => turn.providerThreadId === providerThread.id) &&
          !projection.contextHandoffs.some(
            (handoff) =>
              handoff.toProviderThreadId === providerThread.id &&
              handoff.strategy === "manual_context",
          );
        const resumed = yield* Effect.result(
          uncertainDelivery || nativeSessionLacksKeptTurns
            ? Effect.fail(
                new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: session.driver,
                  threadId: projection.thread.id,
                  providerThreadId: providerThread.id,
                  runId,
                  cause: uncertainDelivery
                    ? "Uncertain native history injection"
                    : "Native session holds none of the kept conversation",
                }),
              )
            : session.resumeThread({
                providerThread,
                threadId: projection.thread.id,
                modelSelection: run.modelSelection,
                runtimePolicy: resolvedRuntimePolicy,
                importedNativeSession,
              }),
        );
        if (resumed._tag === "Success") {
          const context = handoffContextForThread(resumed.success);
          context.budget = yield* Effect.cached(context.budget);
          resumedHandoffContext = context;
          resumedRetryHandoff = yield* prepareRetryHandoff(context);
          const fits = yield* deliverContextHandoffs({
            handoffs: [...handoffs, ...resumedRetryHandoff.handoffs],
            providerThread: { ...resumed.success, id: providerThread.id },
            budget: context.budget,
            deferInline: isCompactionCommandMessage(providerMessage) || goalCommand,
            alreadyDeliveredItemIds: context.deliveredItemIds,
            persist: () => Effect.void,
          }).pipe(
            Effect.as(true),
            Effect.catchTags({ ContextHandoffBudgetError: () => Effect.succeed(false) }),
          );
          if (fits) return resumed.success;
          const freshThread = { ...resumed.success, nativeThreadRef: null };
          const freshContext = handoffContextForThread(freshThread);
          const { handoff } = yield* recoveryHandoff;
          const fitsFresh = yield* deliverContextHandoffs({
            handoffs: withRecoveryHandoff(handoff),
            providerThread: freshThread,
            budget: freshContext.budget,
            alreadyDeliveredItemIds: freshContext.deliveredItemIds,
            persist: () => Effect.void,
          }).pipe(
            Effect.as(true),
            Effect.catchTags({ ContextHandoffBudgetError: () => Effect.succeed(false) }),
          );
          if (!fitsFresh) return resumed.success;
          const hasPendingWork = yield* (
            session.hasPendingBackgroundWorkForThread?.(resumed.success, {
              includeSubagents: true,
            }) ??
              session.hasPendingBackgroundWork ??
              Effect.succeed(false)
          );
          if (hasPendingWork) {
            return yield* loadFromProvider(
              Effect.fail(
                new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: session.driver,
                  threadId: projection.thread.id,
                  providerThreadId: providerThread.id,
                  runId,
                  cause: new ContextHandoffBackgroundWorkError(),
                }),
              ),
            );
          }
        }
        resumedHandoffContext = undefined;
        resumedRetryHandoff = undefined;
        if (!(yield* isCurrentAttemptInStatus("starting"))) return undefined;
        // Another client is still writing to the native thread. A fresh
        // session here would silently split the conversation from it.
        if (
          resumed._tag === "Failure" &&
          resumed.failure._tag === "ProviderAdapterThreadInUseError"
        ) {
          return yield* loadFromProvider(Effect.fail(resumed.failure));
        }

        yield* Effect.logWarning("Recovering provider context in a fresh native session", {
          driver: session.driver,
          providerThreadId: providerThread.id,
          runId,
          reason: uncertainDelivery
            ? "uncertain_history_delivery"
            : nativeSessionLacksKeptTurns
              ? "native_session_lacks_kept_turns"
              : resumed._tag === "Success"
                ? "handoff_budget_exhausted"
                : "resume_failed",
          errorTag: resumed._tag === "Failure" ? resumed.failure._tag : "ContextHandoffBudgetError",
        });
        const catalogue = yield* reopenWithCanonicalCatalogue({
          initialRegistration,
          session,
          pendingBackgroundWork: session.hasPendingBackgroundWork,
          resumeFailure: resumed._tag === "Failure" ? resumed.failure : undefined,
          isStarting: Effect.suspend(() => isCurrentAttemptInStatus("starting")),
          openCanonical: Effect.suspend(() => openSession("canonical", true)),
        });
        if (catalogue._tag === "Stopped") return undefined;
        if (catalogue._tag === "Refused") {
          if (input.willRetry === true && catalogue.retry !== undefined)
            return yield* catalogue.retry;
          yield* settleStartFailure(catalogue);
          return undefined;
        }
        if (catalogue._tag === "Reopened") session = catalogue.session;
        const replacement = yield* loadFromProvider(
          session.ensureThread({
            threadId: projection.thread.id,
            title: projection.thread.title,
            modelSelection: run.modelSelection,
            runtimePolicy: resolvedRuntimePolicy,
            providerSessionId,
            // Clear the native ref to force a fresh session while preserving row identity.
            existingProviderThread: { ...providerThread, nativeThreadRef: null },
            // A fresh session that never loaded the broken history needs no replacement.
            ...(opensFreshSession && resumed._tag === "Failure"
              ? {}
              : { forceNewNativeThread: true }),
          }),
        );
        if (replacement === undefined) return undefined;
        if (
          replacement.nativeThreadRef?.nativeId != null &&
          replacement.nativeThreadRef.driver === providerThread.nativeThreadRef?.driver &&
          replacement.nativeThreadRef.nativeId === providerThread.nativeThreadRef.nativeId
        ) {
          // Never retried. Forget the load first, or the next turn would skip resume and start on
          // the reused session without this error or the recovery handoff.
          yield* providerSessions.forgetLoadedProviderThread({
            providerSessionId: session.providerSessionId,
            threadId: projection.thread.id,
            providerThread: replacement,
            modelSelection: run.modelSelection,
            runtimePolicy: resolvedRuntimePolicy,
          });
          yield* settleStartFailure({
            signal: "provider-thread-load-failure",
            title: "Provider turn failed to start",
            error: new ProviderAdapter.ProviderAdapterProtocolError({
              driver: session.driver,
              detail:
                "the provider returned its existing session when asked for a fresh one, so the conversation context could not be moved to a new session",
            }),
          });
          return undefined;
        }
        const { handoff, transferId, createdAt } = yield* recoveryHandoff;
        const previousRun = projection.runs.findLast(
          (candidate) =>
            candidate.providerThreadId === providerThread.id &&
            candidate.ordinal < run.ordinal &&
            candidate.startedAt !== null,
        );
        // Stable per run so a retried start reuses the reserved run-start position.
        const handoffTurnItemId = idAllocator.derive.runSignalTurnItem({
          runId,
          signal: "resume-fallback-handoff",
        });
        const handoffTurnItem: OrchestrationV2TurnItem = {
          id: handoffTurnItemId,
          threadId: projection.thread.id,
          runId,
          nodeId: rootNode.id,
          providerThreadId: providerThread.id,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          // The summary is delivered ahead of this run's own handoffs and message.
          ordinal: yield* turnItemPositions.allocate({
            threadId: projection.thread.id,
            turnItemId: handoffTurnItemId,
            runId,
            runOrdinal: run.ordinal,
            placement: "run_start",
          }),
          status: "completed",
          title: "Recovered context",
          startedAt: createdAt,
          completedAt: createdAt,
          updatedAt: createdAt,
          type: "handoff",
          contextHandoffId: handoff.id,
          fromProviderThreadIds: handoff.fromProviderThreadIds,
          toProviderThreadId: handoff.toProviderThreadId,
          fromProviderInstanceIds: [providerThread.providerInstanceId],
          toProviderInstanceId: run.providerInstanceId,
          fromModelSelections: previousRun === undefined ? [] : [previousRun.modelSelection],
          toModel: run.modelSelection.model,
          strategy: handoff.strategy,
          summary: handoff.summaryText,
        };
        const replacementWrite = yield* eventSink.writeIfRunCurrent({
          threadId: projection.thread.id,
          runId: run.id,
          activeAttemptId: attempt.id,
          expectedStatus: "starting",
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
        if (!replacementWrite.committed) return undefined;
        effectiveHandoffs = withRecoveryHandoff(handoff);
        resumeFellBack = true;
        recoveryTurnItem = handoffTurnItem;
        return replacement;
      });
      if (loadedProviderThread === undefined) return;
      if (!(yield* isCurrentAttemptInStatus("starting"))) {
        return;
      }
      const now = yield* DateTime.now;
      const handoffContext = resumedHandoffContext ?? handoffContextForThread(loadedProviderThread);
      const {
        sameNativeThread,
        handoffUsage,
        deliveredItemIds,
        acceptedAttempts,
        nativeInputRunIds,
        legacyInputRunIds,
        budget,
      } = handoffContext;
      if (manualResume && unsentResumeMessage === undefined && session.resumeTurn === undefined) {
        yield* settleStartFailure({
          signal: "resume-unsupported",
          title: "Native resume is unavailable",
          error: new ProviderAdapter.ProviderResumeUnsupportedError({
            driver: session.driver,
            providerThreadId: providerThread.id,
          }),
        });
        return;
      }
      const retryHandoff = resumedRetryHandoff ?? (yield* prepareRetryHandoff(handoffContext));
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
        handoffIds:
          portableForkFallback === undefined
            ? providerThread.handoffIds
            : [...providerThread.handoffIds, portableForkFallback.id],
        forkedFrom: portableForkFallback === undefined ? providerThread.forkedFrom : null,
        status: "active",
        createdAt: providerThread.createdAt,
        updatedAt: now,
      };
      const runningRun: OrchestrationV2Run = {
        ...run,
        status: "running",
        startedAt: run.startedAt ?? now,
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
        ...(nativeForkTransfer === undefined ||
        portableForkFallback !== undefined ||
        runningProviderThread.nativeThreadRef === null
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
        // Shown only once the replacement session commits with the running transition.
        ...(recoveryTurnItem === undefined
          ? []
          : [
              {
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                type: "turn-item.updated" as const,
                threadId: projection.thread.id,
                runId: run.id,
                providerInstanceId: run.providerInstanceId,
                occurredAt: now,
                payload: recoveryTurnItem,
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
      const settleRunningStartupFailure = Effect.fn(
        "ProviderTurnStartService.settleRunningStartupFailure",
      )(function* <E>(cause: Cause.Cause<E>) {
        if (Cause.hasInterruptsOnly(cause)) return yield* Effect.failCause(cause);
        // Startup already committed running; retrying its outbox effect cannot start it again.
        return yield* settleRunStartup({
          signal: "provider-execution-start-failure",
          status: "failed",
          execution: { run: runningRun, attempt: runningAttempt, node: runningRootNode },
          now: yield* DateTime.now,
          providerInstanceId: run.providerInstanceId,
          itemProviderThreadId: runningProviderThread.id,
          item: {
            type: "error",
            title: "Provider startup failed",
            failure: makeProviderFailure({
              cause: Cause.squash(cause),
              message: "Provider startup failed.",
              class: "provider_error",
            }),
          },
        });
      });
      return yield* Effect.gen(function* () {
        // Delegated (app_owned) children run their own runs; routing them here ingests their items twice.
        const routableSubagents = projection.subagents.filter(
          (subagent) =>
            subagent.origin === "provider_native" &&
            RunExecutionService.canRouteRelatedSubagent(subagent.status),
        );
        const persistHandoff = Effect.fn("ProviderTurnStartService.persist")(function* (
          handoff: OrchestrationV2ContextHandoff,
        ) {
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
        });
        // The notes this turn adds to the user's message. A turn with any of them goes through
        // context delivery, which writes them.
        const offersProjectSuggestion =
          !isSideChatThread(projection.thread) &&
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
        const workspaceNotes = yield* turnWorkspaceNotes({
          thread: projection.thread,
          managedAgent: resolvedRuntimePolicy.managedAgent === true,
          getProject: projects.getById,
          services: { fileSystem, path, processes },
        });
        // Native slash commands must remain at the start of the prompt, so they carry no note.
        const slashCommand =
          providerMessage.attachments.length === 0 &&
          providerMessage.text.trimStart().startsWith("/");
        const stanceNote = slashCommand
          ? ""
          : yield* threadStanceNote(managedAgents, {
              thread: projection.thread,
              modelSelection: run.modelSelection,
            });
        const workItem = projection.thread.workItem ?? null;
        const workItemSummary =
          slashCommand || workItem === null || Option.isNone(forgeWorkItems)
            ? Option.none()
            : yield* forgeWorkItems.value.cachedSummary(workItem);
        // A thread nobody has open has no cached read: start one so a later turn has the details.
        if (
          !slashCommand &&
          workItem !== null &&
          Option.isSome(forgeWorkItems) &&
          Option.isNone(workItemSummary)
        )
          yield* forgeWorkItems.value.warmSummary(workItem).pipe(Effect.ignoreCause);
        const workItemNote =
          slashCommand || workItem === null
            ? ""
            : linkedForgeItemNote(workItem.number, workItemSummary);
        const arcRunNote =
          projection.thread.arcRun === undefined ||
          goalCommand ||
          message.id.startsWith(ARC_RUN_WAKE_MESSAGE_PREFIX)
            ? ""
            : describeArcRun(projection.thread.arcRun);
        const startWithHandoffs = Effect.fn("ProviderTurnStartService.startWithHandoffs")(
          function* (turnInput: Parameters<typeof session.startTurn>[0], compact = false) {
            const delivery = yield* deliverContextHandoffs({
              handoffs: [...effectiveHandoffs, ...retryHandoff.handoffs],
              deferInline: compact || goalCommand,
              providerThread: runningProviderThread,
              budget,
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
              persist: persistHandoff,
            });
            if (!(yield* isCurrentAttemptInStatus("running"))) return;
            const start = compact ? session.compactThread! : session.startTurn;
            // Like history, the side chat context waits for a turn that sends a prompt.
            const sideChatContext =
              sideChatHandoff === undefined || compact || goalCommand
                ? ""
                : sideChatHandoff.summaryText;
            const context = [
              compact ? "" : stanceNote,
              compact ? "" : workItemNote,
              delivery.context,
              sideChatContext,
              restartNote,
              compact ? "" : arcRunNote,
              isSideChatThread(projection.thread) ? SIDE_CHAT_NOTE : "",
              offersProjectSuggestion ? NO_PROJECT_NOTE : "",
              workspaceNotes.projectFolder,
              workspaceNotes.workspaces,
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
            const startInput = noteContinuation ? promptedInput : turnInput;
            const { resume: _resume, ...contextInput } = startInput;
            const { message: resumeMessage, resume: _resumeIntent, ...resumeInput } = startInput;
            const missedAttachments =
              compact || goalCommand
                ? []
                : retryHandoff.attachments.filter(
                    (missed) =>
                      !turnInput.message.attachments.some((current) => current.id === missed.id),
                  );
            // Like pending history, pending images need a prompt; native resume carries none.
            // The per-turn notes alone do not: a resumed turn continues one that had them.
            const prompted =
              [delivery.context, sideChatContext, restartNote].some((part) => part !== "") ||
              missedAttachments.length > 0;
            // A resume that must be prompted still needs a request, or the agent has nothing to do.
            const requestText =
              turnInput.resume && prompted && userText === "" ? RESUME_PROMPT : userText;
            const text = goalCommand
              ? userText
              : context === ""
                ? requestText
                : `${context}\n\n${messageLabel}:\n${requestText}`;
            const operation =
              turnInput.resume && !prompted && session.resumeTurn !== undefined
                ? session.resumeTurn({ ...resumeInput, messageId: resumeMessage.messageId })
                : start({
                    ...(prompted ? contextInput : startInput),
                    message: {
                      ...turnInput.message,
                      text,
                      ...(missedAttachments.length === 0
                        ? {}
                        : {
                            attachments: [...missedAttachments, ...turnInput.message.attachments],
                          }),
                    },
                    ...(text === userText
                      ? {}
                      : { inlineContextLength: text.length - userText.length }),
                  });
            yield* operation.pipe(
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
            const nativeThreadId = runningProviderThread.nativeThreadRef?.nativeId;
            yield* Effect.forEach(
              [
                delivery.delivered,
                ...(sideChatContext === "" ||
                sideChatHandoff === undefined ||
                nativeThreadId == null
                  ? []
                  : [
                      persistHandoff({
                        ...sideChatHandoff,
                        toProviderThreadId: runningProviderThread.id,
                        delivery: { nativeThreadId, status: "inline" as const, itemIds: [] },
                      }),
                    ]),
              ],
              (record) =>
                record.pipe(
                  Effect.catchCause(() =>
                    Effect.logWarning("Failed to record accepted context handoff delivery", {
                      runId: run.id,
                      deliveryStatus: "pending",
                    }),
                  ),
                ),
              { discard: true },
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
          stanceNote === "" &&
          workItemNote === "" &&
          effectiveHandoffs.length === 0 &&
          retryHandoff.handoffs.length === 0 &&
          retryHandoff.attachments.length === 0 &&
          sideChatHandoff === undefined &&
          restartNote === "" &&
          arcRunNote === "" &&
          !noteContinuation &&
          !isSideChatThread(projection.thread) &&
          !scheduled &&
          !offersProjectSuggestion &&
          workspaceNotes.projectFolder === "" &&
          workspaceNotes.workspaces === "" &&
          replaced === null
            ? session
            : makeDeliverySession(session, startWithHandoffs);
        const { frames: videoFrames, guide: videoGuide } =
          yield* videoFramesService.framesForMessage(providerMessage.attachments);
        const compaction =
          compactionPlan.kind === "provider"
            ? { modelSelection: compactionPlan.modelSelection }
            : compactionPlan.kind === "windowTooSmall"
              ? { windowTooSmall: true }
              : undefined;
        return runExecution
          .startRootRun({
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
            baseline,
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
            resume: manualResume && unsentResumeMessage === undefined,
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
            hasWorkspaceMoved: runControls.hasWorkspaceMoved,
            loadUnsettledWork: runControls.loadUnsettledWork,
            message: {
              messageId: message.id,
              text: videoGuide === "" ? userText : `${userText}\n\n${videoGuide}`,
              attachments: providerMessage.attachments,
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
          })
          .pipe(Effect.catchCause(settleRunningStartupFailure));
      }).pipe(
        Effect.catchCause((cause) => settleRunningStartupFailure(cause).pipe(Effect.as(undefined))),
      );
    });

    return ProviderTurnStartServiceV2.of({
      start: Effect.fn("ProviderTurnStartService.start")(
        function* (input) {
          let startingRun: OrchestrationV2Run | undefined;
          const captureStartingRun = (run: OrchestrationV2Run) => {
            startingRun = run;
          };
          return yield* Effect.gen(function* () {
            // Storage cleanup removes worktrees under the same lease. Only startup
            // holds it; the provider turn runs after it is released.
            const { thread } = yield* projectionStore.getThreadRecords(input.threadId, []);
            const cwd =
              thread.worktreePath ??
              (yield* projects
                .getById(thread.projectId, { includeDeleted: true })
                .pipe(Effect.map((project) => Option.getOrUndefined(project)?.workspaceRoot)));
            const providerTurn = yield* cwd === undefined
              ? start(input, captureStartingRun)
              : withTurnStartReservation(
                  fileSystem,
                  path,
                  path.resolve(cwd),
                  thread.worktreePath === null
                    ? start(input, captureStartingRun)
                    : withWorkspaceLease(
                        path.resolve(thread.worktreePath),
                        start(input, captureStartingRun),
                      ),
                );
            if (providerTurn !== undefined) {
              // Run execution owns finalization after the running write. A later
              // failure must not settle a replacement attempt committed by steering.
              yield* providerTurn.pipe(
                Effect.catchCauseIf(
                  (cause) => !Cause.hasInterruptsOnly(cause),
                  (cause) =>
                    Effect.logWarning(
                      "Run execution failed after starting",
                      { runId: input.runId },
                      cause,
                    ),
                ),
              );
            }
          }).pipe(
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) =>
                Effect.fail(
                  new ProviderTurnStartError({
                    runId: input.runId,
                    cause: Cause.squash(cause),
                    ...(startingRun?.activeAttemptId == null || startingRun.rootNodeId == null
                      ? {}
                      : {
                          attemptId: startingRun.activeAttemptId,
                          rootNodeId: startingRun.rootNodeId,
                        }),
                  }),
                ),
            ),
          );
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
      failStartingRun: Effect.fn("ProviderTurnStartService.failStartingRun")(
        function* ({ threadId, runId, attemptId, rootNodeId }) {
          const projection = yield* projectionStore.getTurnStartContext(threadId, runId);
          const run = projection.runs.find((candidate) => candidate.id === runId);
          if (
            run === undefined ||
            run.status !== "starting" ||
            run.activeAttemptId !== attemptId ||
            run.rootNodeId !== rootNodeId
          )
            return;
          const rootNode = projection.nodes.find((candidate) => candidate.id === run.rootNodeId);
          const attempt = projection.attempts.find(
            (candidate) => candidate.id === run.activeAttemptId,
          );
          if (rootNode === undefined || attempt === undefined) {
            return yield* new ProviderTurnStartRunStateMissingError({ runId });
          }
          yield* settleRunBeforeStart({
            run,
            rootNode,
            attempt,
            turnItems: projection.turnItems,
            signal: "provider-turn-start-failure",
            status: "failed",
            now: yield* DateTime.now,
            providerInstanceId: run.providerInstanceId,
            itemProviderThreadId: run.providerThreadId,
            item: {
              type: "error",
              title: "Turn failed to start",
              failure: makeProviderFailure({ message: START_GAVE_UP_MESSAGE }),
            },
          });
        },
        (effect, { runId }) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isProviderTurnStartRunStateMissingError(cause)
                ? cause
                : new ProviderTurnStartError({ runId, cause }),
            ),
          ),
      ),
    });
  }),
);
