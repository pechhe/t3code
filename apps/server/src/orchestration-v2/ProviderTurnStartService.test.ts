import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { ChatAttachment } from "@t3tools/contracts";
import * as ProcessRunner from "../processRunner.ts";
import * as VideoFrames from "../videoFrames/VideoFrames.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, vi } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import {
  CheckpointScopeId,
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
  ThreadId,
  ProjectId,
  type OrchestrationV2ProviderTurnTokenUsage,
  type OrchestrationV2ThreadProjection,
  OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";

import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
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
import * as RuntimePolicy from "./RuntimePolicy.ts";

const isDomainEvent = Schema.is(OrchestrationV2DomainEvent);

const managedWorktreesDir = "/tmp/provider-turn-start-worktrees";
// fs.realpath applies `..` and `.` before following symlinks.
const normalize = (target: string) => {
  const parts: Array<string> = [];
  for (const part of target.split("/")) {
    if (part === "..") parts.pop();
    else if (part !== "" && part !== ".") parts.push(part);
  }
  return `/${parts.join("/")}`;
};
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

/** Starts a run on a thread whose worktree folder is missing, with routing reads failing after. */
function startWithMissingWorktree(
  worktreePath: string,
  realPaths: Record<string, string> = {
    [managedWorktreesDir]: managedWorktreesDir,
    [`${managedWorktreesDir}/project`]: `${managedWorktreesDir}/project`,
  },
) {
  const threadId = ThreadId.make("thread_provider_turn_start_projection_failure");
  const runId = RunId.make("run_provider_turn_start_projection_failure");
  const attemptId = RunAttemptId.make("attempt_provider_turn_start_projection_failure");
  const rootNodeId = NodeId.make("node_provider_turn_start_projection_failure");
  const providerThreadId = ProviderThreadId.make(
    "provider_thread_provider_turn_start_projection_failure",
  );
  const providerSessionId = ProviderSessionId.make(
    "provider_session_provider_turn_start_projection_failure",
  );
  const messageId = MessageId.make("message_provider_turn_start_projection_failure");
  const checkpointScopeId = CheckpointScopeId.make(
    "checkpoint_scope_provider_turn_start_projection_failure",
  );
  const projection = {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project_provider_turn_start_projection_failure"),
      branch: "feature/restore",
      worktreePath,
    },
    runs: [
      {
        id: runId,
        status: "starting",
        rootNodeId,
        activeAttemptId: attemptId,
        providerThreadId,
        userMessageId: messageId,
        ordinal: 2,
      },
    ],
    nodes: [{ id: rootNodeId, checkpointScopeId }],
    attempts: [{ id: attemptId }],
    providerThreads: [{ id: providerThreadId, providerSessionId }],
    messages: [{ id: messageId, text: "Continue", attachments: [] }],
    checkpointScopes: [{ id: checkpointScopeId }],
    contextHandoffs: [],
    contextTransfers: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
  let projectionReadCount = 0;
  const writeIfRunCurrent = vi.fn(() =>
    Effect.succeed({ committed: true, storedEvents: [] } as never),
  );
  const startRootRun = vi.fn(() => Effect.void);
  const pruneWorktrees = vi.fn(() => Effect.void);
  let recreated = false;
  const createWorktree = vi.fn(() =>
    Effect.sync(() => {
      recreated = true;
      return {} as never;
    }),
  );
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mock(VideoFrames.VideoFrames)({ framesForMessage: () => Effect.succeed([]) }),
    ),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({}),
        Layer.mock(EventSink.EventSinkV2)({ writeIfRunCurrent }),
        IdAllocator.layer,
        NodeChildProcessSpawner.layer.pipe(Layer.provide(NodeServices.layer)),
        Layer.succeed(FileSystem.FileSystem, {
          exists: () => Effect.sync(() => recreated),
          // Paths that exist on the fake disk, mapped to where their symlinks lead.
          realPath: (target: string) =>
            normalize(target) in realPaths
              ? Effect.succeed(realPaths[normalize(target)])
              : Effect.fail(
                  PlatformError.systemError({
                    _tag: "NotFound",
                    module: "FileSystem",
                    method: "realPath",
                    pathOrDescriptor: target,
                  }),
                ),
        } as never),
        layerWorktreeLocation(),
        Layer.mock(GitWorkflow.GitWorkflowService)({ pruneWorktrees, createWorktree }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({ workspaceRoot: "/tmp/provider-turn-start-project" } as never),
            ),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: () => {
            projectionReadCount += 1;
            return Effect.succeed(projection);
          },
          getTurnStartContext: () => {
            projectionReadCount += 1;
            return Effect.succeed({
              ...projection,
              hasConversation: projection.messages.some(
                (m) =>
                  m.role === "user" &&
                  (m.text.trim().toLowerCase() !== "/compact" || m.attachments.length > 0),
              ),
            });
          },
          getRuntimeRecoveryProjection: () => {
            projectionReadCount += 1;
            return Effect.fail(
              new ProjectionStore.ProjectionStoreReadError({
                threadId,
                cause: "simulated inherited-background projection failure",
              }),
            );
          },
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
        Layer.mock(ProviderAuthService.ProviderAuthService)({
          tryHandlePromptCommand: () => Effect.succeed(false),
        }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({ startRootRun }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({}),
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          getInstance: () => Effect.succeed(undefined),
        }),
      ),
    ),
  );

  // A worktree that stays missing settles the run as failed, so the start itself succeeds.
  const start = Effect.gen(function* () {
    return yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2)
      .start({ threadId, runId })
      .pipe(Effect.exit);
  }).pipe(Effect.provide(layer), Effect.runPromise);
  return {
    start,
    pruneWorktrees,
    createWorktree,
    writeIfRunCurrent,
    startRootRun,
    projectionReads: () => projectionReadCount,
  };
}

