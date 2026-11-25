import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { ChatAttachment, ForgeWorkItemSummary } from "@t3tools/contracts";
import * as ProcessRunner from "../processRunner.ts";
import * as VideoFrames from "../videoFrames/VideoFrames.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, vi } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import {
  CheckpointScopeId,
  ContextHandoffId,
  ContextTransferId,
  MessageId,
  NodeId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSetupError,
  RunAttemptId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  ProjectId,
  type OrchestrationV2ProviderTurnTokenUsage,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  OrchestrationV2DomainEvent,
} from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ManagedAgent from "../agents/ManagedAgentService.ts";
import { delegationStanceNote } from "../agents/delegationStanceNote.ts";
import * as ForgeWorkItems from "../weave/ForgeWorkItems.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as ProviderUsageAnalytics from "../telemetry/ProviderUsageAnalytics.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

const isDomainEvent = Schema.is(OrchestrationV2DomainEvent);

const managedWorktreesDir = "/tmp/provider-turn-start-worktrees";
const layerWorktreeLocation = (
  worktreesDir = managedWorktreesDir,
  config: Partial<ServerConfig.ServerConfig["Service"]> = {},
  settings: Parameters<typeof ServerSettings.layerTest>[0] = {},
) =>
  Layer.mergeAll(
    Path.layer,
    Layer.mock(ServerConfig.ServerConfig)({
      worktreesDir,
      baseDir: "/tmp/provider-turn-start-data",
      ...config,
    } as ServerConfig.ServerConfig["Service"]),
    ServerSettings.layerTest(settings),
  );