it.each([
  {
    label: "<managed>/<repo>/<branch>",
    worktreePath: `${managedWorktreesDir}/project/feature-restore`,
    recreated: true,
  },
  {
    label: "the real path of a symlinked managed folder",
    worktreePath: "/real-worktrees/project/feature-restore",
    realPaths: { [managedWorktreesDir]: "/real-worktrees", "/real-worktrees": "/real-worktrees" },
    recreated: true,
  },
  {
    label: "a path outside the managed folder",
    worktreePath: "/tmp/provider-turn-start-project/.git/hooks",
    recreated: false,
  },
  {
    label: "a symlink inside the managed folder that leads out",
    worktreePath: `${managedWorktreesDir}/project/hooks`,
    realPaths: {
      [managedWorktreesDir]: managedWorktreesDir,
      [`${managedWorktreesDir}/project`]: "/tmp/provider-turn-start-project/.git",
    },
    recreated: false,
  },
  {
    label: "a folder nested below a worktree",
    worktreePath: `${managedWorktreesDir}/project/feature-restore/link/hooks`,
    recreated: false,
  },
  {
    label: "'..' out of the managed folder",
    worktreePath: `${managedWorktreesDir}/project/../../outside`,
    recreated: false,
  },
  {
    // Left raw on purpose: git follows `link` before applying `..`.
    label: "'..' after a symlink inside the managed folder",
    worktreePath: `${managedWorktreesDir}/project/x/link/../../hooks`,
    realPaths: {
      [managedWorktreesDir]: managedWorktreesDir,
      [`${managedWorktreesDir}/project`]: `${managedWorktreesDir}/project`,
      [`${managedWorktreesDir}/project/x`]: `${managedWorktreesDir}/project/x`,
      [`${managedWorktreesDir}/project/x/link`]: "/tmp/provider-turn-start-project/.git/refs/heads",
    },
    recreated: false,
  },
  { label: "a relative path", worktreePath: "project/feature-restore", recreated: false },
])("recreates a missing worktree only at the managed location: $label", async (input) => {
  const harness = startWithMissingWorktree(input.worktreePath, input.realPaths);
  await harness.start;
  expect(harness.createWorktree).toHaveBeenCalledTimes(input.recreated ? 1 : 0);
});

function makeLocalCommandHarness(input: {
  readonly text: string;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
  readonly attachmentsDir?: string;
  readonly processEnvironment?: NodeJS.ProcessEnv;
  readonly worktreePath?: string;
  /** Defaults to a git branch whenever a worktree is bound; null is a SlipJay workspace. */
  readonly branch?: string | null;
  /** The thread is a delegated task, whose workspace belongs to the work that assigned it. */
  readonly delegated?: boolean;
  readonly worktreesDir?: string;
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
  readonly logoutFailure?: string;
  readonly openFailure?: unknown;
  readonly ensureThreadFailure?: unknown;
  readonly historyReadFailureAfterFallback?: unknown;
  readonly interruptOpen?: boolean;
  readonly interruptRunBeforeOpenFailure?: boolean;
  readonly writeFailure?: unknown;
  readonly failReadsAfterRunning?: boolean;
  /** The conversation already has a native session, which a compaction can replace. */
  readonly nativeSession?: boolean;
  /** The thread's session is replaced by another turn while the summariser writes. */
  readonly sessionMovedDuringSummary?: boolean;
  readonly backgroundTasks?: number;
  /** Another account that can summarise this thread's compaction. */
  readonly summariser?: {
    readonly instanceId: ProviderInstanceId;
    readonly model: string;
    readonly summary?: string;
    readonly failure?: unknown;
    readonly contextWindowTokens?: number;
  };
  readonly previousTurn?: {
    readonly runStatus: "failed" | "completed";
    readonly turnStatus: "running" | "completed" | "interrupted";
    readonly differentThread?: boolean;
    readonly liveSession?: boolean;
    readonly interruptFailure?: boolean;
    readonly interruptCurrentRun?: boolean;
  };
}) {
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
    input.claude ? (input.claude.instanceId ?? "claudeAgent") : "codex-personal",
  );
  const checkpointScopeId = CheckpointScopeId.make("scope-native-account-command");
  const messageId = MessageId.make("message-native-account-command");
  const run: OrchestrationV2ThreadProjection["runs"][number] = {
    id: runId,
    threadId,
    ordinal: 2,
    providerInstanceId: newInstanceId,
    modelSelection: {
      instanceId: newInstanceId,
      model: input.claude ? "claude-sonnet-5-5" : "gpt-5.4",
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
    driver: ProviderDriverKind.make(input.claude ? "claudeAgent" : "codex"),
    providerInstanceId: newInstanceId,
    providerSessionId,
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
    createdBy: "user",
    creationSource: "web",
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
      ...(input.delegated === true ? { agentTask: { role: "implementation-worker" } } : {}),
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
        reason: "initial",
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
  if ("historyReadFailureAfterFallback" in input) {
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
    const previousProviderThreadId = input.previousTurn.differentThread
      ? oldProviderThreadId
      : providerThreadId;
    projection = {
      ...projection,
      runs: [
        {
          ...run,
          id: previousRunId,
          ordinal: 1,
          status: input.previousTurn.runStatus,
          rootNodeId: NodeId.make("previous-root"),
          activeAttemptId: previousAttemptId,
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
    input.previousTurn?.runStatus === "failed" &&
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
  const resumeFallbackSession = {
    driver: providerThread.driver,
    resumeThread: () =>
      Effect.fail(
        new ProviderAdapter.ProviderAdapterEventStreamError({
          driver: providerThread.driver,
          providerSessionId,
          cause: "native thread is gone",
        }),
      ),
    ensureThread: () => Effect.succeed(providerThread),
  };
  const open = vi.fn(() =>
    input.interruptOpen === true
      ? Effect.interrupt
      : "historyReadFailureAfterFallback" in input
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
            : input.failReadsAfterRunning === true || input.previousTurn !== undefined
              ? Effect.succeed({
                  driver: providerThread.driver,
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
                  ensureThread: () => Effect.succeed(providerThread),
                  resumeThread: () => Effect.succeed(projection.providerThreads[0]),
                } as never)
              : Effect.die("A local command must not open a native session."),
  );
  const startRootRun = vi.fn<
    (input: RunExecutionService.RunExecutionServiceV2StartRootRunInput) => Effect.Effect<void>
  >(() =>
    input.failReadsAfterRunning === true || input.previousTurn !== undefined
      ? Effect.suspend(() =>
          providerBusy ? Effect.die("The previous provider turn is still running.") : Effect.void,
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
  const writeIfRunCurrent = vi.fn(({ events: incoming, activeAttemptId, expectedStatus }) =>
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
      Effect.succeed({ cwd: thread.worktreePath ?? "/tmp/native-account-command" } as never),
  );
  const createWorktree = vi.fn(() => Effect.succeed({} as never));
  const getThreadRecords = vi.fn<ProjectionStore.ProjectionStoreV2Shape["getThreadRecords"]>(() =>
    Effect.succeed(
      input.sessionMovedDuringSummary === true
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
  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(VideoFrames.layerLive),
    Layer.provide(
      Layer.mergeAll(
        // A cross-account compaction writes a real handoff; the other scenarios never do.
        input.summariser === undefined
          ? Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({
              prepareProviderHandoff: () => Effect.die("history read must fail first"),
            })
          : ContextHandoffService.layer.pipe(Layer.provide(IdAllocator.layer)),
        Layer.mock(EventSink.EventSinkV2)({ writeIfRunCurrent }),
        IdAllocator.layer,
        Layer.succeed(HostProcess.Environment, input.processEnvironment ?? process.env),
        NodeChildProcessSpawner.layer.pipe(Layer.provide(NodeServices.layer)),
        layerWorktreeLocation(
          input.worktreesDir,
          input.attachmentsDir === undefined ? {} : { attachmentsDir: input.attachmentsDir },
          input.claude?.settings,
        ),
        input.fileSystem === undefined
          ? FileSystem.layerNoop({ exists: () => Effect.succeed(true) })
          : Layer.succeed(FileSystem.FileSystem, input.fileSystem),
        Layer.mock(GitWorkflow.GitWorkflowService)({
          pruneWorktrees: () => Effect.void,
          createWorktree,
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(Option.some({ workspaceRoot: "/tmp/native-account-project" } as never)),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords,
          getTurnStartContext,
          getRuntimeRecoveryProjection: () =>
            Effect.as(failReadIfRunning, {
              ...projection,
              hasConversation: projection.messages.some(
                (m) =>
                  m.role === "user" &&
                  (m.text.trim().toLowerCase() !== "/compact" || m.attachments.length > 0),
              ),
            }),
          getTurnStartHistory: () =>
            Effect.fail(
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
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({ startRootRun }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: resolveRuntimePolicy,
        }),
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          getInstance: (requested) =>
            Effect.succeed(
              input.summariser === undefined || requested !== input.summariser.instanceId
                ? undefined
                : ({
                    instanceId: input.summariser.instanceId,
                    snapshot: {
                      getSnapshot: Effect.succeed({
                        models: [
                          {
                            slug: input.summariser.model,
                            ...(input.summariser.contextWindowTokens === undefined
                              ? {}
                              : { contextWindowTokens: input.summariser.contextWindowTokens }),
                          },
                        ],
                      }),
                    },
                    textGeneration: {
                      generateCompactionSummary: () =>
                        input.summariser?.failure === undefined
                          ? Effect.succeed({
                              summary: input.summariser?.summary ?? "Summarised conversation.",
                            })
                          : Effect.fail(input.summariser.failure),
                    },
                  } as never),
            ),
        }),
      ),
    ),
  );
  return {
    getThreadRecords,
    getTurnStartContext,
    setProjection: (next: OrchestrationV2ThreadProjection) => {
      projection = next;
    },
    resolveRuntimePolicy,
    createWorktree,
    open,
    writeIfRunCurrent,
    startRootRun,
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

effectIt.effect.each([true, false])(
  "samples video at turn start when ffmpeg availability is %s",
  (available) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runner = yield* ProcessRunner.ProcessRunner;
      if (available && !(yield* VideoFrames.ffmpegAvailable)) {
        yield* Effect.logWarning("Skipping real turn video fixture: ffmpeg is absent from PATH");
        return;
      }
      const attachment: ChatAttachment = {
        type: "file",
        id: "thread-00000000-0000-4000-8000-000000000001-mp4",
        name: "clip.mp4",
        mimeType: "video/mp4",
        sizeBytes: 10,
      };
      if (available) {
        const generated = yield* runner.run({
          command: "ffmpeg",
          args: [
            "-nostdin",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=red:s=32x32:r=25:d=1",
            "-c:v",
            "mpeg4",
            "-y",
            path.join(config.attachmentsDir, `${attachment.id}.mp4`),
          ],
        });
        expect(generated.code).toBe(0);
      }
      const worktree = yield* fs.makeTempDirectoryScoped();
      const harness = makeLocalCommandHarness({
        text: "Describe this video",
        worktreePath: worktree,
        fileSystem: fs,
        attachments: [attachment],
        attachmentsDir: config.attachmentsDir,
        failReadsAfterRunning: true,
        ...(available ? {} : { processEnvironment: { PATH: "" } }),
      });
      yield* harness.start;
      const message = harness.startRootRun.mock.calls[0]?.[0].message;
      expect(message?.attachments).toEqual([attachment]);
      if (available) expect(message?.videoFrames).toHaveLength(12);
      else expect(message).not.toHaveProperty("videoFrames");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ProcessRunner.layer.pipe(
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "turn-video-test-" })),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);

effectIt.effect("recovers an abandoned failed turn before continuing its native conversation", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      previousTurn: { runStatus: "failed", turnStatus: "running" },
    });

    yield* harness.start;

    expect(harness.interruptTurn).toHaveBeenCalledOnce();
    expect(harness.projection().runs.at(-1)?.status).toBe("running");
    expect(harness.projection().providerTurns[0]).toMatchObject({
      status: "interrupted",
      completedAt: expect.anything(),
    });
    expect(harness.startRootRun).toHaveBeenCalledOnce();
    expect(harness.startRootRun.mock.calls[0]?.[0].providerThread.nativeThreadRef?.nativeId).toBe(
      "existing-native-conversation",
    );
  }),
);

effectIt.effect.each([
  { runStatus: "failed", turnStatus: "completed" },
  { runStatus: "completed", turnStatus: "completed" },
  { runStatus: "failed", turnStatus: "running", differentThread: true },
  { runStatus: "failed", turnStatus: "running", liveSession: false },
  { runStatus: "failed", turnStatus: "interrupted", interruptFailure: true },
] as const)("continues without interrupting when recovery does not apply: %j", (previousTurn) =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Continue", previousTurn });

    yield* harness.start;

    expect(harness.interruptTurn).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("running");
  }),
);

effectIt.effect("does not start another turn when abandoned-turn cleanup fails", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      previousTurn: { runStatus: "failed", turnStatus: "running", interruptFailure: true },
    });

    yield* harness.start;

    expect(harness.interruptTurn).toHaveBeenCalledOnce();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("failed");
  }),
);