function makeLocalCommandHarness(input: {
  readonly text: string;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
  readonly attachmentsDir?: string;
  readonly processEnvironment?: NodeJS.ProcessEnv;
  readonly manualContinuation?: boolean;
  readonly nativeResumeUnsupported?: boolean;
  readonly steeringRestart?: boolean;
  readonly nativeGoals?: boolean;
  readonly canForkWhileSourceRunning?: boolean;
  readonly exposesNativeTurnId?: boolean;
  readonly goalDriver?: "opencode" | "antigravity";
  readonly worktreePath?: string;
  readonly projectRoot?: string;
  readonly baseDir?: string;
  /** Defaults to a git branch whenever a worktree is bound; null is a SlipJay workspace. */
  readonly branch?: string | null;
  /** The thread is a delegated task, whose workspace belongs to the work that assigned it. */
  readonly delegated?: boolean;
  readonly deliverTurn?: boolean;
  readonly worktreesDir?: string;
  readonly workspaceRoot?: string;
  readonly gitWorkflow?: GitWorkflow.GitWorkflowService["Service"];
  readonly fileSystem?: FileSystem.FileSystem;
  readonly previousNativeSession?: boolean;
  readonly previousMessages?: ReadonlyArray<string>;
  /** Runs the turn on a Claude conversation with these server settings and prior token usage. */
  readonly claude?: {
    readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
    readonly usages: ReadonlyArray<OrchestrationV2ProviderTurnTokenUsage>;
    /** The Claude instance the thread is routed to; defaults to the built-in default instance. */
    readonly instanceId?: string;
  };
  readonly createdBy?: "agent" | "system";
  readonly serverSettings?: Parameters<typeof ServerSettings.layerTest>[0];
  readonly scheduledTaskId?: ScheduledTaskId;
  readonly logoutFailure?: string;
  readonly openFailure?: unknown;
  readonly ensureThreadFailure?: unknown;
  readonly historyReadFailureAfterFallback?: unknown;
  /** Runs the turn on Pi with this model slug, whose prefix names the account. */
  readonly piModel?: string;
  /** The opened provider session, whose resume decides between native resume and a fallback. */
  readonly resumeSession?: ProviderAdapter.ProviderAdapterV2SessionRuntime;
  /** The thread's stored history; a resume fallback summarises it into a handoff. */
  readonly history?: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly resumeFailure?: ProviderAdapter.ProviderAdapterV2Error;
  readonly interruptOpen?: boolean;
  readonly interruptRunBeforeOpenFailure?: boolean;
  readonly writeFailure?: unknown;
  readonly failReadsAfterRunning?: boolean;
  readonly failFramePreparation?: boolean;
  /** The conversation already has a native session, which a compaction can replace. */
  readonly nativeSession?: boolean;
  readonly nativeResumeFails?: boolean;
  readonly agentMcpRegistration?: "canonical" | "legacy";
  /** The thread's session is replaced by another turn while the summariser writes. */
  readonly sessionMovedDuringSummary?: boolean;
  readonly backgroundTasks?: number;
  /** What the Forge cache holds for the thread's linked item; absent runs without Forge links. */
  readonly forgeSummary?: ForgeWorkItemSummary | null;
  /** The Champion brief the store holds for this thread, when it is an escalation thread. */
  readonly escalationBrief?: string;
  /** Another account that can summarise this thread's compaction. */
  readonly summariser?: {
    readonly instanceId: ProviderInstanceId;
    readonly model: string;
    readonly summary?: string;
    readonly failure?: unknown;
    readonly contextWindowTokens?: number;
  };
  /** The chore worker's next model, which writes the summary when `summariser` fails. */
  readonly fallbackSummariser?: {
    readonly instanceId: ProviderInstanceId;
    readonly model: string;
    readonly summary: string;
  };
  readonly missingProviderSession?: boolean;
  readonly recoveryReadFailure?: string;
  readonly previousTurn?: {
    readonly runStatus: "failed" | "completed" | "interrupted";
    readonly turnStatus: "running" | "completed" | "interrupted";
    readonly differentThread?: boolean;
    readonly liveSession?: boolean;
    readonly interruptFailure?: boolean;
    readonly interruptCurrentRun?: boolean;
    /** Puts the running turn on an attempt a steering restart superseded. */
    readonly supersededTurn?: boolean;
  };
  /**
   * A side chat whose context targets this run, an earlier run that failed or was cancelled before
   * the provider, or an earlier run that delivered it. `nativeForkFrom` plans a native fork of the
   * parent. `switchedProvider` puts the earlier run and its context on another provider thread.
   */
  readonly sideChat?: {
    readonly contextRun: "current" | "failed" | "cancelled" | "delivered";
    readonly unsentResume?: boolean;
    readonly repeatedResume?: boolean;
    readonly acceptedResume?: boolean;
    readonly restartedResume?: boolean;
    readonly nativeForkFrom?: "idle" | "busy";
    readonly sourceBoundary?: "native" | "synthetic";
    readonly sourceRolledBack?: boolean;
    readonly switchedProvider?: boolean;
    readonly threadRuntimeMode?: OrchestrationV2ThreadProjection["thread"]["runtimeMode"];
  };
}) {
  const settledRuns: Array<string> = [];
  const warmedForgeItems: Array<number> = [];
  const now = DateTime.makeUnsafe("2026-09-04T12:00:00Z");
  const threadId = ThreadId.make("thread-native-account-command");
  const runId = RunId.make("run-native-account-command");
  const rootNodeId = NodeId.make("root-native-account-command");
  const attemptId = RunAttemptId.make("attempt-native-account-command");
  const providerThreadId = ProviderThreadId.make("new-provider-thread");
  const providerSessionId = ProviderSessionId.make("new-provider-session");
  const oldProviderThreadId = ProviderThreadId.make("existing-native-provider-thread");
  const oldInstanceId = ProviderInstanceId.make("antigravity-personal");
  const newInstanceId = ProviderInstanceId.make(
    input.piModel !== undefined
      ? "pi"
      : input.claude
        ? (input.claude.instanceId ?? "claudeAgent")
        : "codex-personal",
  );
  const checkpointScopeId = CheckpointScopeId.make("scope-native-account-command");
  const messageId = MessageId.make("message-native-account-command");
  const run: OrchestrationV2ThreadProjection["runs"][number] = {
    ...(input.manualContinuation ? { manualContinuationOfRunId: RunId.make("stopped-run") } : {}),
    id: runId,
    threadId,
    ordinal: 2,
    providerInstanceId: newInstanceId,
    modelSelection: {
      instanceId: newInstanceId,
      model: input.piModel ?? (input.claude ? "claude-sonnet-5-5" : "gpt-5.4"),
    },
    providerThreadId,
    userMessageId: messageId,
    rootNodeId,
    activeAttemptId: attemptId,
    status: "starting",
    requestedAt: now,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  const providerThread: OrchestrationV2ThreadProjection["providerThreads"][number] = {
    id: providerThreadId,
    driver: ProviderDriverKind.make(
      input.claude
        ? "claudeAgent"
        : input.nativeGoals === undefined
          ? "codex"
          : (input.goalDriver ?? "opencode"),
    ),
    providerInstanceId: newInstanceId,
    providerSessionId: input.missingProviderSession === true ? null : providerSessionId,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef:
      input.nativeSession === true
        ? {
            driver: ProviderDriverKind.make("claudeAgent"),
            nativeId: "existing-session",
            strength: "strong",
          }
        : null,
    nativeConversationHeadRef: null,
    ...(input.backgroundTasks === undefined
      ? {}
      : {
          pendingBackgroundTasks: Array.from({ length: input.backgroundTasks }, (_, index) => ({
            kind: "command" as const,
            taskId: `background-${index}`,
            description: `Background ${index}`,
          })),
        }),
    status: input.nativeSession === true ? ("idle" as const) : ("not_loaded" as const),
    firstRunOrdinal: 2,
    lastRunOrdinal: 2,
    handoffIds: [],
    forkedFrom: null,
    ...(input.agentMcpRegistration === undefined
      ? {}
      : { nativeMetadata: { agentMcpRegistration: input.agentMcpRegistration } }),
    createdAt: now,
    updatedAt: now,
  };
  const message: OrchestrationV2ThreadProjection["messages"][number] = {
    id: messageId,
    threadId,
    runId,
    nodeId: rootNodeId,
    role: "user",
    text: input.text,
    attachments: input.attachments ?? [],
    streaming: false,
    createdBy: input.createdBy ?? "user",
    creationSource: input.createdBy === undefined ? "web" : "mcp",
    ...(input.scheduledTaskId === undefined ? {} : { scheduledTaskId: input.scheduledTaskId }),
    createdAt: now,
    updatedAt: now,
  };
  let projection: OrchestrationV2ThreadProjection = {
    thread: {
      id: threadId,
      activeProviderThreadId: providerThreadId,
      projectId: ProjectId.make("project-native-account-command"),
      branch:
        input.branch !== undefined
          ? input.branch
          : input.worktreePath === undefined
            ? null
            : "feature/restore",
      worktreePath: input.worktreePath ?? null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      ...(input.delegated === true ? { agentTask: { role: "implementer" } } : {}),
    } as OrchestrationV2ThreadProjection["thread"],
    runs: [
      ...(input.previousNativeSession
        ? [
            {
              ...run,
              id: RunId.make("previous-native-run"),
              ordinal: 1,
              status: "completed" as const,
              providerInstanceId: oldInstanceId,
              providerThreadId: oldProviderThreadId,
            },
          ]
        : []),
      run,
    ],
    attempts: [
      {
        id: attemptId,
        runId,
        rootNodeId,
        attemptOrdinal: 1,
        providerInstanceId: newInstanceId,
        providerThreadId,
        providerTurnId: null,
        reason: input.steeringRestart ? "steering_restart" : "initial",
        status: "pending",
        startedAt: null,
        completedAt: null,
      },
    ],
    nodes: [
      {
        id: rootNodeId,
        threadId,
        runId,
        parentNodeId: null,
        rootNodeId,
        kind: "root_turn",
        status: "pending",
        countsForRun: true,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId,
        startedAt: null,
        completedAt: null,
      },
    ],
    providerThreads: [
      ...(input.previousNativeSession
        ? [
            {
              ...providerThread,
              id: oldProviderThreadId,
              providerInstanceId: oldInstanceId,
              driver: ProviderDriverKind.make("antigravity"),
              lastRunOrdinal: 1,
              nativeThreadRef: {
                driver: ProviderDriverKind.make("antigravity"),
                nativeId: "existing-session",
                strength: "strong" as const,
              },
            },
          ]
        : []),
      providerThread,
    ],
    messages: [
      ...(input.previousMessages ?? []).map((text, index) => ({
        ...message,
        id: MessageId.make(`previous-message-${index}`),
        text,
      })),
      message,
    ],
    checkpointScopes: [
      {
        id: checkpointScopeId,
        threadId,
        runId,
        nodeId: rootNodeId,
        parentScopeId: null,
        providerThreadId,
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/tmp/native-account-command",
        createdAt: now,
      },
    ],
    providerSessions: [],
    providerTurns: (input.claude?.usages ?? []).map((tokenUsage, index) => ({
      id: ProviderTurnId.make(`claude-usage-turn-${index}`),
      providerThreadId,
      nodeId: NodeId.make(`claude-usage-node-${index}`),
      runAttemptId: RunAttemptId.make(`claude-usage-attempt-${index}`),
      ordinal: index + 1,
      nativeTurnRef: null,
      status: "completed" as const,
      startedAt: now,
      completedAt: now,
      tokenUsage,
    })),
    contextHandoffs: [],
    contextTransfers: [],
    turnItems: [],
    visibleTurnItems: [],
    runtimeRequests: [],
    subagents: [],
    plans: [],
    checkpoints: [],
    updatedAt: now,
  };
  const parentThreadId = ThreadId.make("side-chat-parent");
  const parentRunId = RunId.make("side-chat-parent-run");
  const parentProviderThread = {
    ...providerThread,
    id: ProviderThreadId.make("side-chat-parent-provider-thread"),
    appThreadId: parentThreadId,
    nativeThreadRef: {
      driver: providerThread.driver,
      nativeId: "side-chat-parent-native",
      strength: "strong" as const,
    },
  };
  const parentProviderTurn = (ordinal: number, attemptRunId: RunId) => ({
    attempt: {
      ...projection.attempts[0]!,
      id: RunAttemptId.make(`side-chat-parent-attempt-${ordinal}`),
      runId: attemptRunId,
      providerThreadId: parentProviderThread.id,
      status: "completed" as const,
    },
    turn: {
      id: ProviderTurnId.make(`side-chat-parent-turn-${ordinal}`),
      providerThreadId: parentProviderThread.id,
      nodeId: rootNodeId,
      runAttemptId: RunAttemptId.make(`side-chat-parent-attempt-${ordinal}`),
      nativeTurnRef:
        ordinal === 1 && input.sideChat?.sourceBoundary === "synthetic"
          ? null
          : {
              driver: providerThread.driver,
              nativeId: `side-chat-parent-native-turn-${ordinal}`,
              strength: "strong" as const,
            },
      ordinal,
      status: "completed" as const,
      startedAt: now,
      completedAt: now,
    },
  });
  const parentRolledBackRunId = RunId.make("side-chat-parent-rolled-back-run");
  const parentTurns = [
    parentProviderTurn(1, parentRunId),
    parentProviderTurn(2, parentRolledBackRunId),
  ];
  const parentRecords = {
    ...projection,
    thread: { ...projection.thread, id: parentThreadId },
    runs: [
      {
        ...run,
        id: parentRunId,
        threadId: parentThreadId,
        ordinal: 1,
        providerThreadId: parentProviderThread.id,
        activeAttemptId: parentTurns[0]!.attempt.id,
        status:
          input.sideChat?.sourceRolledBack === true
            ? ("rolled_back" as const)
            : ("completed" as const),
        completedAt: now,
      },
      {
        ...run,
        id: parentRolledBackRunId,
        threadId: parentThreadId,
        ordinal: 2,
        providerThreadId: parentProviderThread.id,
        activeAttemptId: parentTurns[1]!.attempt.id,
        status: "rolled_back" as const,
        completedAt: now,
      },
      ...(input.sideChat?.nativeForkFrom === "busy"
        ? [
            {
              ...run,
              id: RunId.make("side-chat-parent-busy-run"),
              threadId: parentThreadId,
              ordinal: 3,
              providerThreadId: parentProviderThread.id,
              status: "running" as const,
            },
          ]
        : []),
    ],
    providerThreads: [parentProviderThread],
    attempts: parentTurns.map(({ attempt }) => attempt),
    providerTurns: parentTurns.map(({ turn }) => turn),
    turnItems: [],
  };
  if (input.sideChat !== undefined) {
    const earlierRunId = RunId.make("side-chat-earlier-run");
    projection = {
      ...projection,
      thread: {
        ...projection.thread,
        runtimeMode: input.sideChat.threadRuntimeMode ?? "full-access",
        lineage: {
          parentThreadId,
          relationshipToParent: "fork",
          rootThreadId: parentThreadId,
          sideChat: true,
        },
      },
      runs:
        input.sideChat.contextRun === "current"
          ? projection.runs
          : [
              {
                ...run,
                id: earlierRunId,
                ordinal: 1,
                userMessageId: MessageId.make("side-chat-earlier-message"),
                activeAttemptId: RunAttemptId.make("side-chat-earlier-attempt"),
                ...(input.sideChat.switchedProvider
                  ? { providerThreadId: oldProviderThreadId }
                  : {}),
                status:
                  input.sideChat.contextRun === "delivered"
                    ? "completed"
                    : input.sideChat.contextRun,
                completedAt: now,
              },
              run,
            ],
      contextTransfers:
        input.sideChat.nativeForkFrom === undefined
          ? []
          : [
              {
                id: ContextTransferId.make("side-chat-fork"),
                type: "fork",
                sourceThreadId: parentThreadId,
                targetThreadId: threadId,
                sourcePoint: { threadId: parentThreadId, runId: parentRunId },
                basePoint: null,
                sourceProviderInstanceId: newInstanceId,
                targetProviderInstanceId: newInstanceId,
                targetRunId: runId,
                status: "pending",
                resolution: null,
                createdBy: "user",
                error: null,
                createdAt: now,
                updatedAt: now,
                consumedAt: null,
              },
            ],
      contextHandoffs: [
        {
          id: ContextHandoffId.make("side-chat-context"),
          transferId: ContextTransferId.make("side-chat-fork"),
          threadId,
          targetRunId: input.sideChat.contextRun === "current" ? runId : earlierRunId,
          fromProviderThreadIds: [],
          toProviderThreadId: input.sideChat.switchedProvider
            ? oldProviderThreadId
            : providerThreadId,
          coveredRunOrdinals: { from: 1, to: 1 },
          strategy: "manual_context",
          status: "ready",
          summaryMessageId: null,
          summaryText: "SIDE_CHAT_CONTEXT",
          createdByProviderInstanceId: null,
          createdAt: now,
          updatedAt: now,
          ...(input.sideChat.contextRun === "delivered"
            ? {
                delivery: {
                  nativeThreadId: "side-chat-native",
                  status: "inline" as const,
                  itemIds: [],
                },
              }
            : {}),
        },
      ],
    };
  }
  if (input.sideChat?.unsentResume) {
    const originalMessageId = MessageId.make("original-unsent-message");
    projection = {
      ...projection,
      runs: [
        {
          ...run,
          id: RunId.make("stopped-run"),
          manualContinuationOfRunId: undefined,
          userMessageId: originalMessageId,
          status: "interrupted",
          ordinal: 1,
        },
        ...projection.runs,
      ],
      messages: [
        { ...message, id: originalMessageId, text: "Original request" },
        ...projection.messages,
      ],
    };
  }
  if (input.sideChat?.repeatedResume) {
    const retry = RunId.make("stopped-resume");
    projection = {
      ...projection,
      runs: projection.runs
        .map((r) => (r.id === runId ? { ...r, manualContinuationOfRunId: retry } : r))
        .concat({
          ...run,
          id: retry,
          manualContinuationOfRunId: RunId.make("stopped-run"),
          status: "interrupted",
        }),
    };
  }
  if (input.sideChat?.acceptedResume) {
    const acceptedId = RunAttemptId.make("accepted-original");
    projection = {
      ...projection,
      attempts: [
        ...projection.attempts,
        {
          ...projection.attempts[0]!,
          id: acceptedId,
          runId: RunId.make("stopped-run"),
          providerThreadId: oldProviderThreadId,
          status: "interrupted",
        },
        ...(input.sideChat.restartedResume
          ? [
              {
                ...projection.attempts[0]!,
                id: RunAttemptId.make("unaccepted-replacement"),
                runId: RunId.make("stopped-run"),
                attemptOrdinal: 2,
                reason: "steering_restart" as const,
                status: "interrupted" as const,
              },
            ]
          : []),
      ],
      providerTurns: [
        ...projection.providerTurns,
        {
          id: ProviderTurnId.make("accepted-original-turn"),
          runAttemptId: acceptedId,
          providerThreadId: oldProviderThreadId,
          nodeId: rootNodeId,
          ordinal: 1,
          nativeTurnRef: null,
          status: "interrupted",
          startedAt: now,
          completedAt: now,
        },
      ],
    };
  }
  if ("historyReadFailureAfterFallback" in input || "resumeFailure" in input) {
    const nativeThreadRef = {
      driver: providerThread.driver,
      nativeId: "native-resume-thread",
      strength: "strong" as const,
    };
    projection = {
      ...projection,
      providerThreads: projection.providerThreads.map((candidate) =>
        candidate.id === providerThreadId ? { ...candidate, nativeThreadRef } : candidate,
      ),
    };
  }
  const previousTurnId = ProviderTurnId.make("previous-provider-turn");
  if (input.previousTurn !== undefined) {
    const previousRunId = RunId.make("previous-failed-run");
    const previousAttemptId = RunAttemptId.make("previous-failed-attempt");
    const steeredAttemptId = RunAttemptId.make("previous-steered-attempt");
    const previousProviderThreadId = input.previousTurn.differentThread
      ? oldProviderThreadId
      : providerThreadId;
    projection = {
      ...projection,
      attempts: [
        {
          id: previousAttemptId,
          runId: previousRunId,
          attemptOrdinal: 1,
          rootNodeId: NodeId.make("previous-root"),
          providerInstanceId: newInstanceId,
          providerThreadId: previousProviderThreadId,
          providerTurnId: null,
          reason: "initial",
          status: input.previousTurn.supersededTurn === true ? "superseded" : "interrupted",
          startedAt: now,
          completedAt: now,
        },
        ...(input.previousTurn.supersededTurn === true
          ? [
              {
                id: steeredAttemptId,
                runId: previousRunId,
                attemptOrdinal: 2,
                rootNodeId: NodeId.make("previous-steered-root"),
                providerInstanceId: newInstanceId,
                providerThreadId: previousProviderThreadId,
                providerTurnId: null,
                reason: "steering_restart" as const,
                status: "interrupted" as const,
                startedAt: null,
                completedAt: now,
              },
            ]
          : []),
        ...projection.attempts,
      ],
      runs: [
        {
          ...run,
          id: previousRunId,
          ordinal: 1,
          status: input.previousTurn.runStatus,
          rootNodeId:
            input.previousTurn.supersededTurn === true
              ? NodeId.make("previous-steered-root")
              : NodeId.make("previous-root"),
          activeAttemptId:
            input.previousTurn.supersededTurn === true ? steeredAttemptId : previousAttemptId,
          providerThreadId: previousProviderThreadId,
          completedAt: now,
        },
        run,
      ],
      providerThreads: [
        {
          ...providerThread,
          nativeThreadRef: {
            driver: providerThread.driver,
            nativeId: "existing-native-conversation",
            strength: "strong",
          },
        },
      ],
      providerTurns: [
        // The steered attempt reached the provider once; only the earlier attempt's
        // turn is still running when the run was interrupted.
        ...(input.previousTurn.supersededTurn === true
          ? [
              {
                id: ProviderTurnId.make("previous-steered-turn"),
                providerThreadId: previousProviderThreadId,
                nodeId: NodeId.make("previous-steered-root"),
                runAttemptId: steeredAttemptId,
                ordinal: 0,
                nativeTurnRef: null,
                status: "interrupted" as const,
                startedAt: now,
                completedAt: now,
              },
            ]
          : []),
        {
          id: previousTurnId,
          providerThreadId: previousProviderThreadId,
          nodeId: NodeId.make("previous-root"),
          runAttemptId: previousAttemptId,
          ordinal: 1,
          nativeTurnRef: null,
          status: input.previousTurn.turnStatus,
          startedAt: now,
          completedAt: input.previousTurn.turnStatus === "running" ? null : now,
        },
      ],
    };
  }
  let providerBusy =
    (input.previousTurn?.runStatus === "failed" ||
      input.previousTurn?.runStatus === "interrupted") &&
    input.previousTurn.turnStatus === "running" &&
    !input.previousTurn.differentThread &&
    input.previousTurn.liveSession !== false;
  const interruptTurn = vi.fn((request: ProviderAdapter.ProviderAdapterV2InterruptInput) =>
    Effect.gen(function* () {
      expect(request.providerTurnId).toBe(previousTurnId);
      expect(request.providerThread.id).toBe(providerThreadId);
      if (input.previousTurn?.interruptFailure) {
        return yield* new ProviderAdapter.ProviderAdapterInterruptError({
          driver: providerThread.driver,
          providerThreadId,
          providerTurnId: request.providerTurnId,
          cause: "provider interrupt failed",
        });
      }
      providerBusy = false;
      if (input.previousTurn?.interruptCurrentRun) interruptRun();
    }),
  );
  const events: Array<OrchestrationV2DomainEvent> = [];
  const interruptRun = () => {
    projection = {
      ...projection,
      runs: projection.runs.map((candidate) =>
        candidate.id === runId
          ? { ...candidate, status: "interrupted", completedAt: now }
          : candidate,
      ),
    };
  };
  const ensureThread = vi.fn(() =>
    Effect.sync(() => {
      if (input.interruptRunBeforeOpenFailure === true) interruptRun();
    }).pipe(
      Effect.andThen(
        Effect.fail(
          new ProviderAdapter.ProviderAdapterEventStreamError({
            driver: providerThread.driver,
            providerSessionId,
            cause: input.ensureThreadFailure,
          }),
        ),
      ),
    ),
  );
  const fallbackEnsureThread = vi.fn(() => Effect.succeed(providerThread));
  const providerSession = {
    id: providerSessionId,
    driver: providerThread.driver,
    providerInstanceId: newInstanceId,
    status: "ready",
    cwd: "/tmp/native-account-command",
    model: null,
    capabilities: {
      ...CodexProviderCapabilitiesV2,
      threads: {
        ...CodexProviderCapabilitiesV2.threads,
        canForkWhileSourceRunning:
          input.canForkWhileSourceRunning ??
          CodexProviderCapabilitiesV2.threads.canForkWhileSourceRunning,
      },
      turns: {
        ...CodexProviderCapabilitiesV2.turns,
        exposesNativeTurnId:
          input.exposesNativeTurnId ?? CodexProviderCapabilitiesV2.turns.exposesNativeTurnId,
        ...(input.nativeGoals === undefined ? {} : { supportsNativeGoals: input.nativeGoals }),
      },
    },
    createdAt: now,
    updatedAt: now,
    lastError: null,
  };
  const startTurn = vi.fn<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>(
    () => Effect.void,
  );
  const resumeFallbackSession = {
    driver: providerThread.driver,
    providerSession,
    resumeThread: () =>
      Effect.fail(
        input.resumeFailure ??
          new ProviderAdapter.ProviderAdapterEventStreamError({
            driver: providerThread.driver,
            providerSessionId,
            cause: "native thread is gone",
          }),
      ),
    ensureThread: fallbackEnsureThread,
  };
  const sideChatThread = {
    ...providerThread,
    nativeThreadRef: {
      driver: providerThread.driver,
      nativeId: "side-chat-native",
      strength: "strong" as const,
    },
  };
  const forkThread = vi.fn<ProviderAdapter.ProviderAdapterV2SessionRuntime["forkThread"]>(() =>
    Effect.succeed(sideChatThread),
  );
  const sideChatSession = {
    driver: providerThread.driver,
    providerSession,
    ensureThread: () => Effect.succeed(sideChatThread),
    resumeThread: () => Effect.succeed(sideChatThread),
    forkThread,
    startTurn,
    resumeTurn: input.nativeResumeUnsupported
      ? undefined
      : (input: ProviderAdapter.ProviderAdapterV2ResumeTurnInput) =>
          startTurn(ProviderAdapter.resumeTurnInput(input)),
  };

  const open = vi.fn<ProviderSessionManager.ProviderSessionManagerV2Shape["open"]>((openInput) =>
    input.sideChat !== undefined
      ? Effect.succeed(sideChatSession as never)
      : input.interruptOpen === true
        ? Effect.interrupt
        : input.resumeSession !== undefined
          ? Effect.succeed(input.resumeSession as never)
          : "historyReadFailureAfterFallback" in input || "resumeFailure" in input
            ? Effect.succeed(resumeFallbackSession as never)
            : "ensureThreadFailure" in input
              ? Effect.succeed({ driver: providerThread.driver, ensureThread } as never)
              : "openFailure" in input
                ? Effect.sync(() => {
                    if (input.interruptRunBeforeOpenFailure === true) interruptRun();
                  }).pipe(
                    Effect.andThen(
                      Effect.fail(
                        new ProviderSessionManager.ProviderSessionOpenError({
                          instanceId: newInstanceId,
                          providerSessionId,
                          cause: input.openFailure,
                        }),
                      ),
                    ),
                  )
                : input.deliverTurn === true ||
                    input.failReadsAfterRunning === true ||
                    input.previousTurn !== undefined
                  ? Effect.succeed({
                      driver: providerThread.driver,
                      startTurn,
                      compactThread: startTurn,
                      providerSession: {
                        id: providerSessionId,
                        driver: providerThread.driver,
                        providerInstanceId: newInstanceId,
                        status: "ready",
                        cwd: "/tmp/native-account-command",
                        model: null,
                        capabilities: CodexProviderCapabilitiesV2,
                        createdAt: now,
                        updatedAt: now,
                        lastError: null,
                      },
                      ensureThread: () =>
                        Effect.succeed(
                          input.nativeResumeFails !== true
                            ? providerThread
                            : {
                                ...providerThread,
                                nativeThreadRef: {
                                  driver: providerThread.driver,
                                  nativeId: "fresh-session",
                                  strength: "strong" as const,
                                },
                                nativeMetadata: {
                                  agentMcpRegistration:
                                    openInput.agentMcpRegistration ?? "canonical",
                                },
                              },
                        ),
                      resumeThread: () =>
                        input.nativeResumeFails === true
                          ? Effect.fail(
                              new ProviderAdapter.ProviderAdapterResumeThreadError({
                                driver: providerThread.driver,
                                providerSessionId,
                                providerThreadId,
                                cause: "missing native session",
                              }),
                            )
                          : Effect.succeed(projection.providerThreads[0]),
                    } as never)
                  : Effect.die("A local command must not open a native session."),
  );
  const startRootRun = vi.fn<
    (
      input: RunExecutionService.RunExecutionServiceV2StartRootRunInput,
    ) => Effect.Effect<void, RunExecutionService.RunExecutionServiceV2Error>
  >((started) =>
    input.sideChat !== undefined
      ? (started.resume
          ? started.session.resumeTurn!({
              ...started,
              messageId: started.message.messageId,
            } as never)
          : started.session.startTurn(started as never)
        ).pipe(Effect.orDie)
      : input.deliverTurn === true
        ? (started.message.attachments.length === 0 &&
            started.message.text.trim().toLowerCase() === "/compact"
            ? started.session.compactThread!
            : started.session.startTurn)({
            appThread: started.appThread,
            threadId: started.run.threadId,
            runId: started.run.id,
            runOrdinal: started.run.ordinal,
            providerTurnOrdinal: started.providerTurnOrdinal,
            attemptId: started.attemptId,
            rootNodeId: started.rootNode.id,
            providerThread: started.providerThread,
            message: started.message,
            modelSelection: started.modelSelection,
            runtimePolicy: started.runtimePolicy,
          }).pipe(Effect.orDie)
        : input.failReadsAfterRunning === true || input.previousTurn !== undefined
          ? Effect.suspend(() =>
              providerBusy
                ? Effect.die("The previous provider turn is still running.")
                : Effect.void,
            )
          : Effect.die("A local command must not start a native turn."),
  );
  const failReadIfRunning = Effect.suspend(() =>
    input.failReadsAfterRunning === true &&
    projection.runs.find((candidate) => candidate.id === runId)?.status === "running"
      ? Effect.fail(
          new ProjectionStore.ProjectionStoreReadError({ threadId, cause: "database unavailable" }),
        )
      : Effect.void,
  );
  const tryHandlePromptCommand = vi.fn(() =>
    input.logoutFailure === undefined
      ? // A Claude conversation's /compact is no account command; the provider runs it.
        Effect.succeed(input.claude === undefined)
      : Effect.fail(
          new ProviderSetupError({
            instanceId: oldInstanceId,
            operation: "logout",
            detail: input.logoutFailure,
          }),
        ),
  );
  const writeIfRunCurrent = vi.fn<EventSink.EventSinkV2["Service"]["writeIfRunCurrent"]>(
    ({ events: incoming, activeAttemptId, expectedStatus }) =>
      "writeFailure" in input
        ? Effect.fail(
            new EventSink.EventSinkWriteError({
              eventCount: incoming.length,
              cause: input.writeFailure,
            }),
          )
        : Effect.sync(() => {
            const current = projection.runs.find((candidate) => candidate.id === runId);
            const committed =
              current !== undefined &&
              current.activeAttemptId === activeAttemptId &&
              current.status === expectedStatus;
            if (committed) {
              for (const event of incoming) {
                expect(isDomainEvent(event)).toBe(true);
                events.push(event);
                projection = ProjectionStore.applyToProjection(projection, event);
              }
            }
            return { committed, storedEvents: [] };
          }),
  );
  const resolveRuntimePolicy = vi.fn(
    ({ thread }: Parameters<RuntimePolicy.RuntimePolicyV2Shape["resolve"]>[0]) =>
      Effect.succeed({
        cwd: thread.worktreePath ?? "/tmp/native-account-command",
        runtimeMode: thread.runtimeMode,
        managedAgent: input.delegated === true,
      } as never),
  );
  const createWorktree = vi.fn<GitWorkflow.GitWorkflowService["Service"]["createWorktree"]>(() =>
    Effect.succeed({} as never),
  );
  const getThreadRecords = vi.fn<ProjectionStore.ProjectionStoreV2Shape["getThreadRecords"]>((id) =>
    Effect.succeed(
      id === parentThreadId
        ? parentRecords
        : input.sessionMovedDuringSummary === true
          ? {
              ...projection,
              providerThreads: projection.providerThreads.map((candidate) =>
                candidate.id === providerThreadId
                  ? {
                      ...candidate,
                      nativeThreadRef: {
                        driver: candidate.driver,
                        nativeId: "another-session",
                        strength: "strong" as const,
                      },
                    }
                  : candidate,
              ),
            }
          : projection,
    ),
  );
  const generateCompactionSummary = vi.fn((_request: { readonly transcript: string }) =>
    input.summariser?.failure === undefined
      ? Effect.succeed({
          summary: input.summariser?.summary ?? "Summarised conversation.",
        })
      : Effect.fail(input.summariser.failure),
  );
  const summariserInstances = new Map(
    [input.summariser, input.fallbackSummariser].flatMap((account) =>
      account === undefined
        ? []
        : [
            [
              account.instanceId,
              {
                instanceId: account.instanceId,
                snapshot: {
                  getSnapshot: Effect.succeed({
                    models: [
                      {
                        slug: account.model,
                        ...(!("contextWindowTokens" in account) ||
                        account.contextWindowTokens === undefined
                          ? {}
                          : { contextWindowTokens: account.contextWindowTokens }),
                      },
                    ],
                  }),
                },
                textGeneration: {
                  generateCompactionSummary:
                    account === input.summariser
                      ? generateCompactionSummary
                      : () => Effect.succeed({ summary: account.summary ?? "Summarised." }),
                },
              } as never,
            ] as const,
          ],
    ),
  );
  const prepareProviderHandoff = vi.fn<
    ContextHandoffService.ContextHandoffServiceV2["Service"]["prepareProviderHandoff"]
  >((handoff) =>
    input.sideChat?.nativeForkFrom === undefined
      ? Effect.die("history read must fail first")
      : Effect.succeed({
          ...handoff,
          id: ContextHandoffId.make("side-chat-fork-context"),
          createdByProviderInstanceId: handoff.toProviderInstanceId,
          status: "ready",
          summaryMessageId: null,
          summaryText: "PARENT_HISTORY",
          updatedAt: handoff.createdAt,
        }),
  );
  const getTurnStartContext = vi.fn(() =>
    Effect.succeed({
      ...projection,
      hasConversation: projection.messages.some(
        (m) =>
          m.role === "user" &&
          (m.text.trim().toLowerCase() !== "/compact" || m.attachments.length > 0),
      ),
    }),
  );
  const getRuntimeRecoveryProjection = vi.fn<
    ProjectionStore.ProjectionStoreV2Shape["getRuntimeRecoveryProjection"]
  >(() =>
    input.recoveryReadFailure !== undefined
      ? Effect.fail(
          new ProjectionStore.ProjectionStoreReadError({
            threadId,
            cause: input.recoveryReadFailure,
          }),
        )
      : Effect.as(failReadIfRunning, {
          ...projection,
          hasConversation: projection.messages.some(
            (m) =>
              m.role === "user" &&
              (m.text.trim().toLowerCase() !== "/compact" || m.attachments.length > 0),
          ),
        }),
  );
  const getRun = vi.fn<ProjectionStore.ProjectionStoreV2Shape["getRun"]>((_threadId, id) =>
    Effect.as(
      failReadIfRunning,
      projection.runs.find((candidate) => candidate.id === id),
    ),
  );
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      input.failFramePreparation === true
        ? Layer.mock(VideoFrames.VideoFrames)({
            framesForMessage: () => Effect.die(new Error("frame preparation unavailable")),
          })
        : VideoFrames.layerLive,
    ),
    Layer.provide(
      Layer.mergeAll(
        input.sideChat?.nativeForkFrom !== undefined
          ? Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({
              prepareProviderHandoff,
            })
          : // A cross-account compaction writes a real handoff; the other scenarios never do.
            input.summariser === undefined && input.history === undefined
            ? Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({
                prepareProviderHandoff,
              })
            : ContextHandoffService.layer.pipe(Layer.provide(IdAllocator.layer)),
        Layer.mock(EventSink.EventSinkV2)({
          writeIfRunCurrent,
          // A resume fallback records its handoff unconditionally.
          write: ({ events: incoming }) =>
            Effect.sync(() => {
              for (const event of incoming) {
                events.push(event);
                projection = ProjectionStore.applyToProjection(projection, event);
              }
              return [];
            }),
        }),
        IdAllocator.layer,
        Layer.succeed(HostProcess.Environment, input.processEnvironment ?? process.env),
        Layer.mock(TurnItemPositionStore.TurnItemPositionStoreV2)({
          allocate: () => Effect.succeed(0),
        }),
        NodeChildProcessSpawner.layer.pipe(
          Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
        layerWorktreeLocation(
          input.worktreesDir,
          {
            ...(input.attachmentsDir === undefined ? {} : { attachmentsDir: input.attachmentsDir }),
            ...(input.baseDir === undefined ? {} : { baseDir: input.baseDir }),
          },
          input.serverSettings ?? input.claude?.settings,
        ),
        input.fileSystem === undefined
          ? FileSystem.layerNoop({ exists: () => Effect.succeed(true) })
          : Layer.succeed(FileSystem.FileSystem, input.fileSystem),
        input.gitWorkflow === undefined
          ? Layer.mock(GitWorkflow.GitWorkflowService)({
              pruneWorktrees: () => Effect.void,
              listLocalBranchNames: () => Effect.succeed(["feature/restore"]),
              createWorktree,
            })
          : Layer.succeed(GitWorkflow.GitWorkflowService, input.gitWorkflow),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeedSome({
              workspaceRoot:
                input.projectRoot ?? input.workspaceRoot ?? "/tmp/native-account-project",
            } as never),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords,
          getTurnStartContext,
          getRuntimeRecoveryProjection,
          getRun,
          getChampionEscalationBrief: () => Effect.succeed(input.escalationBrief ?? ""),
          getTurnStartHistory: () =>
            input.sideChat !== undefined
              ? Effect.succeed([])
              : input.history !== undefined
                ? Effect.succeed(input.history)
                : Effect.fail(
                    new ProjectionStore.ProjectionStoreReadError({
                      threadId,
                      cause: input.historyReadFailureAfterFallback,
                    }),
                  ),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          open,
          get: () =>
            Effect.succeed(
              input.previousTurn?.liveSession === false
                ? Option.none()
                : Option.some({
                    driver: providerThread.driver,
                    providerSessionId,
                    interruptTurn,
                  } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime),
            ),
        }),
        Layer.mock(ProviderAuthService.ProviderAuthService)({ tryHandlePromptCommand }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({
          startRootRun,
          forkBaseline: () => Effect.succeed(Effect.void),
        }),
        Layer.succeed(ProviderUsageAnalytics.ProviderTurnAnalytics, {
          runStarted: () => Effect.void,
          turnCompleted: () => Effect.void,
          runSettled: (report) => Effect.sync(() => void settledRuns.push(report.status)),
        }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: resolveRuntimePolicy,
        }),
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          getInstance: (requested) => Effect.succeed(summariserInstances.get(requested)),
          listInstances: Effect.succeed([...summariserInstances.values()]),
        }),
        input.forgeSummary === undefined
          ? Layer.empty
          : Layer.mock(ForgeWorkItems.ForgeWorkItems)({
              cachedSummary: () => Effect.succeed(Option.fromNullishOr(input.forgeSummary)),
              // The background read fails; the turn must neither wait on it nor fail with it.
              warmSummary: (workItem) =>
                Effect.sync(() => warmedForgeItems.push(workItem.number)).pipe(
                  Effect.andThen(Effect.die("Weave unreachable")),
                ),
            }),
        Layer.mock(ManagedAgent.ManagedAgentService)({
          recoveredRoles: () => Effect.succeed([]),
          resolveStance: ({ thread }) =>
            Effect.succeed({
              stance: thread?.stanceChoice?.stance ?? "implement",
              source: thread?.stanceChoice?.chosenBy ?? "fallback",
            }),
          rankedTextModels: () =>
            Effect.succeed(
              input.fallbackSummariser === undefined
                ? []
                : [
                    {
                      instanceId: input.fallbackSummariser.instanceId,
                      model: input.fallbackSummariser.model,
                    },
                  ],
            ),
        }),
      ),
    ),
  );
  return {
    layer,
    interruptRun,
    settledRuns,
    warmedForgeItems,
    getThreadRecords,
    getTurnStartContext,
    generateCompactionSummary,
    getRuntimeRecoveryProjection,
    getRun,
    setProjection: (next: OrchestrationV2ThreadProjection) => {
      projection = next;
    },
    resolveRuntimePolicy,
    createWorktree,
    open,
    fallbackEnsureThread,
    writeIfRunCurrent,
    startRootRun,
    startTurn,
    forkThread,
    prepareProviderHandoff,
    interruptTurn,
    tryHandlePromptCommand,
    events,
    oldInstanceId,
    newInstanceId,
    attemptId,
    projection: () => projection,
    start: Effect.gen(function* () {
      yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2).start({ threadId, runId });
    }).pipe(Effect.provide(layer)),
    startWithRetry: Effect.gen(function* () {
      yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2).start({
        threadId,
        runId,
        willRetry: true,
      });
    }).pipe(Effect.provide(layer)),
  };
}