effectIt.effect("retries abandoned-turn cleanup without failing the continuation early", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      previousTurn: { runStatus: "failed", turnStatus: "running", interruptFailure: true },
    });

    const error = yield* harness.startWithRetry.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
    expect(harness.open).not.toHaveBeenCalled();
  }),
);

effectIt.effect("does not start the continuation if recording recovery fails", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      previousTurn: { runStatus: "failed", turnStatus: "running" },
      writeFailure: new Error("database unavailable"),
    });

    const error = yield* harness.start.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
    expect(harness.projection().providerTurns[0]?.status).toBe("running");
    expect(harness.open).not.toHaveBeenCalled();
  }),
);

effectIt.effect("does not resume a continuation stopped while recovery was in flight", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      previousTurn: { runStatus: "failed", turnStatus: "running", interruptCurrentRun: true },
    });

    yield* harness.start;

    expect(harness.projection().runs.at(-1)?.status).toBe("interrupted");
    expect(harness.open).not.toHaveBeenCalled();
  }),
);

effectIt.effect.each(["cleanup-first", "startup-first"])(
  "coordinates provider startup with %s",
  (order) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-start-" });
      const worktreePath = path.join(workspaceRoot, "project", "worktree");
      yield* fileSystem.makeDirectory(worktreePath, { recursive: true });
      const release = yield* Deferred.make<void>();
      const openEntered = yield* Deferred.make<void>();
      const harness = makeLocalCommandHarness({
        text: "Continue",
        worktreePath,
        worktreesDir: workspaceRoot,
        fileSystem,
        failReadsAfterRunning: true,
      });
      harness.createWorktree.mockImplementation(() =>
        fileSystem.makeDirectory(worktreePath).pipe(Effect.as({} as never), Effect.orDie),
      );
      const open = harness.open.getMockImplementation()!;
      harness.open.mockImplementation(() =>
        Effect.gen(function* () {
          expect(yield* fileSystem.exists(worktreePath).pipe(Effect.orDie)).toBe(true);
          yield* Deferred.succeed(openEntered, undefined);
          if (order === "startup-first") yield* Deferred.await(release);
          return yield* open();
        }),
      );
      let cleanupEntered = false;
      const cleanupEffect = withWorkspaceLease(
        worktreePath,
        Effect.gen(function* () {
          cleanupEntered = true;
          if (order === "cleanup-first") yield* Deferred.await(release);
          else {
            expect(harness.projection().providerSessions).toHaveLength(1);
            expect(harness.projection().runs.at(-1)?.status).toBe("running");
          }
          yield* fileSystem.remove(worktreePath, { recursive: true, force: true });
        }),
      );
      const cleanup =
        order === "cleanup-first"
          ? yield* cleanupEffect.pipe(Effect.forkChild({ startImmediately: true }))
          : undefined;
      const startup = yield* harness.start.pipe(Effect.forkChild({ startImmediately: true }));
      if (order === "cleanup-first") expect(harness.open).not.toHaveBeenCalled();
      if (order === "startup-first") yield* Deferred.await(openEntered);
      const laterCleanup =
        order === "startup-first"
          ? yield* cleanupEffect.pipe(Effect.forkChild({ startImmediately: true }))
          : undefined;
      if (order === "startup-first") expect(cleanupEntered).toBe(false);
      yield* Deferred.succeed(release, undefined);
      if (cleanup !== undefined) yield* Fiber.join(cleanup);
      yield* Fiber.join(startup);
      if (laterCleanup !== undefined) yield* Fiber.join(laterCleanup);
      if (order === "cleanup-first") {
        expect(harness.createWorktree).toHaveBeenCalledWith({
          cwd: "/tmp/native-account-project",
          refName: "feature/restore",
          path: worktreePath,
        });
      }
      expect(harness.resolveRuntimePolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          thread: expect.objectContaining({ worktreePath }),
        }),
      );
      expect(harness.open).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimePolicy: expect.objectContaining({ cwd: worktreePath }),
        }),
      );
      expect(harness.startRootRun).toHaveBeenCalledWith(
        expect.objectContaining({
          appThread: expect.objectContaining({ worktreePath }),
          runtimePolicy: expect.objectContaining({ cwd: worktreePath }),
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

effectIt.effect("reads current startup state after waiting for the workspace lease", () =>
  Effect.gen(function* () {
    const worktreePath = "/tmp/provider-start-fresh-state";
    const release = yield* Deferred.make<void>();
    const readEntered = yield* Deferred.make<void>();
    const harness = makeLocalCommandHarness({
      text: "Continue",
      worktreePath,
      failReadsAfterRunning: true,
    });
    harness.getThreadRecords.mockImplementationOnce(() =>
      Deferred.succeed(readEntered, undefined).pipe(Effect.as(harness.projection())),
    );
    const holder = yield* withWorkspaceLease(worktreePath, Deferred.await(release)).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    const startup = yield* harness.start.pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(readEntered);
    expect(harness.getTurnStartContext).not.toHaveBeenCalled();
    const projection = harness.projection();
    harness.setProjection({
      ...projection,
      runs: projection.runs.map((run) => ({ ...run, status: "running" })),
    });
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(holder);
    yield* Fiber.join(startup);
    expect(harness.open).not.toHaveBeenCalled();
    expect(harness.startRootRun).not.toHaveBeenCalled();
  }),
);

// regression: #15784 superseded provider startups kept running
effectIt.effect.each([
  { boundary: "policy resolution", loss: "replaced" },
  { boundary: "session opening", loss: "interrupted" },
])("does not continue startup when $loss during $boundary", ({ boundary, loss }) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const gate = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release)));
    const harness = makeLocalCommandHarness({ text: "Continue" });
    const projection = harness.projection();
    const providerThread = projection.providerThreads[0]!;
    const ensureThread = vi.fn(() => Effect.succeed(providerThread));
    const resumeThread = vi.fn(() => Effect.succeed(providerThread));
    const forkThread = vi.fn(() => Effect.succeed(providerThread));
    harness.open.mockReturnValue(
      (boundary === "session opening" ? gate : Effect.void).pipe(
        Effect.as({
          driver: providerThread.driver,
          ensureThread,
          resumeThread,
          forkThread,
        } as never),
      ),
    );
    if (boundary === "policy resolution") {
      harness.resolveRuntimePolicy.mockReturnValue(
        gate.pipe(Effect.as({ cwd: "/tmp/native-account-command" } as never)),
      );
    }

    const startup = yield* harness.start.pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(entered);
    const current = harness.projection();
    const replacementId = RunAttemptId.make("replacement-attempt");
    const updated = {
      ...current,
      runs: current.runs.map((candidate) =>
        loss === "replaced"
          ? { ...candidate, activeAttemptId: replacementId }
          : { ...candidate, status: "interrupted" as const, completedAt: current.updatedAt },
      ),
      attempts:
        loss === "replaced"
          ? [...current.attempts, { ...current.attempts[0]!, id: replacementId, attemptOrdinal: 2 }]
          : current.attempts,
    };
    harness.setProjection(updated);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(startup);

    expect(harness.open).toHaveBeenCalledTimes(boundary === "session opening" ? 1 : 0);
    expect(ensureThread).not.toHaveBeenCalled();
    expect(resumeThread).not.toHaveBeenCalled();
    expect(forkThread).not.toHaveBeenCalled();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
    expect(harness.events).toEqual([]);
    expect(harness.projection()).toEqual(updated);
  }),
);

effectIt.effect("starts another provider in the same checkout while a turn is pending", () =>
  Effect.gen(function* () {
    const worktreePath = "/tmp/provider-start-shared-checkout";
    const turnEntered = yield* Deferred.make<void>();
    const releaseTurn = yield* Deferred.make<void>();
    const first = makeLocalCommandHarness({
      text: "Continue",
      worktreePath,
      failReadsAfterRunning: true,
    });
    const second = makeLocalCommandHarness({
      text: "Continue",
      worktreePath,
      failReadsAfterRunning: true,
    });
    first.startRootRun.mockImplementation(() =>
      Deferred.succeed(turnEntered, undefined).pipe(Effect.andThen(Deferred.await(releaseTurn))),
    );
    const pending = yield* first.start.pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(turnEntered);
    yield* second.start;
    expect(second.startRootRun).toHaveBeenCalledOnce();
    expect(second.projection().runs.at(-1)?.status).toBe("running");
    yield* Deferred.succeed(releaseTurn, undefined);
    yield* Fiber.join(pending);
  }),
);

effectIt.effect("terminalizes a starting run when its provider session cannot open", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new Error("DESCRIPTION is not valid ACP JSON"),
    });

    yield* harness.start;

    expect(harness.open).toHaveBeenCalledOnce();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.writeIfRunCurrent).toHaveBeenCalledWith(
      expect.objectContaining({
        activeAttemptId: harness.attemptId,
        expectedStatus: "starting",
      }),
    );
    const projection = harness.projection();
    expect(projection.runs.at(-1)).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.attempts[0]).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.nodes[0]).toMatchObject({ status: "failed", startedAt: null });
    expect(projection.turnItems).toMatchObject([
      {
        type: "error",
        status: "failed",
        failure: {
          class: "provider_error",
          message: "DESCRIPTION is not valid ACP JSON",
        },
      },
    ]);
  }),
);