effectIt.effect("uses the current stance on each turn of a thread with native history", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      previousNativeSession: true,
      previousMessages: ["Earlier work"],
      deliverTurn: true,
    });
    const initial = harness.projection();
    harness.setProjection({
      ...initial,
      thread: { ...initial.thread, stanceChoice: { stance: "orchestrate", chosenBy: "owner" } },
    });
    yield* harness.start;
    expect(harness.startTurn.mock.calls[0]?.[0].message.text).toContain(
      "Delegation stance: orchestrate",
    );
    harness.setProjection({
      ...initial,
      thread: { ...initial.thread, stanceChoice: { stance: "implement", chosenBy: "owner" } },
    });
    yield* harness.start;
    expect(harness.startTurn.mock.calls[1]?.[0].message.text).toContain(
      "Delegation stance: implement",
    );
    expect(harness.startTurn.mock.calls[1]?.[0].message.text).not.toContain(
      "Delegation stance: orchestrate",
    );
  }),
);

effectIt.effect.each([
  { delegated: true, attached: false, files: ["AGENTS.md", "CLAUDE.md"] },
  { delegated: true, attached: false, files: ["AGENTS.md"] },
  { delegated: true, attached: false, files: [] },
  { delegated: false, attached: false, files: ["AGENTS.md", "CLAUDE.md"] },
  { delegated: true, attached: true, files: ["AGENTS.md", "CLAUDE.md"] },
])(
  "delivers workspace instruction pointers without changing attached turns: %j",
  ({ delegated, attached, files }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const worktreePath = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-instructions-",
      });
      for (const file of files) {
        yield* fileSystem.writeFileString(path.join(worktreePath, file), "Workspace guidance.");
      }
      const harness = makeLocalCommandHarness({
        text: "Continue",
        delegated,
        deliverTurn: true,
        worktreePath,
        branch: null,
        fileSystem,
      });
      if (attached) {
        const projection = harness.projection();
        harness.setProjection({
          ...projection,
          thread: {
            ...projection.thread,
            workspaceAttachments: [
              {
                projectId: ProjectId.make("attached-project"),
                workspacePath: path.join(worktreePath, "attached"),
                branch: null,
                origin: "adopted",
                attachedAt: "2026-09-04T12:00:00Z",
                releasedAt: null,
              },
            ],
          },
        });
      }

      yield* harness.start;

      expect(harness.startTurn).toHaveBeenCalledOnce();
      const text = harness.startTurn.mock.calls[0]![0].message.text;
      if (delegated) {
        expect(text).toContain(worktreePath);
        for (const file of ["AGENTS.md", "CLAUDE.md"]) {
          expect(text.includes(file)).toBe(files.includes(file));
        }
        expect(text.includes("land each repository")).toBe(attached);
      } else {
        expect(text).toBe(`${delegationStanceNote("implement")}\n\nUser message:\nContinue`);
      }
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

effectIt.effect(
  "fails a starting run when its last start attempt is refused by runtime policy",
  () =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({ text: "Continue" });
      harness.resolveRuntimePolicy.mockReturnValue(
        Effect.fail(
          new RuntimePolicy.RuntimePolicyResolveError({
            projectId: "project" as never,
            providerInstanceId: "codex" as never,
            cause: new Error("The workspace is not at the stated sourceRevision."),
          }),
        ) as never,
      );

      yield* harness.start;

      expect(harness.open).not.toHaveBeenCalled();
      const projection = harness.projection();
      expect(projection.runs.at(-1)).toMatchObject({ status: "failed", startedAt: null });
      expect(projection.turnItems).toMatchObject([
        {
          type: "error",
          title: "Provider turn failed to start",
          failure: { message: "The workspace is not at the stated sourceRevision." },
        },
      ]);
    }),
);

effectIt.effect.each([
  { name: "a first message", previousMessages: undefined, framed: true },
  { name: "a later message", previousMessages: ["Earlier reply"], framed: false },
])(
  "frames $name in a Champion escalation thread with the Champion's brief",
  ({ previousMessages, framed }) =>
    Effect.gen(function* () {
      const brief =
        "Champion escalation context:\nQuality opened this because: Decision requested.";
      const harness = makeLocalCommandHarness({
        text: "Approved",
        previousNativeSession: true,
        deliverTurn: true,
        escalationBrief: brief,
        ...(previousMessages === undefined ? {} : { previousMessages }),
      });
      yield* harness.start;
      const text = harness.startTurn.mock.calls[0]![0].message.text;
      expect(text.includes(brief)).toBe(framed);
      expect(text.endsWith("User message:\nApproved")).toBe(true);
    }),
);