effectIt.effect("leaves the run starting when a session-open failure will be retried", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new Error("provider session rejected"),
    });

    const error = yield* harness.startWithRetry.pipe(Effect.flip);

    expect(error._tag).toBe("ProviderTurnStartError");
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
  }),
);

effectIt.effect("does not terminalize a provider-session open interruption", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Continue", interruptOpen: true });

    const exit = yield* Effect.exit(harness.start);

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("starting");
    expect(harness.events).toEqual([]);
  }),
);

effectIt.effect("does not overwrite a run interrupted while its provider session opens", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      openFailure: new Error("provider session rejected"),
      interruptRunBeforeOpenFailure: true,
    });

    yield* harness.start;

    expect(harness.writeIfRunCurrent).toHaveBeenCalledOnce();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    const projection = harness.projection();
    expect(projection.runs.at(-1)?.status).toBe("interrupted");
    expect(projection.attempts[0]?.status).toBe("pending");
    expect(projection.nodes[0]?.status).toBe("pending");
    expect(projection.turnItems).toEqual([]);
    expect(harness.events).toEqual([]);
  }),
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

effectIt.effect("does not mistake a failed state read for a superseded run", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({ text: "Continue", failReadsAfterRunning: true });

    yield* harness.start;

    expect(harness.projection().runs.at(-1)?.status).toBe("running");
    const controls = harness.startRootRun.mock.calls[0]?.[0];
    expect(controls).toBeDefined();
    if (controls === undefined) return;
    const startCheck = yield* Effect.flip(controls.shouldStartProviderTurn!());
    const finalizeCheck = yield* Effect.flip(controls.shouldFinalizeRun!());
    expect(startCheck._tag).toBe("ProjectionStoreReadError");
    expect(finalizeCheck._tag).toBe("ProjectionStoreReadError");
  }),
);

effectIt.effect(
  "signs out the existing native provider before opening the newly selected provider",
  () =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({ text: "/logout", previousNativeSession: true });

      yield* harness.start;
      yield* harness.start;

      expect(harness.tryHandlePromptCommand).toHaveBeenCalledExactlyOnceWith({
        instanceId: harness.oldInstanceId,
        text: "/logout",
        hasAttachments: false,
      });
      expect(harness.open).not.toHaveBeenCalled();
      expect(harness.startRootRun).not.toHaveBeenCalled();
      const projection = harness.projection();
      expect(projection.runs.at(-1)?.status).toBe("completed");
      expect(projection.attempts[0]?.status).toBe("completed");
      expect(projection.nodes[0]?.status).toBe("completed");
      expect(projection.turnItems).toMatchObject([
        {
          type: "command_execution",
          title: "Provider signed out",
          output: "Provider signed out",
          status: "completed",
        },
      ]);
      expect(projection.providerTurns).toEqual([]);
      expect(projection.checkpoints).toEqual([]);
    }),
);