effectIt.effect("leaves the run starting when a runtime policy refusal will be retried", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Continue" });
    harness.resolveRuntimePolicy.mockReturnValue(
      Effect.fail(
        new RuntimePolicy.RuntimePolicyResolveError({
          projectId: "project" as never,
          providerInstanceId: "codex" as never,
        }),
      ) as never,
    );

    yield* harness.startWithRetry.pipe(Effect.flip);

    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
  }),
);

effectIt.effect("says a delegated task's removed workspace is not replaced", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      worktreePath: "/tmp/released-slipjay-workspace",
      branch: null,
      delegated: true,
      fileSystem: FileSystem.makeNoop({ exists: () => Effect.succeed(false) }),
    });

    yield* harness.start;

    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("failed");
    const [item] = harness.projection().turnItems;
    expect(item).toMatchObject({ type: "error", title: "Workspace missing" });
    expect(item?.type === "error" ? item.failure.message : "").toContain(
      "T3 does not replace a delegated task's workspace",
    );
  }),
);

const boundWorkspaceFixture = Effect.fn("test.boundWorkspaceFixture")(function* (
  kind:
    | "git"
    | "git-subdirectory"
    | "git-subdirectory-root"
    | "jj"
    | "jj-git"
    | "scratch"
    | "non-repository",
) {
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* ProcessRunner.ProcessRunner;
  const root = yield* fs.makeTempDirectoryScoped();
  const projectRoot = kind === "scratch" ? `${root}/scratch` : `${root}/project`;
  const worktreePath = kind === "scratch" ? `${projectRoot}/child` : `${root}/workspace`;
  const run = (command: string, args: ReadonlyArray<string>, cwd?: string) =>
    runner
      .run({ command, args, cwd })
      .pipe(Effect.tap((result) => Effect.sync(() => expect(result.code).toBe(0))));
  if (kind === "git-subdirectory" || kind === "git-subdirectory-root") {
    // A project rooted in a subdirectory of its repository, bound to the same subdirectory or,
    // as a workspace allocation binds it, to the root of the checkout.
    const repository = `${root}/repository`;
    yield* run("git", ["init", repository]);
    yield* fs.makeDirectory(`${repository}/apps/web`, { recursive: true });
    yield* fs.writeFileString(`${repository}/apps/web/README.md`, "web\n");
    yield* run("git", ["add", "."], repository);
    yield* run(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"],
      repository,
    );
    yield* run("git", ["worktree", "add", "-b", "task", `${root}/workspace`], repository);
    return {
      fs,
      projectRoot: `${repository}/apps/web`,
      worktreePath:
        kind === "git-subdirectory" ? `${root}/workspace/apps/web` : `${root}/workspace`,
      baseDir: root,
    };
  }
  if (kind === "git" || kind === "jj-git") {
    yield* run("git", ["init", projectRoot]);
    yield* run(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "initial",
      ],
      projectRoot,
    );
    if (kind === "jj-git") yield* run("jj", ["git", "init", "--colocate", projectRoot]);
    yield* run("git", ["worktree", "add", "-b", "task", worktreePath], projectRoot);
  } else if (kind === "jj") {
    yield* run("jj", ["git", "init", projectRoot]);
    yield* run("jj", ["workspace", "add", worktreePath], projectRoot);
  } else {
    yield* fs.makeDirectory(projectRoot);
    yield* fs.makeDirectory(worktreePath);
  }
  return { fs, projectRoot, worktreePath, baseDir: root };
});

effectIt.effect.each([
  { state: "empty", continuation: false },
  { state: "empty", continuation: true },
  { state: "absent", continuation: false },
  { state: "absent", continuation: true },
  { state: "foreign", continuation: false },
  { state: "subdirectory", continuation: false },
])(
  "refuses a delegated invalid checkout ($state, continuation: $continuation)",
  ({ state, continuation }) =>
    Effect.gen(function* () {
      const { fs, projectRoot, worktreePath } = yield* boundWorkspaceFixture("git");
      const harness = makeLocalCommandHarness({
        text: continuation ? "Continue" : "Start",
        projectRoot,
        worktreePath,
        delegated: true,
        fileSystem: fs,
        failReadsAfterRunning: true,
        ...(continuation
          ? { previousTurn: { runStatus: "completed", turnStatus: "completed" } as const }
          : {}),
      });
      yield* fs.remove(worktreePath, { recursive: true });
      if (state !== "absent") yield* fs.makeDirectory(worktreePath);
      if (state === "foreign") {
        const runner = yield* ProcessRunner.ProcessRunner;
        expect((yield* runner.run({ command: "git", args: ["init", worktreePath] })).code).toBe(0);
      } else if (state === "subdirectory") {
        yield* fs.remove(worktreePath, { recursive: true });
        yield* fs.makeDirectory(`${projectRoot}/empty`);
        yield* fs.symlink(`${projectRoot}/empty`, worktreePath);
      }

      yield* harness.start;

      expect(harness.open).not.toHaveBeenCalled();
      expect(harness.startRootRun).not.toHaveBeenCalled();
      expect(harness.createWorktree).not.toHaveBeenCalled();
      expect(harness.projection().runs.at(-1)?.status).toBe("failed");
      const [item] = harness.projection().turnItems;
      expect(item).toMatchObject({
        type: "error",
        title: state === "absent" ? "Workspace missing" : "Workspace invalid",
      });
      expect(item?.type === "error" ? item.failure.message : "").toContain(
        "ask its lead to assign the work again",
      );
      expect(harness.projection().thread.worktreePath).toBe(worktreePath);
      if (state === "empty") expect(yield* fs.readDirectory(worktreePath)).toEqual([]);
      if (state === "absent") expect(yield* fs.exists(worktreePath)).toBe(false);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ProcessRunner.layer.pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
);

effectIt.effect.each([
  "git",
  "git-subdirectory",
  "git-subdirectory-root",
  "jj",
  "jj-git",
  "scratch",
  "non-repository",
] as const)("starts a delegated task in its valid %s workspace", (kind) =>
  Effect.gen(function* () {
    const { fs, projectRoot, worktreePath, baseDir } = yield* boundWorkspaceFixture(kind);
    const harness = makeLocalCommandHarness({
      text: "Start",
      baseDir,
      projectRoot,
      worktreePath,
      branch: null,
      delegated: true,
      fileSystem: fs,
      failReadsAfterRunning: true,
    });

    yield* harness.start;

    expect(harness.open).toHaveBeenCalledOnce();
    expect(harness.startRootRun).toHaveBeenCalledOnce();
    expect(harness.createWorktree).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("running");
    expect(harness.resolveRuntimePolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        thread: expect.objectContaining({ worktreePath }),
      }),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ProcessRunner.layer.pipe(
        Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  ),
);

effectIt.effect("refuses a subdirectory project's task bound to a different folder", () =>
  Effect.gen(function* () {
    const { fs, projectRoot, worktreePath, baseDir } =
      yield* boundWorkspaceFixture("git-subdirectory-root");
    const elsewhere = `${worktreePath}/packages/other`;
    yield* fs.makeDirectory(elsewhere, { recursive: true });
    const harness = makeLocalCommandHarness({
      text: "Start",
      baseDir,
      projectRoot,
      worktreePath: elsewhere,
      branch: null,
      delegated: true,
      fileSystem: fs,
      failReadsAfterRunning: true,
    });

    yield* harness.start;

    expect(harness.open).not.toHaveBeenCalled();
    expect(harness.projection().turnItems[0]).toMatchObject({
      type: "error",
      title: "Workspace invalid",
    });
  }).pipe(
    Effect.scoped,
    Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  ),
);

effectIt.effect.each([
  { kind: "git-subdirectory-root", folder: "apps/web" },
  { kind: "git-subdirectory", folder: null },
  { kind: "git", folder: null },
] as const)("names the project's folder from the checkout root: $kind", ({ kind, folder }) =>
  Effect.gen(function* () {
    const { fs, projectRoot, worktreePath, baseDir } = yield* boundWorkspaceFixture(kind);
    const harness = makeLocalCommandHarness({
      text: "Continue",
      deliverTurn: true,
      baseDir,
      projectRoot,
      worktreePath,
      branch: null,
      fileSystem: fs,
    });

    yield* harness.start;

    const text = harness.startTurn.mock.calls[0]![0].message.text;
    if (folder === null)
      expect(text).toBe(`${delegationStanceNote("implement")}\n\nUser message:\nContinue`);
    else expect(text).toContain(`\`${folder}\``);
  }).pipe(
    Effect.scoped,
    Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  ),
);

effectIt.effect(
  "injects the unified unattended note from turn 1 when global Away is on and skips slash commands",
  () =>
    Effect.gen(function* () {
      const ordinary = makeLocalCommandHarness({
        text: "Finish the refactor",
        deliverTurn: true,
        serverSettings: { away: true },
      });
      yield* ordinary.start;
      const ordinaryText = ordinary.startTurn.mock.calls[0]![0].message.text;
      expect(ordinaryText).toContain("Global Away is on");
      expect(ordinaryText).toContain("Production deploys or migrations");
      expect(ordinaryText).toContain("op decision");

      const slash = makeLocalCommandHarness({
        text: "/review",
        deliverTurn: true,
        claude: { usages: [], settings: { away: true } },
      });
      yield* slash.start;
      const delivered =
        slash.startTurn.mock.calls[0]?.[0]?.message?.text ??
        slash.startRootRun.mock.calls[0]?.[0]?.message?.text;
      expect(delivered).toBe("/review");
    }).pipe(Effect.scoped),
);