effectIt.effect("fails a run whose workspace is gone without starting a provider", () =>
  Effect.gen(function* () {
    const harness = makeLocalCommandHarness({
      text: "Continue",
      worktreePath: "/tmp/released-slipjay-workspace",
      branch: null,
      fileSystem: FileSystem.makeNoop({ exists: () => Effect.succeed(false) }),
    });

    yield* harness.start;

    expect(harness.open).not.toHaveBeenCalled();
    expect(harness.startRootRun).not.toHaveBeenCalled();
    expect(harness.projection().runs.at(-1)?.status).toBe("failed");
    expect(harness.projection().turnItems).toMatchObject([
      {
        type: "error",
        title: "Workspace missing",
        failure: {
          class: "validation_error",
          message: "The thread's workspace /tmp/released-slipjay-workspace no longer exists.",
        },
      },
    ]);
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

const CLAUDE_INSTANCE = "claudeAgent";
const claudeCompactSettings = (
  config: {
    compactModel?: string;
    compactModelInstanceId?: string;
    compactOnlyWhenCold?: boolean;
  },
  expiresAtIso?: string,
) => ({
  settings: {
    providerInstances: {
      [CLAUDE_INSTANCE]: { driver: "claudeAgent", config },
    },
  } as never,
  usages: [
    {
      usedTokens: 150_000,
      updatedAt: "2026-09-04T10:00:00.000Z",
      ...(expiresAtIso === undefined ? {} : { promptCacheExpiresAt: expiresAtIso }),
    },
  ],
});
// The cache either expired an hour before the test clock's 2026-09-04T12:00Z or has an hour left.
const setClaudeClock = TestClock.setTime(Date.parse("2026-09-04T12:00:00Z"));
const CACHE_EXPIRED = "2026-09-04T11:00:00.000Z";
const CACHE_WARM = "2026-09-04T13:00:00.000Z";

describe("Claude compaction model", () => {
  effectIt.effect.each([
    {
      name: "cold, Haiku chosen: Haiku summarises while the run stays on the conversation's model",
      config: { compactModel: "claude-haiku-4-5" },
      expires: CACHE_EXPIRED,
      expected: "claude-haiku-4-5",
    },
    {
      name: "warm: the conversation's model summarises",
      config: { compactModel: "claude-haiku-4-5" },
      expires: CACHE_WARM,
      expected: undefined,
    },
    {
      name: "warm with the cold-only switch off: Haiku summarises",
      config: { compactModel: "claude-haiku-4-5", compactOnlyWhenCold: false },
      expires: CACHE_WARM,
      expected: "claude-haiku-4-5",
    },
    {
      name: "no model chosen: today's behaviour",
      config: {},
      expires: CACHE_EXPIRED,
      expected: undefined,
    },
    {
      name: "cache expiry unknown: the conversation's model summarises",
      config: { compactModel: "claude-haiku-4-5" },
      expires: undefined,
      expected: undefined,
    },
  ] as const)("$name", ({ config, expires, expected }) =>
    Effect.gen(function* () {
      yield* setClaudeClock;
      const harness = makeLocalCommandHarness({
        text: "/compact",
        previousMessages: ["Hello"],
        failReadsAfterRunning: true,
        claude: claudeCompactSettings(config, expires),
      });

      yield* harness.start;

      const started = harness.startRootRun.mock.calls[0]?.[0];
      // Neither the run nor the thread ever takes the summarising model.
      expect(started?.run.modelSelection.model).toBe("claude-sonnet-5-5");
      expect(started?.compaction?.modelSelection?.model).toBe(expected);
      expect(harness.events.some((event) => event.type === "thread.model-selection-updated")).toBe(
        false,
      );
    }),
  );

  effectIt.effect("uses a pool's compaction settings for a member that stores none", () =>
    Effect.gen(function* () {
      yield* setClaudeClock;
      const harness = makeLocalCommandHarness({
        text: "/compact",
        previousMessages: ["Hello"],
        failReadsAfterRunning: true,
        claude: {
          instanceId: "claude_work",
          usages: claudeCompactSettings({}, CACHE_WARM).usages,
          settings: {
            providerInstances: {
              claude_pool: {
                driver: "claudeAgent",
                pool: ["claude_work"],
                // The pool shares both the model and the cold-only switch.
                config: { compactModel: "claude-haiku-4-5", compactOnlyWhenCold: false },
              },
              claude_work: { driver: "claudeAgent", config: {} },
            },
          } as never,
        },
      });

      yield* harness.start;

      const started = harness.startRootRun.mock.calls[0]?.[0];
      expect(started?.run.providerInstanceId).toBe("claude_work");
      expect(started?.run.modelSelection.model).toBe("claude-sonnet-5-5");
      expect(started?.compaction?.modelSelection?.model).toBe("claude-haiku-4-5");
    }),
  );

  effectIt.effect("leaves a Haiku-sized window out when the thread is bigger than it", () =>
    Effect.gen(function* () {
      yield* setClaudeClock;
      const claude = claudeCompactSettings({ compactModel: "claude-haiku-4-5" }, CACHE_EXPIRED);
      const harness = makeLocalCommandHarness({
        text: "/compact",
        previousMessages: ["Hello"],
        failReadsAfterRunning: true,
        claude: { ...claude, usages: [{ ...claude.usages[0]!, usedTokens: 300_000 }] },
      });

      yield* harness.start;

      const started = harness.startRootRun.mock.calls[0]?.[0];
      expect(started?.compaction).toEqual({ windowTooSmall: true });
    }),
  );

  effectIt.effect("treats a hand-typed /compact like any other", () =>
    Effect.gen(function* () {
      yield* setClaudeClock;
      const harness = makeLocalCommandHarness({
        text: "  /COMPACT ",
        previousMessages: ["Hello"],
        failReadsAfterRunning: true,
        claude: claudeCompactSettings({ compactModel: "claude-haiku-4-5" }, CACHE_EXPIRED),
      });

      yield* harness.start;

      expect(harness.startRootRun.mock.calls[0]?.[0].compaction?.modelSelection?.model).toBe(
        "claude-haiku-4-5",
      );
    }),
  );

  effectIt.effect("ignores the setting for an ordinary message", () =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({
        text: "Continue",
        previousMessages: ["Hello"],
        failReadsAfterRunning: true,
        claude: claudeCompactSettings({ compactModel: "claude-haiku-4-5" }, CACHE_EXPIRED),
      });

      yield* harness.start;

      expect(harness.startRootRun.mock.calls[0]?.[0].compaction).toBeUndefined();
    }),
  );
});

describe("Claude compaction on another account", () => {
  const SUMMARISER_INSTANCE = ProviderInstanceId.make("pi-personal");
  const otherAccountSettings = (
    config: {
      compactModel?: string;
      compactModelInstanceId?: string;
      compactOnlyWhenCold?: boolean;
    },
    expiresAtIso?: string,
  ) => claudeCompactSettings(config, expiresAtIso);

  effectIt.effect("the other account summarises and the conversation opens a fresh session", () =>
    Effect.gen(function* () {
      yield* setClaudeClock;
      const harness = makeLocalCommandHarness({
        text: "/compact",
        previousMessages: ["Fix the login redirect"],
        nativeSession: true,
        claude: otherAccountSettings(
          {
            compactModel: "deepseek-v4.1-flash",
            compactModelInstanceId: SUMMARISER_INSTANCE,
          },
          CACHE_EXPIRED,
        ),
        summariser: {
          instanceId: SUMMARISER_INSTANCE,
          model: "deepseek-v4.1-flash",
          summary: "The user is fixing the login redirect.",
        },
      });

      yield* harness.start;

      // The thread's own provider never sees this compaction: T3 wrote the summary.
      expect(harness.open).not.toHaveBeenCalled();
      expect(harness.startRootRun).not.toHaveBeenCalled();
      expect(harness.projection().runs.at(-1)?.status).toBe("completed");
      expect(harness.projection().turnItems).toMatchObject([
        {
          type: "compaction",
          status: "completed",
          model: "deepseek-v4.1-flash",
          summary: "The user is fixing the login redirect.",
          beforeTokenCount: 150_000,
        },
      ]);
      // The summary is the next session's whole conversation, and the old session is dropped.
      const [handoff] = harness.projection().contextHandoffs;
      expect(handoff).toMatchObject({
        strategy: "full_thread_summary",
        summaryText: "The user is fixing the login redirect.",
      });
      const thread = harness
        .projection()
        .providerThreads.find((candidate) => candidate.nativeThreadRef === null);
      expect(thread).toMatchObject({ nativeThreadRef: null, contextUsage: null });
      expect(thread?.handoffIds).toEqual([handoff?.id]);
    }),
  );

  effectIt.effect("fails the compaction, keeping the conversation's session, when it errors", () =>
    Effect.gen(function* () {
      yield* setClaudeClock;
      const harness = makeLocalCommandHarness({
        text: "/compact",
        previousMessages: ["Fix the login redirect"],
        nativeSession: true,
        claude: otherAccountSettings(
          {
            compactModel: "deepseek-v4.1-flash",
            compactModelInstanceId: SUMMARISER_INSTANCE,
          },
          CACHE_EXPIRED,
        ),
        summariser: {
          instanceId: SUMMARISER_INSTANCE,
          model: "deepseek-v4.1-flash",
          failure: new Error("the summariser is offline"),
        },
      });

      yield* harness.start;

      expect(harness.startRootRun).not.toHaveBeenCalled();
      expect(harness.projection().runs.at(-1)?.status).toBe("failed");
      expect(harness.projection().turnItems).toMatchObject([
        { type: "error", title: "Compacting context with deepseek-v4.1-flash failed" },
      ]);
      expect(harness.projection().contextHandoffs).toEqual([]);
      expect(harness.projection().providerThreads[0]?.nativeThreadRef).not.toBeNull();
    }),
  );

  effectIt.effect(
    "refuses when another turn replaced the session while the summary was written",
    () =>
      Effect.gen(function* () {
        yield* setClaudeClock;
        const harness = makeLocalCommandHarness({
          text: "/compact",
          previousMessages: ["Fix the login redirect"],
          nativeSession: true,
          sessionMovedDuringSummary: true,
          claude: otherAccountSettings(
            {
              compactModel: "deepseek-v4.1-flash",
              compactModelInstanceId: SUMMARISER_INSTANCE,
            },
            CACHE_EXPIRED,
          ),
          summariser: { instanceId: SUMMARISER_INSTANCE, model: "deepseek-v4.1-flash" },
        });

        yield* harness.start;

        expect(harness.projection().runs.at(-1)?.status).toBe("failed");
        expect(harness.projection().turnItems).toMatchObject([
          { type: "error", failure: { class: "validation_error" } },
        ]);
        expect(harness.projection().contextHandoffs).toEqual([]);
      }),
  );

  effectIt.effect("refuses while the thread's own work is still running", () =>
    Effect.gen(function* () {
      yield* setClaudeClock;
      const harness = makeLocalCommandHarness({
        text: "/compact",
        previousMessages: ["Fix the login redirect"],
        nativeSession: true,
        backgroundTasks: 1,
        claude: otherAccountSettings(
          {
            compactModel: "deepseek-v4.1-flash",
            compactModelInstanceId: SUMMARISER_INSTANCE,
          },
          CACHE_EXPIRED,
        ),
        summariser: { instanceId: SUMMARISER_INSTANCE, model: "deepseek-v4.1-flash" },
      });

      yield* harness.start;

      expect(harness.projection().runs.at(-1)?.status).toBe("failed");
      expect(harness.projection().turnItems).toMatchObject([
        { type: "error", failure: { class: "validation_error" } },
      ]);
      expect(harness.projection().providerThreads[0]?.nativeThreadRef).not.toBeNull();
    }),
  );

  effectIt.effect("the conversation's own account still compacts in place while warm", () =>
    Effect.gen(function* () {
      yield* setClaudeClock;
      const harness = makeLocalCommandHarness({
        text: "/compact",
        previousMessages: ["Fix the login redirect"],
        nativeSession: true,
        failReadsAfterRunning: true,
        claude: otherAccountSettings(
          {
            compactModel: "deepseek-v4.1-flash",
            compactModelInstanceId: SUMMARISER_INSTANCE,
          },
          CACHE_WARM,
        ),
        summariser: { instanceId: SUMMARISER_INSTANCE, model: "deepseek-v4.1-flash" },
      });

      yield* harness.start;

      expect(harness.startRootRun).toHaveBeenCalledTimes(1);
      expect(harness.startRootRun.mock.calls[0]?.[0].compaction).toBeUndefined();
      expect(harness.projection().contextHandoffs).toEqual([]);
    }),
  );
});

for (const previousMessages of [[], ["/compact", " /COMPACT "]]) {
  effectIt.effect(
    `rejects compaction without conversation context after ${previousMessages.length} prior compactions`,
    () =>
      Effect.gen(function* () {
        const harness = makeLocalCommandHarness({ text: "/compact", previousMessages });

        yield* harness.start;

        expect(harness.open).not.toHaveBeenCalled();
        expect(harness.tryHandlePromptCommand).not.toHaveBeenCalled();
        expect(harness.startRootRun).not.toHaveBeenCalled();
        expect(harness.projection().runs.at(-1)?.status).toBe("failed");
        expect(harness.projection().turnItems).toMatchObject([
          {
            type: "error",
            failure: {
              class: "validation_error",
              message: "Start a conversation before compacting this thread.",
            },
          },
        ]);
      }),
  );
}
